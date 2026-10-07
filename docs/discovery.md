# Job discovery

Code: `src/discovery/` (plan, page reading, ATS boards, run), `src/ai/job-discoverer.ts` (agent), `src/app/postgres/sites.ts` (user sites). Tables: `job_sources`, `user_job_sites`.

Jobs come from three kinds of source, plus links users send the bot (`user_submitted`, see `docs/job-links.md`). All of them go through the same ingestion, dedup and matching:

| Source | How it finds jobs |
| --- | --- |
| **Basic boards** (`greenhouse`, `lever`, `ashby`) | The official job-board APIs for the boards in `job_sources.config.boards` (see `docs/job-ingestion.md`). |
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
- users, searches and candidates;
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

## Settings

| Env var | Default |
| --- | --- |
| `DISCOVERY_ENABLED` | `true` |
| `DISCOVERY_QUERIES_PER_USER` | `3` |
| `DISCOVERY_MAX_PAGES` | `25` per run |

Cost per run is about `users × (1 + has sites)` agent calls with up to `queries` searches each, plus one model call per fetched page without JSON-LD.
