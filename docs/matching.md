# Matching funnel

Code: `src/matching/`. Tables: `matches`, `match_evaluations` (see `docs/domain-model.md`).

Each confirmed profile is matched against the canonical job of every duplicate group it has no match for yet. The stages are `hard_filter` → `cheap_relevance` → `deep_match`. The first two are deterministic, need no LLM calls and are cheap enough to run on every new job. The deep matcher makes one LLM call per surviving match.

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

Run it manually with `bun run match` against `DATABASE_URL`. It exits non-zero if any user failed. The daily pipeline (`docs/pipeline.md`) runs it after ingestion.

## Deep match (`deep-match.ts`, `src/ai/deep-matcher.ts`)

Two models run, both through AI Gateway (on Vercel it authenticates with OIDC; locally run `vercel env pull` or set `AI_GATEWAY_API_KEY`):

1. **Jev decides** (`typesafe-ai/jev`, through `experimental_decide`). It gets a single state holding the profile's **verified** experiences and facts and the job posting. Unverified and rejected facts are never shown. It answers:
   - `recommendation`: a Choice of `strong_fit` / `good_fit` / `stretch` / `not_recommended`, each defined in plain language;
   - one boolean per active must-have: does the job clearly break it? This covers what the cheap stages can't check, such as compensation and free-text must-haves;
   - one boolean per active dislike: is this mainly that kind of work?
   - `outsidePath`, asked only when the user is not open to adjacent roles: is the job outside both their target roles and their past roles?

   Any check at or above a probability of 0.5 overrides the recommendation to `not_recommended`. The strongest check sets the user-facing explanation, and every check that fired is listed in `risks`. Confidence comes from the probability of the deciding answer: high at ≥ 0.8, medium at ≥ 0.6, otherwise low. Low is also used when no probability is returned.
2. **A language model explains** (`anthropic/claude-sonnet-5.5`). It runs only for recommended jobs, so rejected jobs cost a single Jev call. It is given the decided recommendation and must not change it. It writes the fit evidence (each claim cites fact and experience ids, plus an optional verbatim job excerpt), gaps, risks, transferable skills, adjacency reasoning and a one- or two-sentence explanation for the user.

| Field | Stored in |
| --- | --- |
| Recommendation | `recommendation` |
| Confidence (`low` / `medium` / `high`) | `confidence` |
| Explanation for the user | `explanation` |
| Fit evidence, gaps, risks, transferable skills, adjacency reasoning | `evidence` |

There is deliberately no numeric score: `score` stays null, and the prompt forbids percentages.

**Grounding.** The language model only sees aliases (`f3`, `e1`). `groundVerdict` maps them back to real ids and drops what it can't verify: claims that cite no known fact or experience, and excerpts that don't appear in the posting. A recommended match left with no grounded evidence drops to `low` confidence.

`runDeepMatching(db, matcher, { limit, deadline })` takes `pending` matches at `cheap_relevance` for confirmed profiles, highest relevance first (default limit 50). No new evaluation starts after `deadline`; the rest stay pending for the next run.

| Recommendation | `status` | `stage_reached` |
| --- | --- | --- |
| `strong_fit`, `good_fit`, `stretch` | `ready` | `deep_match` |
| `not_recommended` | `filtered_out` | `deep_match` |
| Matcher error | stays `pending` and is retried on the next run | `cheap_relevance` |

The evaluation records `model` (`typesafe-ai/jev + anthropic/claude-sonnet-5.5`) and `prompt_version` (`DEEP_MATCH_PROMPT_VERSION`), so results can be compared after prompt or model changes. Run it with `bun run match:deep [limit]`.

### Evaluation

`src/matching/deep-match-eval.ts` holds a curated set for one senior HR Business Partner profile:

- **Obvious HR roles** (HRBP, People Operations Lead, HR Manager) must be `strong_fit` / `good_fit`.
- **Adjacent management and operations roles** (Talent & Culture, L&D, Operations Manager, Chief of Staff) must be `good_fit` / `stretch`. Talent & Culture may also be `strong_fit`.
- **Clear negatives** must be `not_recommended`: backend engineer, financial controller and field sales; an HRBP role paying below the salary must-have; a technical recruiter role the user dislikes.

Each case also fails when a recommended verdict has no grounded evidence, or when the explanation states a numeric fit score. Run `bun run eval:deep-match [decisionModel] [explanationModel]` against the real models. They default to `DECISION_MODEL` and `EXPLANATION_MODEL`, and the script exits non-zero on any failure.
