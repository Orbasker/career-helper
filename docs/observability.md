# Observability and evaluation

Code: `src/ai/tracking.ts`, `src/observability/`, `src/eval/`, `src/cv/cv-eval.ts`. Tables: `pipeline_runs`, `model_calls`.

## Logs

Every daily run logs one JSON line per stage (`pipeline.discovery`, `pipeline.ingestion`, `pipeline.cheap_matching`, `pipeline.deep_matching`, `pipeline.notifications`) and `pipeline.run`. The ingestion stage also logs `ingest.source` and `dedup.run`. These lines appear in the Vercel function logs.

## Run audit (`pipeline_runs`)

Each daily run inserts a row when it starts and fills in `finished_at`, `failed` and the full stage `report` (JSON) when it ends. A row without `finished_at` is a run that was cut off, e.g. by the 300s function limit. Recording problems are logged (`pipeline.audit_failed`) and never stop the run.

Decisions keep their own provenance:
- every match stage writes a `match_evaluations` row (outcome, explanation, evidence, `profile_revision`, `model`, `prompt_version`);
- tailored CVs keep their items' fact ids, `profile_revision`, `model` and `prompt_version`;
- every application status change, note and linked CV appends an `application_events` row with its source (`user`, `email`, `system`) and optional evidence reference.

## Model calls (`model_calls`)

Every AI call goes through `tracked(recorder, purpose, model, call)`, which:
- tags the call in AI Gateway with `purpose:<purpose>` and `env:<VERCEL_ENV>`;
- records purpose, model, input/output tokens (summed over tool steps), duration and success or error.

A failing recorder never fails the call.

| Purpose | Call |
| --- | --- |
| `deep_match.decide` | Jev recommendation and veto checks |
| `deep_match.explain` | Explanation of a recommended match |
| `cv.tailor` | CV tailoring (twice when the first attempt is rejected) |
| `discovery.search` | Agent web search |
| `discovery.extract` | Reading a posting page without JSON-LD |
| `profile.extract` / `profile.interpret` / `profile.merge_document` | Onboarding extraction, profile edits, and documents uploaded after onboarding |

**Cost** comes from AI Gateway's spend report grouped by those tags (`gatewaySpend`), so it matches what is billed. Tokens and durations come from `model_calls`.

## Report

`buildStats(db, { days })` / `formatStats` cover the last N days:
- runs (total, failed, cut off) and the last run's stage summary;
- new jobs per source and the match funnel (must-haves → relevance → deep match → recommended → notified, plus pending);
- feedback, CVs and applications (logged, from matches, status changes);
- AI calls per purpose (calls, failures, tokens, average duration);
- AI spend per purpose.

- **Bot:** `/stats [days]` (default 7, max 90) for Telegram users listed in `ADMIN_TELEGRAM_IDS` (comma-separated). Everyone else gets the help message.
- **Terminal:** `bun run report [days]` against `DATABASE_URL`. Spend needs AI Gateway credentials (`vercel env pull` or `AI_GATEWAY_API_KEY`); without them it shows as unavailable.

## Evaluation harness

`bun run eval` runs both suites against the real models and compares the result with `eval/baseline.json`:

| Suite | Cases | A case fails when |
| --- | --- | --- |
| `matching` (`src/matching/deep-match-eval.ts`) | Senior HRBP profile: obvious HR roles, adjacent roles, clear negatives | The recommendation is outside the accepted ones, a recommended verdict has no grounded evidence, or the explanation states a numeric score |
| `cv` (`src/cv/cv-eval.ts`) | Same English profile tailored to an HRBP, People Ops, L&D and a numbers-heavy posting, and to a Hebrew HRBP posting in Hebrew | The model made an unsupported claim (a number, year or employer its facts don't state, still present after the retry), a line cites an unknown fact, a key fact is not among the bullets, the summary or application note is missing, or a summary sentence or bullet is not in the CV's language |

Options: `--decision-model`, `--explanation-model`, `--cv-model` (defaults: the production models). The output lists each case, the pass rate per suite against the baseline, any model or prompt-version changes, the cases that were fixed, and **regressions** (passed in the baseline, failing now). The script exits non-zero on any regression.

Workflow for a model or prompt change: run `bun run eval` with the new model or prompt, check for regressions, and once the change is accepted run `bun run eval --save-baseline` and commit `eval/baseline.json`.
