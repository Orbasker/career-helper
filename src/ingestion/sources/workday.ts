import type { CollectContext, JobSourceAdapter, RawJob } from "../adapter.js";
import { boardSince, collectBoards, dateFrom, employmentTypeFrom, htmlToText, politeFetch, workModeFrom, type BoardPayload } from "./shared.js";

export interface WorkdayPosting {
  id: string;
  title: string;
  jobDescription?: string | null;
  location?: string | null;
  additionalLocations?: string[] | null;
  country?: { descriptor?: string | null } | null;
  remoteType?: string | null;
  startDate?: string | null;
  timeType?: string | null;
  jobReqId?: string | null;
  externalUrl?: string | null;
  posted?: boolean;
  canApply?: boolean;
  [key: string]: unknown;
}

interface WorkdayListItem {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
  bulletFields?: string[];
}

interface WorkdayFacet {
  facetParameter?: string;
  descriptor?: string;
  id?: string;
  values?: WorkdayFacet[];
}

interface WorkdayJobs {
  total?: number;
  jobPostings?: WorkdayListItem[];
  facets?: WorkdayFacet[];
}

const PAGE_SIZE = 20;
const MAX_PAGES = 25;
const DEFAULT_MAX_DETAILS = 60;
const DEFAULT_INTERVAL_MS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const GONE = new Set([400, 404, 410]);

type Payload = BoardPayload<WorkdayPosting>;
type Fetcher = { fetch: typeof fetch; signal?: AbortSignal };

export const workdayAdapter: JobSourceAdapter<Payload> = {
  source: { key: "workday", name: "Workday job boards", kind: "api", baseUrl: "https://www.myworkdayjobs.com" },

  /** Reads only a board's Israel postings, skipping ones posted before the last run and capping details per board. */
  collect(ctx) {
    const polite = { signal: ctx.signal, fetch: politeFetch(ctx.fetch, { minIntervalMs: numberSetting(ctx, "requestIntervalMs", DEFAULT_INTERVAL_MS) }) };
    const maxDetails = numberSetting(ctx, "maxDetailsPerBoard", DEFAULT_MAX_DETAILS);
    return collectBoards(ctx, async (board) => {
      const since = boardSince(board, ctx.since);
      const maxAgeDays = since ? Math.ceil((Date.now() - since.getTime()) / DAY_MS) + 1 : null;
      const match = /^([a-z0-9-]+)\.(wd\d+)\/([^/]+)$/i.exec(board.token);
      if (!match) throw new Error(`Workday board "${board.token}" is not {tenant}.{wdN}/{site}`);
      const [, tenant, instance, site] = match as unknown as [string, string, string, string];
      const host = `https://${tenant.toLowerCase()}.${instance.toLowerCase()}.myworkdayjobs.com`;
      const api = `${host}/wday/cxs/${encodeURIComponent(tenant.toLowerCase())}/${encodeURIComponent(site)}`;
      const company = board.company ?? tenant.charAt(0).toUpperCase() + tenant.slice(1).toLowerCase();

      const unfiltered = await searchJobs(polite, `${api}/jobs`, {}, 0);
      const israel = israelFacet(unfiltered.facets ?? []);
      if (!israel) throw new Error(`No Israel location facet on Workday board ${board.token}`);

      const records: RawJob<Payload>[] = [];
      let total = Infinity;
      let details = 0;
      for (let page = 0; page < MAX_PAGES && details < maxDetails && page * PAGE_SIZE < total; page++) {
        const result = await searchJobs(polite, `${api}/jobs`, israel, page * PAGE_SIZE);
        if (page === 0) total = result.total ?? 0;
        const items = result.jobPostings ?? [];
        for (const item of items) {
          if (details >= maxDetails) break;
          const age = postedDaysAgo(item.postedOn);
          if (maxAgeDays !== null && age !== null && age > maxAgeDays) continue;
          details++;
          let posting: WorkdayPosting | null;
          try {
            posting = await fetchPosting(polite, `${api}${item.externalPath}`);
          } catch (error) {
            ctx.reportError(`posting:${board.token}:${item.externalPath}`, error);
            continue;
          }
          if (!posting || posting.posted === false) continue;
          records.push({
            externalId: `${board.token}:${posting.id}`,
            sourceUrl: posting.externalUrl ?? `${host}/${site}${item.externalPath}`,
            payload: { board: board.token, company, posting },
          });
        }
        if (items.length === 0) break;
      }
      return records;
    });
  },

  normalize({ payload: { company, posting } }) {
    const location = locationFrom(posting);
    return {
      title: posting.title.trim(),
      description: htmlToText(posting.jobDescription ?? ""),
      company,
      location,
      workMode: workModeFrom(posting.remoteType) ?? workModeFrom(location),
      employmentType: employmentTypeFrom(posting.timeType),
      publishedAt: dateFrom(posting.startDate),
    };
  },
};

function locationFrom(posting: WorkdayPosting): string | null {
  const location = posting.location?.trim() || null;
  const country = posting.country?.descriptor?.trim();
  if (!location || !country || !location.startsWith(`${country}, `)) return location;
  return `${location.slice(country.length + 2)}, ${country}`;
}

type AppliedFacets = Record<string, string[]>;

export function israelFacet(facets: WorkdayFacet[]): AppliedFacets | null {
  const candidates = flattenFacets(facets)
    .filter(({ parameter }) => /country|hierarchy|location/i.test(parameter))
    .map(({ parameter, values }) => ({
      parameter,
      ids: values.filter((v) => v.id && /\bisrael\b/i.test(v.descriptor ?? "")).map((v) => v.id!),
      rank: /country/i.test(parameter) ? 0 : /hierarchy/i.test(parameter) ? 1 : 2,
    }))
    .filter(({ ids }) => ids.length > 0)
    .sort((a, b) => a.rank - b.rank);
  const best = candidates[0];
  return best ? { [best.parameter]: best.ids } : null;
}

function flattenFacets(facets: WorkdayFacet[]): { parameter: string; values: WorkdayFacet[] }[] {
  return facets.flatMap((facet) => {
    const values = facet.values ?? [];
    const nested = flattenFacets(values.filter((v) => v.facetParameter && v.values));
    return facet.facetParameter ? [{ parameter: facet.facetParameter, values: values.filter((v) => v.id) }, ...nested] : nested;
  });
}

function postedDaysAgo(text: string | undefined): number | null {
  if (!text) return null;
  if (/today/i.test(text)) return 0;
  if (/yesterday/i.test(text)) return 1;
  const days = /(\d+)\+?\s*days?/i.exec(text)?.[1];
  return days ? Number(days) : null;
}

function numberSetting(ctx: CollectContext, key: string, fallback: number): number {
  const value = ctx.config[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

const timeoutSignal = (ctx: Fetcher) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
};

async function searchJobs(ctx: Fetcher, url: string, appliedFacets: AppliedFacets, offset: number): Promise<WorkdayJobs> {
  const response = await ctx.fetch(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ appliedFacets, limit: PAGE_SIZE, offset, searchText: "" }),
    signal: timeoutSignal(ctx),
  });
  if (!response.ok) throw new Error(`POST ${url} failed with ${response.status}`);
  return (await response.json()) as WorkdayJobs;
}

async function fetchPosting(ctx: Fetcher, url: string): Promise<WorkdayPosting | null> {
  const response = await ctx.fetch(url, { headers: { accept: "application/json" }, signal: timeoutSignal(ctx) });
  if (GONE.has(response.status)) return null;
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  const body = (await response.json()) as { jobPostingInfo?: WorkdayPosting };
  return body.jobPostingInfo ?? null;
}
