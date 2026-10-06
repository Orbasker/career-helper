# Matching funnel

Code: `src/matching/`. Tables: `matches`, `match_evaluations` (see `docs/domain-model.md`).

Each confirmed profile is matched against the canonical job of every duplicate group it has no match for yet. The stages are `hard_filter` → `cheap_relevance` → `deep_match`. This document covers the first two. They are deterministic, need no LLM calls and are cheap enough to run on every new job.

## Hard filters (`hard-filters.ts`)

Only **active `hard_constraint`** preferences are applied. A constraint rejects a job only when the job explicitly contradicts it. Missing job data always passes.

| Constraint value | Rejects when |
| --- | --- |
| `work_mode` | the job's work mode is known and not in the list |
| `employment_type` | the job's employment type is known and not in the list |
| `location` | the job has a location, is not remote, and none of the places match (a city, or a country covering its known cities, e.g. `Israel` → Herzliya) |
| `seniority` | the title explicitly signals a level (`junior`, `senior`, `lead`, `manager`, `director`/`head of`, `VP`/`chief`) and none of them are allowed |
| `compensation`, `terms`, `free_text` | never: jobs have no reliable field to check these against, so the deep matcher handles them |

## Cheap relevance (`relevance.ts`)

A recall-oriented score in `[0, 1]`. A job passes when it scores at least `RELEVANCE_THRESHOLD` (0.2).

- **Vocabulary overlap.** Terms from the profile's past titles, headline, industries, skills, certifications, responsibilities and achievements, plus target-role and soft-preference terms, are compared with the job's title and description. Title hits count double. Seniority words and generic job-ad words are ignored. The score saturates (`1 - e^(-weight/16)`), so a long profile is not penalized.
- **Target roles** add a boost when they appear in the title (+0.35 for a phrase, +0.15 for a shared word).
- **Satisfied nice-to-haves** add +0.05 each.
- **Disliked titles** halve the score instead of eliminating the job.

**A title that differs from past roles is never penalized.** A career-adjacent role (e.g. an HR Business Partner and a "Talent & Culture Lead") survives on description overlap with the person's responsibilities and achievements. Deciding whether the move actually makes sense is left to the deep matcher.

## Running (`run.ts`)

`runCheapMatching(db, options)` creates one `matches` row per user and duplicate group, with one `match_evaluations` row per stage that ran (outcome, score, explanation, evidence, `profile_revision`):

| Result | `status` | `stage_reached` |
| --- | --- | --- |
| Failed a must-have | `filtered_out` | `hard_filter` (evidence: `failedConstraintIds`) |
| Below relevance threshold | `filtered_out` | `cheap_relevance` (evidence: `matchedTerms`) |
| Passed both | `pending` | `cheap_relevance`, awaiting the deep matcher |

Only jobs collected in the last `maxJobAgeDays` (default 30) are considered. Re-running only evaluates groups the user has no match for yet. Matches are not re-evaluated when the profile changes.

Run it manually with `bun run match` against `DATABASE_URL`. It exits non-zero if any user failed. It is not scheduled yet: the daily pipeline (ANI-88) will run it after ingestion.
