# Job links

Code: `src/discovery/submitted.ts` (reading and ingesting), `src/discovery/safe-fetch.ts` (fetching user URLs), `src/matching/on-demand.ts` (matching one job now), `src/app/postgres/job-links.ts` (service). Source: `user_submitted`.

A user with a confirmed profile can paste a link to a job posting into the chat. The bot reads it, matches it against their profile right away and replies with the normal match details.

## Detecting links

Any http(s) link in a normal text message is treated as a job to evaluate, up to 3 per message (`jobLinksFromText`). The exceptions:
- LinkedIn profile links (`linkedin.com/in/…`) are ignored;
- before the profile is confirmed, links go to onboarding as before (e.g. the LinkedIn URL step);
- "search on example.co.il" still adds a user site (`docs/discovery.md`), and so does "look at / check" followed by a bare site. "Look at" followed by a link to a page is about that page, so a pasted job never becomes a recurring discovery site.

A link that turns out not to be a job posting stores nothing, so unrelated links in the same message never become jobs. When several links are sent, each reply names the site it is about.

## Reading the posting

`readSubmittedJob` drops the fragment and tracking parameters (`utm_*`, `gclid`, `fbclid`, …), then:

1. **Known job.** A grouped job with the same URL from any source, or the same Greenhouse / Lever / Ashby posting (by board and posting id, whether it came from the board collector or an earlier link), is reused without fetching anything.
2. **ATS links** are read through the board's official API, one posting at a time (Ashby has no single-posting endpoint, so its board is read and the posting picked out). The board's own adapter maps the fields, and the board's configured company name is used when there is one. The board is **not** added to `job_sources.config.boards`.
3. **Other pages** are fetched like discovery pages (robots.txt, 15s timeout, 2 MB). The `schema.org/JobPosting` JSON-LD is used when present; otherwise the model reads the page text (`AiJobDiscoverer.extract`). If the final URL after redirects is a known job, that job is reused.
4. **Ingest.** The posting is ingested as the `user_submitted` source (kind `manual`). The raw payload keeps the link as sent, `submittedBy` (user id), the reading method (`ats_api`, `json_ld` or `llm`) and the extracted fields. ATS postings get the external id `{source}:{board}:{posting}`. Deduplication then runs, so a posting already collected from another source joins its duplicate group.

### Fetching safely

The URL comes from the user, so every request, including each redirect hop, goes through `publicFetch`: only `http`/`https` on the default port, no credentials in the URL, no `localhost` / `.local` / `.internal` hosts, and the host must resolve only to public addresses (private, loopback, link-local, CGNAT and multicast ranges are refused for IPv4 and IPv6). Redirects are followed by hand, at most 5.

### When it isn't a readable job

| Outcome | When |
| --- | --- |
| `invalid` | Not an http(s) link, or not a public address. |
| `login_required` | HTTP 401, or a redirect to a login / sign-in / SSO page. |
| `gone` | HTTP 404 / 410, or the ATS no longer has the posting. |
| `closed` | JSON-LD `validThrough` has passed, or the model says the posting is closed. |
| `not_a_job` | Not HTML, or neither JSON-LD nor the model finds a single open posting (lists, company pages, articles). |
| `inaccessible` | robots.txt disallows it, another HTTP error (e.g. 403, 5xx), a timeout or a network error. |
| `unavailable` | `job_sources.is_enabled = false` for `user_submitted`. |

Each gets a short reply explaining what happened and what to send instead. Nothing is stored for any of them.

## Matching now

`matchGroupNow` matches the group's canonical job for this user only:
- **Existing match.** If the user already has a match for the group (e.g. from the daily run), it is reused. A match that only reached cheap relevance gets its deep match now.
- **Hard filters** apply as usual. A broken must-have stops there: the match is `filtered_out` at `hard_filter`, its explanation names the must-have, and no model call is made.
- **Cheap relevance** is scored and recorded, but a job the user asked about gets a deep match even below the threshold.
- **Deep match** runs immediately and is stored like a daily one (`match_evaluations` with model and prompt version).
- A `ready` match becomes `notified`, so the daily digest doesn't repeat it.
- If the deep match fails, the match stays `pending` and the daily run evaluates it; the user is told so.

## The reply

"🔎 Reading the job posting…" first, then the match details (`matchDetailsView`) with an intro: "Here's how this job fits you", "I already had this job…", or a note that it breaks a must-have. The details include the recommendation and explanation, fit evidence, transferable skills, gaps, people the user knows at the company (`docs/connections.md`) and the buttons: 👍 / 👎, **Tailor my CV** and **🔗 Original posting**. When the user hasn't imported connections, the reply suggests `/connections`.

Cost per link: no model call for known jobs or a broken must-have; otherwise one extraction call when the page has no JSON-LD, plus the deep match (Jev, and the explanation model when recommended).
