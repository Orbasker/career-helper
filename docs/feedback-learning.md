# Feedback and preference learning

Code: `src/learning/infer.ts` (rules), `src/app/postgres/feedback.ts` (persistence). Tables: `feedback`, `preferences`, `preference_evidence`.

## Capturing feedback

- **👍 / 👎** on a match appends a `feedback` row. Repeating the latest verdict for a match does nothing. 👎 sets the match to `dismissed`; a later 👍 restores it to `notified` (or `ready` if it was never delivered).
- After 👎 the bot asks what put the user off. Each button appends a tag to `feedback.reason_tags`: `role`, `seniority`, `location`, `work_mode`, `company` or `pay`. The user can tap several.
- **✍️ Something else** makes the user's next text message, within 10 minutes, the free-text `feedback.reason`. It is stored in `conversation_states` (`flow = preference_update`, `step = feedback_reason`). It replaces any pending profile edit.

## Learning rules

After 👎 and after every reason tag, `feedback.learn` looks at the user's latest verdict per duplicate group and proposes preferences when the signal repeats:

| Proposal | When | Never when |
| --- | --- | --- |
| Avoid `<Word> roles` (`dislike`, `role`, `terms: [word]`) | ≥ 3 passes whose titles share a word, counting passes tagged `role` or with no tags | The word is in the user's headline, past titles, target roles or a liked job's title. When several words cover the same jobs, one proposal is made |
| Avoid `Jobs at <Company>` (`dislike`, `company`) | ≥ 2 passes tagged `company` at the same normalized company | The user liked a job at that company |
| `<Modes> only` (`hard_constraint`, `work_mode`) | ≥ 3 passes tagged `work_mode` on jobs with a known work mode | The user liked a job with that mode, or no mode would be left. It narrows the current active work-mode must-have and supersedes it on acceptance |

A preference with the same value that the user has, or had in any status (including `rejected`), is never proposed again. Each proposal is saved as `status = proposed`, `origin = inferred_from_feedback`, with a `rationale` and a `preference_evidence` row for every feedback that supports it.

## Confirmation

Nothing changes until the user decides. The bot sends each new proposal with its rationale and **Yes** / **No** buttons:

- **Yes**: the preference becomes `active` (with `decided_at`), the preference it replaces becomes `superseded`, and `career_profiles.revision` is bumped.
- **No**: the preference becomes `rejected` and is never proposed again.

Unconfirmed inferred proposals are hidden from the profile, the profile assistant and matching (`loadSnapshot`).

## Effect on matching

Accepted preferences are ordinary active preferences, so they apply to jobs matched from then on:

- Role dislikes halve the cheap relevance score when the title contains the word, and the deep matcher rejects jobs that are mainly that kind of work.
- Company dislikes are a hard filter.
- Work-mode must-haves are a hard filter.

Matches that already exist are not re-evaluated.
