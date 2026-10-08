import type { EmploymentType, WorkMode } from "../../domain/enums.js";
import type { RawJob } from "../adapter.js";
import { SourceBlockedError, type JobQuery, type JobSearchSource, type SearchContext } from "../search.js";
import { BLOCKED_STATUSES, dateFrom, fetchText, htmlToText } from "./shared.js";

export interface DrushimJob {
  Code: number;
  Company?: { CompanyDisplayName?: string | null } | null;
  JobContent: {
    Name: string;
    Description?: string | null;
    Requirements?: string | null;
    Scopes?: { Code: number; NameInHebrew?: string }[] | null;
    Addresses?: { City?: string | null; CityEnglish?: string | null }[] | null;
  };
  JobInfo: { Link: string; Date?: string | null; IsExpired?: boolean };
  [key: string]: unknown;
}

interface DrushimSearch {
  ResultList?: DrushimJob[] | null;
  TotalPagesNumber?: number;
}

const API = "https://webapi.drushim.co.il/api/jobs/search";
const SITE = "https://www.drushim.co.il";
/** Drushim's "scope" codes. */
const FULL_TIME = 1;
const WORK_FROM_HOME = 5;
const HYBRID = 6;
const PART_TIME_SCOPE = /חלקית/;
const MAX_CITIES = 3;
const REMOTE = /^(?:remote|work from home|מהבית|עבודה מהבית)$/i;

/**
 * Drushim's public search API, which its own site calls; the list already holds full descriptions. Results are
 * Israel-wide: the API's `area` filter is disallowed by robots.txt, so places are left to the hard filters.
 */
export const drushimSource: JobSearchSource<DrushimJob> = {
  source: { key: "drushim", name: "Drushim", kind: "scraper", baseUrl: SITE },
  requestIntervalMs: 1_000,

  async search(query: JobQuery, ctx: SearchContext): Promise<RawJob<DrushimJob>[]> {
    const found: RawJob<DrushimJob>[] = [];
    for (let page = 0; found.length < ctx.limit; page++) {
      const params = new URLSearchParams({ SearchTerm: query.keywords, ssaen: "1", isAA: "true" });
      if (query.location && REMOTE.test(query.location.trim())) params.set("scope", String(WORK_FROM_HOME));
      if (page > 0) params.set("page", String(page));
      const response = await fetchText(ctx, `${API}?${params}`, { headers: { accept: "application/json", origin: SITE } });
      if (BLOCKED_STATUSES.has(response.status)) throw new SourceBlockedError(`Drushim answered ${response.status}`);
      if (!response.ok) throw new Error(`Drushim search failed with ${response.status}`);
      const body = JSON.parse(response.text) as DrushimSearch;
      const jobs = body.ResultList ?? [];
      for (const job of jobs) {
        if (job.JobInfo.IsExpired || found.length >= ctx.limit) continue;
        found.push({ externalId: String(job.Code), sourceUrl: new URL(job.JobInfo.Link, SITE).toString(), payload: job });
      }
      if (jobs.length === 0 || page + 1 >= (body.TotalPagesNumber ?? 0)) break;
    }
    return found;
  },

  normalize({ payload: job }) {
    const content = job.JobContent;
    const description = [content.Description, content.Requirements].filter(Boolean).map((html) => htmlToText(html!)).join("\n\n");
    const cities = [...new Set((content.Addresses ?? []).map((a) => (a.CityEnglish ?? a.City ?? "").trim()).filter(Boolean))];
    return {
      title: content.Name,
      description,
      company: job.Company?.CompanyDisplayName?.trim() || null,
      location: cities.length ? cities.slice(0, MAX_CITIES).join(", ") : null,
      workMode: workModeOf(content.Scopes ?? []),
      employmentType: employmentOf(content.Scopes ?? []),
      publishedAt: dateFrom(job.JobInfo.Date),
    };
  },
};

function workModeOf(scopes: { Code: number }[]): WorkMode | null {
  if (scopes.some((s) => s.Code === WORK_FROM_HOME)) return "remote";
  if (scopes.some((s) => s.Code === HYBRID)) return "hybrid";
  return null;
}

function employmentOf(scopes: { Code: number; NameInHebrew?: string }[]): EmploymentType | null {
  if (scopes.some((s) => s.Code === FULL_TIME)) return "full_time";
  if (scopes.some((s) => PART_TIME_SCOPE.test(s.NameInHebrew ?? ""))) return "part_time";
  return null;
}
