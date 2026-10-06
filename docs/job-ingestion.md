# Job ingestion

Code: `src/ingestion/`. Tables: `job_sources`, `raw_job_records`, `jobs` (see `docs/domain-model.md`).

## Canonical job

`CanonicalJob` (`canonical-job.ts`) is the contract every source is normalized into:

| Field | Notes |
| --- | --- |
| `source` | `job_sources.key` of the adapter that produced it |
| `externalId` | Source-native ID, `null` when the source has none |
| `sourceUrl` | http(s) URL of the posting |
| `title`, `description` | Required, trimmed |
| `company`, `location` | Optional, trimmed |
| `workMode`, `employmentType` | Domain enums or `null` |
| `publishedAt` | When the source says it was posted |
| `collectedAt` | When we first collected it; not changed by later updates |
| `rawRef` | `{ source, contentHash }` of the raw record it was parsed from |

`validateCanonicalJob` returns every contract violation at once instead of throwing.

## Writing an adapter

Implement `JobSourceAdapter` (`adapter.ts`):

- `source` — key, name, kind and base URL. The key is the stable identity in `job_sources`.
- `collect(ctx)` — yield `RawJob`s (`externalId`, `sourceUrl`, untouched `payload`). Use `ctx.fetch`, `ctx.since` (last successful run) and `ctx.config` (`job_sources.config`) so tests can inject them. Call `ctx.reportError(scope, error)` for a partial failure (e.g. one board) and keep going; throwing fails the whole run for that source.
- `normalize(raw)` — pure mapping from one raw payload to job fields; return `null` to skip non-postings.

Adapters never touch the database. Test `normalize` directly or through `toCanonicalJob`, and `collect` with a stubbed `fetch`.

## Running ingestion

`ingestFromSource(db, adapter)` registers the source, streams `collect`, and for each record:

1. Stores the raw payload, deduplicated by `(source, contentHash)`; the hash is order-insensitive over `externalId`, `sourceUrl` and `payload`.
2. Normalizes and validates it.
3. Upserts the job by `(source, externalId)`, or `(source, sourceUrl)` when there is no external ID, along with its normalized title, company and location. Rows whose raw record is unchanged are left untouched. If an update changes the normalized fields, the job leaves its duplicate group so it is regrouped (unless it was grouped `manual`ly).

Re-running with the same input is a no-op. Invalid, skipped and failing records are reported and do not stop the run. Collection errors (`report.errors`) keep what was already stored but leave `last_collected_at` unchanged. Disabled sources are not collected.

## Normalization and deduplication

`normalize.ts` holds the pure normalizers; `dedup.ts` groups jobs.

| Field | Normalization | Example |
| --- | --- | --- |
| Title | lowercase, accents and punctuation stripped, gender tags and `- Remote`/`(Remote …)` suffixes dropped, common abbreviations expanded (`sr`, `jr`, `mgr`, `hr`, `vp`, …) | `Sr. HR Manager (m/f/d)` → `senior human resources manager` |
| Company | same text cleanup, trailing legal suffixes dropped (`inc`, `ltd`, `gmbh`, …) | `Acme, Inc.` → `acme` |
| Location | primary place only (before `,` `;` `/` `\|`), with a few aliases | `Tel Aviv-Yafo, Israel` → `tel aviv` |

`deduplicateJobs(db)` assigns every job without a `duplicate_group_id` to a group, oldest first:

1. **Deterministic key** — an already-grouped job with the same normalized title, company and location (`dedup_method = deterministic_key`).
2. **Similarity fallback** — an already-grouped job at the same normalized company whose location is equal or unknown on either side, with title word Jaccard ≥ 0.5 **and** description 3-word-shingle Jaccard ≥ 0.6 (`dedup_method = similarity`).
3. Otherwise a new group keyed `title|company|location`, or `job:{id}` when the company is unknown so company-less postings never merge.

Each job keeps its own row and `source_url`, so a group holds every source's URL (`listGroupSources`). The group's `canonical_job_id` is the most complete member (company, location, work mode, employment type, published date), then the longest description, then the earliest collected. It is re-selected whenever members join or leave.

## Sources

All three are official, unauthenticated job-board APIs that ATS vendors publish for embedding a company's open roles; we fetch each configured board once per run (no scraping, no per-posting requests).

| Key | API | Company / work mode / employment type |
| --- | --- | --- |
| `greenhouse` | `GET boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true` | `company_name`; work mode inferred from location; no employment type |
| `lever` | `GET api.lever.co/v0/postings/{board}?mode=json` | config only; `workplaceType`; `categories.commitment` |
| `ashby` | `GET api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true` | config only; `workplaceType` / `isRemote`; `employmentType`. Unlisted postings are skipped |

Boards are configured per source in `job_sources.config`; a source with no boards collects nothing:

```sql
update job_sources set config = '{"boards": ["anthropic", {"token": "acme", "company": "Acme Robotics"}]}'
where key = 'greenhouse';
```

`externalId` is `{board}:{postingId}` and the raw payload is `{ board, company, posting }` with `posting` exactly as returned. A failing board is reported as `board:{token}` and the other boards still run. Parser fixtures live in `test/fixtures/sources/`.

## Scheduling and running

`runIngestion(db, adapters)` (`run.ts`) ingests each source in turn; any error in one source is caught, reported and never stops the others. It then runs `deduplicateJobs`. It logs one JSON line per source (`event: "ingest.source"`: counts, `durationMs`, invalid/failed records, errors), one for deduplication (`event: "dedup.run"`: processed, joined by key / similarity, new groups, canonical changes, error) and a run summary (`event: "ingest.run"`).

- **Scheduled** — Vercel Cron calls `GET /api/cron/ingest` daily at 05:00 UTC (`vercel.json`). The handler requires `Authorization: Bearer $CRON_SECRET`, which Vercel sends automatically when `CRON_SECRET` is set, and returns per-source and dedup metrics.
- **Manual** — `bun run ingest [source...]` runs all sources or the given keys against `DATABASE_URL` and exits non-zero if any source or deduplication had errors.

Required Vercel env var: `CRON_SECRET` (in addition to the bot's).
