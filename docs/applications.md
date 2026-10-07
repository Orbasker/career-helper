# Applications

Code: `src/app/postgres/applications.ts`, `src/domain/applications.ts`, `src/bot/views.ts` (`applicationsViews`, `applicationCardView`). Tables: `applications`, `application_events`.

The agent keeps track of the jobs the user actually applied to, so it can stop recommending them, and later follow up and learn from outcomes (Gmail sync and reminders build on this).

## Recording an application

| Where | What is recorded |
| --- | --- |
| **📨 I applied** on a job's details (`ap:m:<matchId>`) | The match, its duplicate group, job title, company and URL, and the latest tailored CV the user approved for the job. The button then shows the status (`📌 Applied · …`) and opens the application. |
| **📨 I applied with this CV** on a tailored CV document (`ap:v:<versionId>`) | The same, with that CV. When the application already exists the CV is linked to it (a `cv_linked` event). |
| `/applied Acme — HR Manager`, **➕ Log an application** (`ap:add`) | A job the agent never surfaced. The bot waits up to 10 minutes for the details (`conversation_states.flow = application`, `step = details`). "Acme — HR Manager", "Acme, HR Manager", "Acme \| HR Manager", two lines, "HR Manager at Acme" and "מנהלת משאבי אנוש ב-Acme" are understood. |
| A link in those details | Read through the job-link flow (`docs/job-links.md`): the posting is ingested and matched, and the application is recorded on that match. When the link can't be read, the company and title sent with it are logged by hand together with the link. |

A job logged by hand is linked to the user's match for it when one exists with the same normalized company and title. Otherwise it keeps the normalized company and title, so the agent recognizes the job when it finds it later.

There is at most one application per user and duplicate group; applying again shows the existing application.

## Statuses and history

`applied` → `screening` → `interviewing` → `offer`, or `rejected`, `withdrawn`, `no_response`. Any status can be set from any other.

Every change appends an `application_events` row:

| Kind | Fields |
| --- | --- |
| `status_changed` | `from_status` (null when the application was created) and `to_status` |
| `note_added` | `note` (the latest note is also kept on `applications.notes`) |
| `cv_linked` | `cv_version_id` |

Each event has a `source` (`user` for the bot, `email` and `system` for Gmail sync and automatic updates) and an optional `evidence_ref` such as the email it came from. Setting the current status again records nothing. `applications.last_event_at` is the time of the latest event.

## `/applications`

Lists the user's applications grouped by status, live processes first (offer, interviewing, screening, applied, no response, then rejected and withdrawn), with the applied date. Tapping one (`ap:<applicationId>`) shows its status, when it last changed, the CV used, the posting link and its history, with a button per other status (`ap:s:<code>:<applicationId>`), **Add a note** (`ap:n:`; the next message within 10 minutes is the note) and **My applications** (`ap:list`). "my applications" and "המועמדויות שלי" open the list too.

## Not recommending applied jobs again

`notAppliedTo()` excludes matches whose duplicate group has an application, or whose job has the same normalized company and title as a job logged by hand. The daily digest (`runNotifications`) and **What's new?** both use it; the job's details still open and show the application.
