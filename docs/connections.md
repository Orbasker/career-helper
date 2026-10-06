# Connections

Code: `src/connections/` (parsing, lookup, ranking), `src/app/postgres/connections.ts`. Table: `connections`.

The bot shows which of the user's contacts work at a matched company, so they know whom to ask for a referral or an intro.

## Import

LinkedIn has no API for reading a member's connections, so the user exports them: **Settings → Data privacy → Get a copy of your data → Connections**. `/connections` explains this.

The user sends the file to the bot at any time. A `.csv` or `.zip` document is treated as a connections import; any other document still goes to profile onboarding.

`readConnectionsFile` reads either `Connections.csv` or the export ZIP (any entry named `Connections.csv`):
- it skips LinkedIn's "Notes" lines before the `First Name,Last Name,URL,Email Address,Company,Position,Connected On` header;
- it handles quoted fields (commas, newlines, doubled quotes) and a BOM;
- it keeps a profile URL only if it is http(s), and reads "06 Oct 2026" dates;
- rows without a name are skipped and counted.

An import replaces the user's previous contacts in one transaction. The reply says how many contacts and companies were imported, and how many rows were skipped.

Stored per contact: full name, profile URL, company, normalized company, position, connected-on date and import time. Email addresses are never stored.

## On matches

Contacts match a job's company after normalization on whole words, the same rule as the current/former employer flag (`sameNormalizedCompany`): "Via Transportation Inc." counts for a job at Via, "Viasat" doesn't.

- **Match list and daily digest:** "👥 2 connections at Via".
- **Match details:** "People you know at Via" with up to 5 contacts (name linked to their LinkedIn profile, position), then "and N more". They are ranked by shared words between their position and the job title (same function first), then seniority (C-level/VP, head/director, manager/lead/principal), then name.
- **Freshness:** a LinkedIn export reflects each contact's company at export time. If the import is older than 90 days, the details add "From your LinkedIn export of YYYY-MM. Send /connections to refresh it."

## Privacy

Contacts are third parties' personal data:
- They are stored only for the user who imported them and used only on that user's matches. Every query is scoped by `user_id`.
- The user can delete them with **🗑 Delete my connections** in `/connections` (`cn:delete`), or by asking ("delete my LinkedIn connections").
- They are deleted with the user (`on delete cascade`).
