# Telegram bot

`src/bot/` is transport only: it maps Telegram updates to calls on the application services in `src/app/services.ts` and renders the results. Postgres-backed implementations live in `src/app/postgres/`.

## Flows

| Trigger | Service call | Result |
| --- | --- | --- |
| `/start` (no confirmed profile) | `onboarding.start` | Clears any unconfirmed draft and starts profile onboarding (below), asking for the language first if none is stored. |
| `/start` (confirmed profile) | — | Welcome back + main menu. |
| `/profile` or **👤 My profile** | `conversation.showProfile` | Current confirmed profile: roles, facts, skills, preferences. |
| `/new` or **What's new?** | `matches.whatsNew` | Up to 5 matches with a **Details** button: undelivered `ready` matches first (best recommendation first), then recent `notified` ones. The `ready` matches shown become `notified`, so the daily digest does not repeat them. |
| **Details** | `matches.details` | Job, fit evidence, transferable skills, gaps, where it was found (source type, first seen, other URLs of the same job), feedback, CV and **🔗 Original posting** buttons. |
| 👍 / 👎 | `feedback.record` | Appends feedback (repeating the latest verdict is a no-op). 👎 dismisses the match and asks what put the user off; 👍 after 👎 restores it. See `docs/feedback-learning.md`. |
| Reason button | `feedback.addReasonTag` / `feedback.awaitReasonText` | Adds a reason tag, or waits up to 10 minutes for a typed reason. |
| **Yes** / **No** on a proposal | `feedback.decideProposal` | Activates or rejects a preference learned from feedback. |
| **Tailor my CV** | `cv.requestTailored`, `cv.tailor` | Creates a CV version for the match and sends the tailored draft for review (see `docs/cv-tailoring.md`). |
| **Approve** / **Discard** on a CV draft | `cv.decide` | Moves the draft to `approved` or `rejected`; an approved CV is sent as a Word document. |
| **🌐 Hebrew / English version** on a CV draft or document | `cv.requestLanguage`, `cv.tailor` | Sends the approved CV in that language when there is one, otherwise tailors one that keeps the same facts. |
| **📕 PDF** / **📝 Word** on a CV document | `cv.document` | Sends the same approved CV in the other format. |
| `/language` (or `/settings`), "switch to Hebrew", "תדבר איתי באנגלית", "change language" | `conversation.setLanguage` | Shows the current language with English / עברית buttons (`lang:<en\|he>`) or saves the requested one. Never touches onboarding state, the profile, matches, feedback or CVs. |
| `/sources`, "where are you searching?", "which sites do you check?", "איפה אתה מחפש?" | `sources.overview` | Where the agent searches: company boards (per ATS), web search and the user's own sites, each with when it last ran and the jobs and new companies it found in the last 7 days, plus problems from the latest run. **Show boards** (`src:boards`) lists every board; **Manage my sites** (`src:sites`) opens `/sites`. See `docs/discovery.md`. |
| `/sites`, `/addsite <site>`, "search on <site>" | `sites.list` / `sites.add` / `sites.remove` | The user's own job sites for the agent to search (see `docs/discovery.md`). |
| A link to a job posting (confirmed profile) | `jobLinks.analyze`, `matches.details` | Reads the posting, matches it right away and replies with the match details and next actions (see `docs/job-links.md`). |
| `/connections`, a `.csv`/`.zip` document, "delete my connections" | `connections.summary` / `connections.import` / `connections.forget` | LinkedIn connections shown on matches (see `docs/connections.md`). |
| Document | `conversation.addDocument` | Stores the file as a new `source_document` (the caption becomes its label); earlier documents are kept. During onboarding it joins the run's `profile_sources`. Once the profile is confirmed, `ProfileAssistant.mergeDocument` compares it with the profile and its additions are proposed as an edit with **Apply** / **Cancel**, attributed to the document. Legacy `.doc` files are rejected with instructions to save as DOCX or PDF. |
| Language button on an upload | `onboarding.setDocumentLanguage` | Corrects or confirms the detected language of a document (`dl:<he\|en>:<documentId>`). When the language is unclear (mixed Hebrew and English text) the reply asks which one it is and offers both. |
| `/cvs`, "show my CVs", "קורות החיים שלי" | `documents.list` | CV management (below). |
| "use my English CV by default", "השתמש בקורות החיים באנגלית כברירת מחדל" | `documents.requestDefault` | Makes the only CV in that language the default, or lists that language's CVs to pick one (`doc:d:<documentId>`). |
| Any other text | `conversation.handleText` | Onboarding answer, review correction, or a natural-language profile edit. |

### Onboarding

`conversation_states.step` walks through:

0. `language` — English or Hebrew, by button or typed answer. Skipped when `users.preferred_language` is already set (e.g. when restarting onboarding), so the choice is asked only once.
1. `linkedin` — LinkedIn URL (or *skip*). LinkedIn can't be fetched directly, so the bot asks for the profile's **Save to PDF** export instead.
2. `documents` — CVs / LinkedIn PDF (PDF, DOCX, TXT) or pasted text, repeatable. Each CV is kept separately with its detected language (Hebrew or English), which the user can correct. **Analyze** (`ob:analyze`) starts extraction.
3. `analyzing` — `ProfileAssistant.extract` merges all sources (including the same career described in several languages) into unverified `work_experiences` / `career_facts` and `proposed` preferences, plus up to 4 follow-up questions for missing high-value info.
4. `questions` — each answer is interpreted into draft changes; *skip* moves on.
5. `review` — the full draft is shown; free-text corrections update the draft. **Confirm profile** (`ob:confirm`) verifies all facts, activates preferences and marks the profile `confirmed`.

