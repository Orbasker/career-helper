# Job discovery

Code: `src/discovery/` (plan, queries, page reading, ATS boards, run), `src/ingestion/search.ts` (job sites), `src/ai/job-discoverer.ts` (agent), `src/app/postgres/sites.ts` (user sites). Tables: `job_sources`, `user_job_sites`.

Jobs come from four kinds of source, plus links users send the bot (`user_submitted`, see `docs/job-links.md`). All of them go through the same ingestion, dedup and matching:

| Source | How it finds jobs |
| --- | --- |
| **Basic boards** (`greenhouse`, `lever`, `ashby`, `comeet`, `workable`, `smartrecruiters`, `workday`) | The public job-board APIs for the boards in `job_sources.config.boards` (see `docs/job-ingestion.md`). |
| **Job sites** (`linkedin`, `alljobs`, `drushim`, `jobmaster`, kind `scraper`) | Searched with each profile's roles every day and when a user sends `/search`. |
| **Agent web search** (`web_search`) | For each user, an agent searches the open web for postings that fit their profile. |
| **User sites** | Each user's saved sites, searched by the same agent. |

## Discovery stage

`runDiscovery(db, discoverer, boardAdapters)` is the first stage of the daily pipeline (`docs/pipeline.md`). For every confirmed profile:

1. **Plan** (`searchPlan`). It builds up to `DISCOVERY_QUERIES_PER_USER` (default 3) queries such as "Backend Engineer jobs Tel Aviv":
   - roles: active target roles, otherwise the headline and past titles;
   - place: the first location must-have, otherwise Israel.

   Active dislikes are passed to the agent as kinds of work to skip.
2. **Search.** The agent (`AiJobDiscoverer`, `anthropic/claude-sonnet-5.5`) uses AI Gateway's **Perplexity Search** tool with `country: IL` and results from the last month.
   - It runs one open search, plus one limited to the user's saved sites (domain filter) if they have any.
   - It returns links to single postings, preferring the company's own careers page or ATS.
   - Links that did not appear in the search results are dropped, so the agent cannot invent URLs.
3. **Boards.** Links to a Greenhouse, Lever or Ashby board (`atsBoardFromUrl`) are not fetched. The board is added to that source's `config.boards` (`addBoards`), so the basic collector fetches the whole board in this run and every run after.
4. **Pages.** Other links are skipped if a job with that URL already exists. The rest are fetched, at most `DISCOVERY_MAX_PAGES` (default 25) per run:
   - `robots.txt` is respected for `*` and `CareerAgentBot`, with a 15s timeout and a 2 MB limit;
   - the page's `schema.org/JobPosting` JSON-LD is used when present, and postings past `validThrough` are skipped as closed;
   - otherwise the model reads the page text and says whether it is a single open posting, extracting only what the page states.
5. **Ingest.** Postings are ingested as the `web_search` source (kind `web_search`). The raw payload keeps the URL, the user it was found for, whether it came from their sites, the reading method (`json_ld` or `llm`) and the extracted fields. From here they are normal jobs: deduplicated against board jobs and matched for every user.

No search or fetch starts more than 90s after the run began (`DEFAULT_DISCOVERY_CUTOFF_MS`). Work not reached is picked up the next day.

**Failure handling:**
- A failing search affects only that user.
- A failing page (timeout, 403, non-HTML) is counted but doesn't fail the run.
- Setting `job_sources.is_enabled = false` for `web_search` turns discovery off without a deploy; `DISCOVERY_ENABLED=false` does the same.

The report (logged as `pipeline.discovery` and returned by the cron) includes:
- users, the users whose searches all completed (`searchedUsers`), searches and candidates;
- boards added, pages fetched, postings and distinct companies;
- skipped pages (already known, robots, not a posting, closed, over budget);
- the ingest summary and errors.

## User sites

| Bot | Effect |
| --- | --- |
| `/addsite example.co.il` (any URL works) | Saves the domain for the user, up to 20 (the search domain-filter limit). |
| "also search on example.co.il" | Same, once the profile is confirmed. |
| `/sites` | Lists the sites with ✖️ buttons to remove them (`st:x:<siteId>`). |

