# Daily pipeline

Code: `src/pipeline/`. Entry points: `api/cron/daily.ts` (Vercel Cron) and `bun run daily` (manual).

`runDailyPipeline(db, { adapters, searchSources, matcher, notifier })` runs these stages in order:

| Stage | Code | Notes |
| --- | --- | --- |
| Discover | `runDiscovery` (`docs/discovery.md`) | Agent web search and user sites; new postings are ingested as `web_search`, links to ATS boards become basic boards. Nothing new starts after 90s. |
| Search job sites | `runSiteSearch` (`docs/discovery.md`) | Runs alongside discovery with the same 90s cutoff: LinkedIn, AllJobs, Drushim and JobMaster are searched with every profile's roles (up to 12 distinct queries). A blocked site is reported but doesn't fail the run. |
| Collect, normalize, deduplicate | `runIngestion` (`docs/job-ingestion.md`) | A failing source is reported; the other sources still run. |
| Hard filter, cheap relevance | `runCheapMatching` (`docs/matching.md`) | Only groups the user has no match for yet. |
| Deep match | `runDeepMatching` | Up to 50 matches. No new evaluation starts more than 3.5 minutes after the run began, so notifications still go out within Vercel's 300s function timeout even after a long ingestion. |
| Notify | `runNotifications` (`notify.ts`) | One Telegram digest per user. |

The stages write their results to the database as they go (`jobs`, `matches`, `match_evaluations`).

## Failure isolation and retries

- Each stage runs even if an earlier one threw, so work left over from earlier runs still moves forward. A stage that throws is reported as `{ ok: false, error }`.
- Within a stage, one source, user or match failing never stops the others.
- A failed deep-match evaluation stays `pending` and is retried on the next run. Matches that didn't fit in the limit or time budget also wait for the next run.
- Telegram sends are retried up to 3 times on rate limits (using `retry_after`), 5xx errors and network errors. Other errors are not retried.
- The run is `failed` when any stage threw or reported errors. The manual script then exits non-zero.

Each stage logs one JSON line (`event: "pipeline.<stage>"`), and the run ends with `event: "pipeline.run"`. The cron endpoint returns the full report, and every run is stored in `pipeline_runs` (see `docs/observability.md`).

## Idempotency and no repeated notifications

Every stage can be re-run safely:

- Ingestion skips unchanged raw records.
- Cheap matching inserts one `matches` row per user and duplicate group (unique index).
- Deep matching only updates matches that are still `pending`.
- Notification claims matches before sending them. One conditional update moves them from `ready` to `notified` and sets `notified_at`. A concurrent or repeated run can't claim the same match twice. If the send fails, the claimed matches go back to `ready` and are retried on the next run.

Because matches are per duplicate group, the same posting from several sources is notified once.

## Notifications

A match is pushed when it is `ready`, has never been notified, its recommendation and confidence meet the threshold, the user's profile is `confirmed`, `users.notifications_enabled` is true and the user has not applied to the job (see `docs/applications.md`).

| Env var | Values | Default |
| --- | --- | --- |
| `NOTIFY_MIN_RECOMMENDATION` | `strong_fit`, `good_fit`, `stretch` | `good_fit` |
| `NOTIFY_MIN_CONFIDENCE` | `low`, `medium`, `high` | `low` |

Each user gets at most one digest per run. It lists up to 5 matches, best recommendation first and then by relevance, each with a **Details** button. If more matches qualify, the digest ends with "+N more — tap What's new?", and the rest are kept for the next digest. Matches below the threshold stay `ready` and still show up under **What's new?**.

**What's new?** (`/new`) shows undelivered matches first and marks them `notified`, so a match the user already saw is never pushed again.

If Telegram reports that the chat can't be reached (403, e.g. the bot was blocked), the claimed matches are released and `notifications_enabled` is turned off. It turns back on the next time the user messages the bot.

## Searches users start

`/search` runs the same stages for one user right away (`runUserSearch`, `src/pipeline/user-search.ts`), within one webhook invocation:

1. Job sites and the user's web search in parallel, nothing new after 100s.
2. Deduplication, then cheap matching for that user.
3. Up to 15 deep matches, nothing new after 200s.
4. The best qualifying matches (up to 8) are claimed like a digest and sent in the chat instead of waiting for the next morning.

Each user can start 2 searches in any 24 hours, one at a time (`job_searches`, `PgSearchService`). A search that throws is stored as `failed` and doesn't count; one still `running` after 10 minutes is treated as dead.

## Scheduling

Vercel Cron calls `GET /api/cron/daily` at 05:00 UTC (`vercel.json`). The handler requires `Authorization: Bearer $CRON_SECRET`; Vercel sends this automatically when `CRON_SECRET` is set.

Required Vercel env vars: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN` and `CRON_SECRET`. AI Gateway authenticates with OIDC.
