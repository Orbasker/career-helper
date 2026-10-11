# Mini App

A Telegram Mini App for browsing every job found for the user in bulk, including the ones held back and why. It opens inside Telegram from `/browse`, the **📋 Browse all jobs** button, or the chat menu button.

## Pieces

| Part | Where | What it does |
| --- | --- | --- |
| UI | `web/` (Preact) | Built by `scripts/build-web.ts` into `public/app/`, which Vercel serves at `/app/`. Follows the Telegram theme and switches to right-to-left for Hebrew. |
| API | `api/app.ts` → `src/miniapp/handler.ts` | `GET /api/app` lists the jobs (gzipped), `GET /api/app?match=<id>` returns one job's details, `POST /api/app` with `{ matchId, action }` applies `interested`, `not_interested` or `applied`. |
| Auth | `src/miniapp/auth.ts` | Every request carries Telegram's signed launch data in `X-Telegram-Init-Data`; it is checked against the bot token and must be under 24 hours old. |
| Data | `src/app/postgres/explore.ts` | Every match of the user with its tab and hold-back reason. |

## Tabs

| Tab | Matches | Reason shown |
| --- | --- | --- |
| Matches | `ready`, `notified` | Recommendation. |
| Close calls | `filtered_out` at `deep_match` or `cheap_relevance` | The dislike or must-have the deep matcher vetoed on, "outside your path", "not a strong fit", or "looks unrelated". |
| Blocked by my rules | `filtered_out` at `hard_filter` | The must-have labels the job failed. Cheap matching scores these too, so the closest come first. |
| Still checking | `pending` | — |
| Not for me | `dismissed` | — |

**👍 Add to my matches** records `interested` feedback; on a held-back or pending job it also moves the match to `notified`, so it appears with the user's matches.

## URL

The bot uses `MINI_APP_URL`, or `https://$VERCEL_PROJECT_PRODUCTION_URL/app/`. The production build also points the chat menu button at it.