A link to a Greenhouse, Lever or Ashby board is added as a basic board for everyone instead of a user site, since its official API is cheaper and more complete than searching it.

## Job sites

A job site is a `JobSearchSource` (`src/ingestion/search.ts`): it is searched by keywords rather than collected whole. `runSiteSearch(db, sources, queries)` runs every query on every enabled site, sites in parallel and each site's requests one at a time:

1. **Queries** (`profileJobQueries`, `src/discovery/queries.ts`): the same roles and place as the web search (`jobQueries`), without repeats across users, at most 12 per daily run. A query's place is passed to the site when it can filter by it; otherwise the hard filters handle location.
2. **Search.** Up to 25 postings per query, newest first. A failing query is reported as `query:<keywords>` and the next one runs.
3. **Known postings are skipped.** Postings already stored for that source (same `external_id`) are never fetched again.
4. **Details.** Sites whose results lack the description (LinkedIn, JobMaster) fetch each new posting's page, at most 40 per site per run; the rest are counted as `deferred` and picked up next time. Pages that are gone (404/410) or closed are dropped.
5. **Ingest** under the site's own source, so normal deduplication and matching apply.

Every site waits between requests (`requestIntervalMs`, 1–1.5s) and retries 429/5xx twice with backoff. A 401/403/429/999 or a captcha or login wall throws `SourceBlockedError`: the site is skipped for the rest of the run, the error scope is `blocked` and `/sources` shows it as blocked rather than as checked. `last_collected_at` only moves on an error-free run. Setting `job_sources.is_enabled = false` turns a site off without a deploy.

| Site | How |
| --- | --- |
| `drushim` | Drushim's own JSON search API (`webapi.drushim.co.il/api/jobs/search`); full descriptions in the list. Remote queries use its work-from-home filter; region filters are left out because robots.txt disallows them. |
| `alljobs` | Public guest search pages (`SearchResultsGuest.aspx`); full descriptions in the list. Known cities and the work-from-home region are passed as filters. |
| `jobmaster` | The first public results page (10 postings; later pages require login), then each new posting's page for the description. |
| `linkedin` | LinkedIn's public guest job search (`/jobs-guest/…`, no login), last 7 days, then each new posting's page. LinkedIn's robots.txt disallows these paths and it often blocks cloud IPs, so expect it to show as blocked at times. |

Indeed (Cloudflare captcha) and Wellfound (guest results stop after the first page) are not collected; they stay reachable through the web search.

## Showing sources to users

`/sources` (`PgSourceService`, `src/app/postgres/sources.ts`) is built only from stored data:

| Shown | Comes from |
| --- | --- |
| Boards per source, enabled or not | `job_sources.config.boards`, `is_enabled` |
| Job sites and when they were last searched | `scraper` sources, `job_sources.last_collected_at` |
| Last board collection | `job_sources.last_collected_at` |
| Last web search for the user | the latest `pipeline_runs` row whose discovery `searchedUsers` contains them |
| Jobs and new companies (no earlier job at that company) in the last 7 days | `jobs.created_at`, per origin |
| Problems | the latest finished run: board sources with errors (`errorScopes` `board:<token>` → unreachable boards), a failed ingestion or discovery stage, a `user:<id>` discovery error, discovery skipped (turned off), job sites that blocked us (`siteSearch` `blocked`) or failed; plus disabled sources |

A job's origin for a user (`jobOrigin`) is `board` for board sources, `job_site` for `scraper` sources (shown with the site's name), `user_site` for a `web_search` posting found on that user's own sites (`payload.foundBy`), `web_search` for other web postings (including those found on another user's sites, which are never revealed), and `user_link` for `manual` sources. Job details show the origin, when any copy of the job was first collected and up to 3 other URLs from its duplicate group.

## Settings

| Env var | Default |
| --- | --- |
| `DISCOVERY_ENABLED` | `true` |
| `DISCOVERY_QUERIES_PER_USER` | `3` |
| `DISCOVERY_MAX_PAGES` | `25` per run |

Cost per run is about `users × (1 + has sites)` agent calls with up to `queries` searches each, plus one model call per fetched page without JSON-LD.