### Conversation language

The default language lives on `users.preferred_language` and is loaded with every update. Users who confirmed their profile before languages existed are asked once, after the reply to their next message (`users.language_prompted_at` makes the prompt one-time).

All user-facing copy lives in `src/i18n/`: `en.ts` defines the catalog and its `Strings` type, `he.ts` must implement every key, and `strings(language)` returns the catalog for a user (English until they choose). Views in `src/bot/views.ts` take the catalog as their first argument, so handlers hold no copy and no per-language logic; the bot puts it on `ctx.t`. Adding a language means adding it to `CONVERSATION_LANGUAGES`, `LANGUAGE_NAMES` and a catalog file.

- **Switching** takes effect on the reply that confirms it: the bot swaps `ctx.t`, re-sends the main menu with the new labels and sets the chat's command list (`setMyCommands` with a chat scope). Menu buttons in any language keep working.
- **Commands** are registered in English by default and in Hebrew for Telegram clients set to Hebrew (`registerCommands`).
- **Right-to-left**: Hebrew paragraphs must start with a Hebrew character or a right-to-left mark (`RLM` in `he.ts`), and `/commands` inside Hebrew text are preceded by a left-to-right mark so the slash stays attached. `test/localization.test.ts` enforces both.
- **Typed answers** such as *skip* / *דלג*, *done* / *סיימתי*, "delete my connections" / "תמחק את אנשי הקשר" and "search on <site>" / "תחפש גם ב-<site>" are understood in both languages.
- **Models** get the language too: `ProfileAssistant` writes follow-up questions and replies in it (profile text itself stays in English), the deep matcher writes explanations and evidence in it, and feedback learning words proposals in it. Job postings, company names and tailored CVs (which follow the language of the user's facts) are not translated. Explanations are written when a match is evaluated, so switching language does not rewrite existing ones.
- `/stats` is an operator report and stays in English.

### CV management

Once the profile is confirmed, `/cvs` lists every uploaded document, newest first: its name (the label, otherwise the file name), kind, language (marked *detected* until the user confirms it), file type, version and upload date. The CV used for each language is marked ⭐: the one the user chose, otherwise the newest readable CV in that language. Files that could not be read stay in the list with the reason (old `.doc`, unsupported type, no text). Tapping a document (`doc:<documentId>`) shows its details, how many confirmed profile facts came from it, and these actions:

- **Make default for <language>** (`doc:d:`) — sets `source_documents.is_default`, at most one per user and language. Tailoring uses the default CV in the job's language (see `docs/cv-tailoring.md`).
- **🌐 It's <language>** — corrects the language (`dl:`); a document moved to another language stops being that language's chosen default.
- **Rename** (`doc:l:`) — the next text message within 10 minutes becomes the label (`conversation_states.flow = cv_library`, `step = label`).
- **Replace** (`doc:r:`) — the next uploaded file within 10 minutes replaces the document (`step = replace`). The new file is stored as usual, inherits the old label and, in the same language, its default status; the old one is removed. Its additions are proposed as an edit like any other upload.
- **Remove** (`doc:x:`, confirmed with `doc:y:`) — sets `removed_at`: the document leaves the list and is never used for tailoring, but is kept so facts can still cite it.

Removing or replacing a document never changes the profile: confirmed experiences and facts, from that document or any other source, stay until the user removes them in their own words. **Add a CV** (`doc:add`) explains how to upload; any file sent after onboarding is added to the list.

### Continuous editing

Once confirmed, any free text is interpreted against the current profile (`ProfileAssistant.interpret`). Proposed changes are shown as a diff with **Apply** / **Cancel** (`pe:a:<token>` / `pe:c:<token>`) and stored in `conversation_states` (`flow = profile_edit`) until the user decides; nothing becomes durable before **Apply**. Applying bumps `career_profiles.revision`. Corrected facts are rejected and replaced (never edited in place), removed preferences become `retired`, and replacements are linked through `supersedes_id`.

The LLM only sees per-request aliases (`e1`, `f2`, `p3`) for the user's own items, and every write is scoped by `user_id`, so an edit can never touch another user's data.

### LLM

`src/ai/profile-assistant.ts` calls `anthropic/claude-sonnet-5.5` through Vercel AI Gateway (AI SDK structured output). On Vercel it authenticates with OIDC automatically; locally run `vercel env pull` (for `VERCEL_OIDC_TOKEN`) or set `AI_GATEWAY_API_KEY`. Tests use a fake assistant.

Callback data is `job:<matchId>`, `fb:<i|n>:<matchId>`, `cv:<matchId>`, `ob:analyze`, `ob:confirm`, `pe:<a|c>:<token>`, `fr:<r|s|l|w|c|p|o>:<feedbackId>`, `pp:<a|r>:<preferenceId>`, `cvd:<a|x>:<versionId>`, `cvf:<d|p>:<versionId>` (a bare `cvf:<versionId>` from older messages means Word), `cvl:<en|he>:<versionId>`, `lang:<en|he>`, `st:x:<siteId>`, `src:<boards|sites>`, `cn:delete`, `doc:<list|add>`, `doc:<documentId>`, `doc:<d|l|r|x|y>:<documentId>` (≤ 64 bytes). Only private chats are handled.

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
