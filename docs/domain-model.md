# Domain model

Source of truth: `src/db/schema.ts` (Drizzle) and `src/domain/enums.ts`. Migrations live in `drizzle/` (`bun run db:generate`, `bun run db:migrate`).

## Entities

| Area | Tables | Notes |
| --- | --- | --- |
| Identity | `users`, `conversation_states` | One row per Telegram user; conversation state holds the active bot flow and step. |
| Career profile | `career_profiles`, `work_experiences`, `career_facts`, `profile_sources` | `revision` is bumped on every confirmed change so evaluations and CVs can cite the profile they used. `profile_sources` keeps the raw CV / LinkedIn export / pasted text that onboarding extracted from; extracted rows stay `unverified` until the user confirms the review. |
| Preferences | `preferences`, `preference_evidence` | Hard constraints, soft preferences, dislikes, target roles. Inferred preferences start as `proposed` and cannot become `active` without `decided_at`. Removed preferences become `retired`; replaced ones become `superseded`. `preference_evidence` links them to the feedback that suggested them. |
| Jobs | `job_sources`, `raw_job_records`, `jobs`, `duplicate_groups` | Every job references its source and the raw payload it was parsed from. Duplicates across sources share a `duplicate_group` with one canonical job. |
| Matching | `matches`, `match_evaluations` | One match per user and duplicate group, so the same posting is never notified twice. Each funnel stage appends an evaluation with outcome, evidence, model and prompt version. |
| Feedback | `feedback` | Append-only interested / not-interested history with optional reason tags and free-text reason. See `docs/feedback-learning.md`. |
| CV | `master_cvs`, `cv_versions`, `cv_version_items` | Facts hold verified truth; `cv_version_items.generated_text` holds tailored wording and must point at a verified fact owned by the same user (enforced by trigger). See `docs/cv-tailoring.md`. |

## Invariants enforced in the database

- A job cannot exist without a raw source record (`jobs.raw_record_id`).
- `verified_at` is set if and only if a fact or work experience is `verified`.
- A `notified` match has `notified_at`.
- Inferred preferences need an explicit user decision before becoming active.
- Tailored CV lines can only cite verified facts belonging to the CV owner.
- Only one open (`requested`/`draft`) CV version per user and match.
