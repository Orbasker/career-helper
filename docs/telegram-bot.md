# Telegram bot

`src/bot/` is transport only: it maps Telegram updates to calls on the application services in `src/app/services.ts` and renders the results. Postgres-backed implementations live in `src/app/postgres/`.

## Flows

| Trigger | Service call | Result |
| --- | --- | --- |
| `/start` (no profile) | `onboarding.start` | Asks for CV text, target roles, hard constraints; saves the master CV text, proposed preferences and a draft profile. |
| `/start` (has profile) | — | Welcome back + main menu. |
| `/new` or **What's new?** | `matches.latest` | Up to 5 `ready`/`notified` matches with a **Details** button. |
| **Details** | `matches.details` | Job, fit evidence, transferable skills, gaps, source link, feedback and CV buttons. |
| 👍 / 👎 | `feedback.record` | Appends feedback; 👎 dismisses the match. |
| **Tailor my CV** | `cv.requestTailored` | Creates a `requested` CV version (one open request per match). |
| Any other text | `conversation.handleText` | Answers the current onboarding question, otherwise stored as a proposed preference. |

Callback data is `job:<matchId>`, `fb:<i|n>:<matchId>`, `cv:<matchId>` (≤ 64 bytes). Only private chats are handled.

## Running locally

```bash
neon env pull          # or copy .env.example to .env.local and fill it in
bun run db:migrate
bun run bot            # long polling; Bun loads .env.local automatically
```

Local polling refuses to start if the token already has a webhook (polling would delete it), so use a separate dev bot token locally.

## Deploying on Vercel

Production runs as a webhook: Telegram POSTs updates to `api/telegram.ts`, which verifies the `X-Telegram-Bot-Api-Secret-Token` header (derived from the bot token) before handling them.

`bun run vercel-build` typechecks and, on production builds only (`VERCEL_ENV=production`, i.e. merges to `main`), applies database migrations and registers the webhook at `https://$VERCEL_PROJECT_PRODUCTION_URL/api/telegram`. Preview builds skip both because they share the production database.

Required Vercel env vars: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `TELEGRAM_BOT_TOKEN`.
