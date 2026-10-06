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
- `collect(ctx)` — yield `RawJob`s (`externalId`, `sourceUrl`, untouched `payload`). Use `ctx.fetch`, `ctx.since` (last successful run) and `ctx.config` (`job_sources.config`) so tests can inject them.
- `normalize(raw)` — pure mapping from one raw payload to job fields; return `null` to skip non-postings.

Adapters never touch the database. Test `normalize` directly or through `toCanonicalJob`, and `collect` with a stubbed `fetch`.

## Running ingestion

`ingestFromSource(db, adapter)` registers the source, streams `collect`, and for each record:

1. Stores the raw payload, deduplicated by `(source, contentHash)`; the hash is order-insensitive over `externalId`, `sourceUrl` and `payload`.
2. Normalizes and validates it.
3. Upserts the job by `(source, externalId)`, or `(source, sourceUrl)` when there is no external ID. Rows whose raw record is unchanged are left untouched.

Re-running with the same input is a no-op. Invalid, skipped and failing records are reported and do not stop the run. Disabled sources are not collected. Cross-source deduplication and normalized fields are handled separately (ANI-84).
