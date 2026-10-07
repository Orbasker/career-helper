# Telegram bot

`src/bot/` is transport only: it maps Telegram updates to calls on the application services in `src/app/services.ts` and renders the results. Postgres-backed implementations live in `src/app/postgres/`.

## Flows

| Trigger | Service call | Result |
| --- | --- | --- |
| `/start` (no confirmed profile) | `onboarding.start` | Clears any unconfirmed draft and starts profile onboarding (below), asking for the language first if none is stored. |
| `/start` (confirmed profile) | — | Welcome back + main menu. |
| `/profile` or **👤 My profile** | `conversation.showProfile` | Current confirmed profile: roles, facts, skills, preferences. |
| `/new` or **What's new?** | `matches.whatsNew` | Up to 5 matches with a **Details** button: undelivered `ready` matches first (best recommendation first), then recent `notified` ones. The `ready` matches shown become `notified`, so the daily digest does not repeat them. |
| **Details** | `matches.details` | Job, fit evidence, transferable skills, gaps, source link, feedback, CV and **🔗 Original posting** buttons. |
| 👍 / 👎 | `feedback.record` | Appends feedback (repeating the latest verdict is a no-op). 👎 dismisses the match and asks what put the user off; 👍 after 👎 restores it. See `docs/feedback-learning.md`. |
| Reason button | `feedback.addReasonTag` / `feedback.awaitReasonText` | Adds a reason tag, or waits up to 10 minutes for a typed reason. |
| **Yes** / **No** on a proposal | `feedback.decideProposal` | Activates or rejects a preference learned from feedback. |
| **Tailor my CV** | `cv.requestTailored`, `cv.tailor` | Creates a CV version for the match and sends the tailored draft for review (see `docs/cv-tailoring.md`). |
| **Approve** / **Discard** on a CV draft | `cv.decide` | Moves the draft to `approved` or `rejected`. |
| `/language` (or `/settings`), "switch to Hebrew", "תדבר איתי באנגלית", "change language" | `conversation.setLanguage` | Shows the current language with English / עברית buttons (`lang:<en\|he>`) or saves the requested one. Never touches onboarding state, the profile, matches, feedback or CVs. |
| `/sites`, `/addsite <site>`, "search on <site>" | `sites.list` / `sites.add` / `sites.remove` | The user's own job sites for the agent to search (see `docs/discovery.md`). |
| A link to a job posting (confirmed profile) | `jobLinks.analyze`, `matches.details` | Reads the posting, matches it right away and replies with the match details and next actions (see `docs/job-links.md`). |
| `/connections`, a `.csv`/`.zip` document, "delete my connections" | `connections.summary` / `connections.import` / `connections.forget` | LinkedIn connections shown on matches (see `docs/connections.md`). |
| Document | `onboarding.addDocument` | During onboarding: stores the CV / LinkedIn PDF text as a `profile_source`. |
| Any other text | `conversation.handleText` | Onboarding answer, review correction, or a natural-language profile edit. |

### Onboarding

`conversation_states.step` walks through:

0. `language` — English or Hebrew, by button or typed answer. Skipped when `users.preferred_language` is already set (e.g. when restarting onboarding), so the choice is asked only once.
1. `linkedin` — LinkedIn URL (or *skip*). LinkedIn can't be fetched directly, so the bot asks for the profile's **Save to PDF** export instead.
2. `documents` — CV / LinkedIn PDF (PDF, DOCX, TXT) or pasted text, repeatable. **Analyze** (`ob:analyze`) starts extraction.
3. `analyzing` — `ProfileAssistant.extract` turns all sources into unverified `work_experiences` / `career_facts` and `proposed` preferences, plus up to 4 follow-up questions for missing high-value info.
4. `questions` — each answer is interpreted into draft changes; *skip* moves on.
5. `review` — the full draft is shown; free-text corrections update the draft. **Confirm profile** (`ob:confirm`) verifies all facts, activates preferences and marks the profile `confirmed`.

### Conversation language

The default language lives on `users.preferred_language` and is loaded with every update. Users who confirmed their profile before languages existed are asked once, after the reply to their next message (`users.language_prompted_at` makes the prompt one-time). Localizing the replies themselves is ANI-95.

### Continuous editing

Once confirmed, any free text is interpreted against the current profile (`ProfileAssistant.interpret`). Proposed changes are shown as a diff with **Apply** / **Cancel** (`pe:a:<token>` / `pe:c:<token>`) and stored in `conversation_states` (`flow = profile_edit`) until the user decides; nothing becomes durable before **Apply**. Applying bumps `career_profiles.revision`. Corrected facts are rejected and replaced (never edited in place), removed preferences become `retired`, and replacements are linked through `supersedes_id`.

The LLM only sees per-request aliases (`e1`, `f2`, `p3`) for the user's own items, and every write is scoped by `user_id`, so an edit can never touch another user's data.

### LLM

`src/ai/profile-assistant.ts` calls `anthropic/claude-sonnet-5.5` through Vercel AI Gateway (AI SDK structured output). On Vercel it authenticates with OIDC automatically; locally run `vercel env pull` (for `VERCEL_OIDC_TOKEN`) or set `AI_GATEWAY_API_KEY`. Tests use a fake assistant.

Callback data is `job:<matchId>`, `fb:<i|n>:<matchId>`, `cv:<matchId>`, `ob:analyze`, `ob:confirm`, `pe:<a|c>:<token>`, `fr:<r|s|l|w|c|p|o>:<feedbackId>`, `pp:<a|r>:<preferenceId>`, `cvd:<a|x>:<versionId>`, `cvf:<versionId>`, `lang:<en|he>`, `st:x:<siteId>`, `cn:delete` (≤ 64 bytes). Only private chats are handled.

## Running locally

```bash
neon env pull          # or copy .env.example to .env.local and fill it in
bun run db:migrate
bun run bot            # long polling; Bun loads .env.local automatically
```

Local polling refuses to start if the token already has a webhook (polling would delete it), so use a separate dev bot token locally.

## Deploying on Vercel

Production runs as a webhook: Telegram POSTs updates to `api/telegram.ts`, which verifies the `X-Telegram-Bot-Api-Secret-Token` header (derived from the bot token), acknowledges immediately and handles the update in the background with `waitUntil`, so slow LLM calls never hit Telegram's webhook timeout.

`bun run vercel-build` typechecks and, on production builds only (`VERCEL_ENV=production`, i.e. merges to `main`), applies database migrations and registers the webhook at `https://$VERCEL_PROJECT_PRODUCTION_URL/api/telegram`. Preview builds skip both because they share the production database.

Required Vercel env vars: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `TELEGRAM_BOT_TOKEN`, `CRON_SECRET` (daily pipeline, see `docs/pipeline.md`).
