# Daily pipeline

Code: `src/pipeline/`. Entry points: `api/cron/daily.ts` (Vercel Cron) and `bun run daily` (manual).

`runDailyPipeline(db, { adapters, matcher, notifier })` runs these stages in order:

| Stage | Code | Notes |
| --- | --- | --- |
| Discover | `runDiscovery` (`docs/discovery.md`) | Agent web search and user sites; new postings are ingested as `web_search`, links to ATS boards become basic boards. Nothing new starts after 90s. |
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

Each stage logs one JSON line (`event: "pipeline.<stage>"`), and the run ends with `event: "pipeline.run"`. The cron endpoint returns the full report.

## Idempotency and no repeated notifications

Every stage can be re-run safely:

- Ingestion skips unchanged raw records.
- Cheap matching inserts one `matches` row per user and duplicate group (unique index).
- Deep matching only updates matches that are still `pending`.
- Notification claims matches before sending them. One conditional update moves them from `ready` to `notified` and sets `notified_at`. A concurrent or repeated run can't claim the same match twice. If the send fails, the claimed matches go back to `ready` and are retried on the next run.

Because matches are per duplicate group, the same posting from several sources is notified once.

## Notifications

A match is pushed when it is `ready`, has never been notified, its recommendation and confidence meet the threshold, the user's profile is `confirmed` and `users.notifications_enabled` is true.

| Env var | Values | Default |
| --- | --- | --- |
| `NOTIFY_MIN_RECOMMENDATION` | `strong_fit`, `good_fit`, `stretch` | `good_fit` |
| `NOTIFY_MIN_CONFIDENCE` | `low`, `medium`, `high` | `low` |

Each user gets at most one digest per run. It lists up to 5 matches, best recommendation first and then by relevance, each with a **Details** button. If more matches qualify, the digest ends with "+N more — tap What's new?", and the rest are kept for the next digest. Matches below the threshold stay `ready` and still show up under **What's new?**.

**What's new?** (`/new`) shows undelivered matches first and marks them `notified`, so a match the user already saw is never pushed again.

If Telegram reports that the chat can't be reached (403, e.g. the bot was blocked), the claimed matches are released and `notifications_enabled` is turned off. It turns back on the next time the user messages the bot.

## Scheduling

Vercel Cron calls `GET /api/cron/daily` at 05:00 UTC (`vercel.json`). The handler requires `Authorization: Bearer $CRON_SECRET`; Vercel sends this automatically when `CRON_SECRET` is set.

Required Vercel env vars: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN` and `CRON_SECRET`. AI Gateway authenticates with OIDC.
