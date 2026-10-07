# Domain model

Source of truth: `src/db/schema.ts` (Drizzle) and `src/domain/enums.ts`. Migrations live in `drizzle/` (`bun run db:generate`, `bun run db:migrate`).

## Entities

| Area | Tables | Notes |
| --- | --- | --- |
| Identity | `users`, `conversation_states` | One row per Telegram user; conversation state holds the active bot flow and step. `users.preferred_language` (`en` / `he`) is the default conversation language, null until the user picks one (the bot then uses English); `language_prompted_at` records the one-time prompt for users who onboarded before languages existed. |
| Career profile | `career_profiles`, `work_experiences`, `career_facts`, `source_documents`, `profile_sources` | `revision` is bumped on every confirmed change so evaluations and CVs can cite the profile they used. `source_documents` keeps every file the user uploaded: any number of CVs (e.g. Hebrew and English side by side) and LinkedIn exports, each with file name, MIME type, format, Telegram file reference, detected or user-confirmed `language`, extracted text, `parse_status` / `parse_error`, an optional `label` (the upload's caption) and a `version` numbered per user, kind and language (a second English CV is version 2). A new upload never replaces an earlier one unless the user asks to replace it. `is_default` marks the user's chosen CV for a language (at most one per user and language; only readable CVs with a language can be chosen), and `removed_at` hides a removed or replaced document while keeping it for provenance. `profile_sources` lists the inputs of the current onboarding run: a document reference or pasted text. Extracted experiences and facts stay `unverified` until the user confirms the review, and `source_document_id` records the document each one came from. |
| Preferences | `preferences`, `preference_evidence` | Hard constraints, soft preferences, dislikes, target roles. Inferred preferences start as `proposed` and cannot become `active` without `decided_at`. Removed preferences become `retired`; replaced ones become `superseded`. `preference_evidence` links them to the feedback that suggested them. |
| Jobs | `job_sources`, `raw_job_records`, `jobs`, `duplicate_groups` | Every job references its source and the raw payload it was parsed from. Duplicates across sources share a `duplicate_group` with one canonical job. |
| Matching | `matches`, `match_evaluations` | One match per user and duplicate group, so the same posting is never notified twice. Each funnel stage appends an evaluation with outcome, evidence, model and prompt version. |
| Network | `connections` | The user's LinkedIn contacts (name, profile URL, company, position), imported from their export and used only on their own matches. See `docs/connections.md`. |
| Feedback | `feedback` | Append-only interested / not-interested history with optional reason tags and free-text reason. See `docs/feedback-learning.md`. |
| CV | `cv_versions`, `cv_version_items`, `cv_version_files` | Facts hold verified truth; `cv_version_items.generated_text` holds tailored wording and must point at a verified fact owned by the same user (enforced by trigger). Each version has a `language`, why it was chosen (`language_source`), the uploaded CV it was based on and, for another language of a version, `based_on_version_id`. `cv_version_files` keeps the Telegram file of each format sent. See `docs/cv-tailoring.md`. |

## Invariants enforced in the database

- A job cannot exist without a raw source record (`jobs.raw_record_id`).
- `verified_at` is set if and only if a fact or work experience is `verified`.
- A `notified` match has `notified_at`.
- Inferred preferences need an explicit user decision before becoming active.
- Tailored CV lines can only cite verified facts belonging to the CV owner.
- Only one open (`requested`/`draft`) CV version per user, match and language.
- A source document is `parsed` if and only if it has extracted text and a kind; otherwise it has a `parse_error`.
- An onboarding source is either a document reference or pasted text, never both.
- A user has at most one chosen default CV per language, and only a readable, not removed CV with a known language can be one.
