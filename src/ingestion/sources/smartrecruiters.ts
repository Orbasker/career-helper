import type { CollectContext, JobSourceAdapter, RawJob } from "../adapter.js";
import { boardSince, collectBoards, dateFrom, employmentTypeFrom, fetchJson, htmlToText, politeFetch, type BoardPayload } from "./shared.js";

export interface SmartRecruitersLocation {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  remote?: boolean;
  hybrid?: boolean;
  fullLocation?: string | null;
}

export interface SmartRecruitersPosting {
  id: string;
  name: string;
  releasedDate?: string | null;
  company?: { identifier?: string; name?: string | null };
  location?: SmartRecruitersLocation | null;
  typeOfEmployment?: { id?: string; label?: string | null } | null;
  postingUrl?: string | null;
  active?: boolean;
  jobAd?: { sections?: Record<string, { title?: string | null; text?: string | null } | undefined> };
  [key: string]: unknown;
}

const API = "https://api.smartrecruiters.com/v1/companies";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const DEFAULT_MAX_DETAILS = 50;
const DEFAULT_INTERVAL_MS = 400;
const SINCE_MARGIN_MS = 24 * 60 * 60 * 1000;
const SECTIONS = ["jobDescription", "qualifications", "additionalInformation"];
const GONE = new Set([400, 404, 410]);
const REQUEST_TIMEOUT_MS = 30_000;

type Payload = BoardPayload<SmartRecruitersPosting>;

export const smartRecruitersAdapter: JobSourceAdapter<Payload> = {
  source: { key: "smartrecruiters", name: "SmartRecruiters job boards", kind: "api", baseUrl: API },

  /** Reads details only for postings released since the last run (newest first, capped per board), so unchanged ones yield nothing. */
  collect(ctx) {
    const polite = { ...ctx, fetch: politeFetch(ctx.fetch, { minIntervalMs: numberSetting(ctx, "requestIntervalMs", DEFAULT_INTERVAL_MS) }) };
    const maxDetails = numberSetting(ctx, "maxDetailsPerBoard", DEFAULT_MAX_DETAILS);
    return collectBoards(ctx, async (board) => {
      const boardSinceDate = boardSince(board, ctx.since);
      const since = boardSinceDate ? boardSinceDate.getTime() - SINCE_MARGIN_MS : null;
      const company = encodeURIComponent(board.token);
      const country = boardCountry(ctx.config, board.token);
      const listed: SmartRecruitersPosting[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = `limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}${country ? `&country=${encodeURIComponent(country)}` : ""}`;
        const { totalFound, content } = await fetchJson<{ totalFound: number; content: SmartRecruitersPosting[] }>(
          polite,
          `${API}/${company}/postings?${query}`,
        );
        listed.push(...content);
        if (content.length < PAGE_SIZE || listed.length >= totalFound) break;
      }

      const recent = listed
        .filter((p) => since === null || (dateFrom(p.releasedDate)?.getTime() ?? Infinity) >= since)
        .sort((a, b) => (dateFrom(b.releasedDate)?.getTime() ?? 0) - (dateFrom(a.releasedDate)?.getTime() ?? 0))
        .slice(0, maxDetails);

      const records: RawJob<Payload>[] = [];
      for (const { id } of recent) {
        const url = `${API}/${company}/postings/${encodeURIComponent(id)}`;
        let posting: SmartRecruitersPosting | null;
        try {
          posting = await fetchDetail<SmartRecruitersPosting>(polite, url);
        } catch (error) {
          ctx.reportError(`posting:${board.token}:${id}`, error);
          continue;
        }
        if (!posting || posting.active === false) continue;
        records.push({
          externalId: `${board.token}:${posting.id}`,
          sourceUrl: posting.postingUrl ?? `https://jobs.smartrecruiters.com/${company}/${encodeURIComponent(posting.id)}`,
          payload: { board: board.token, company: board.company, posting },
        });
      }
      return records;
    });
  },

  normalize({ payload: { company, posting } }) {
    const sections = SECTIONS.flatMap((key) => {
      const section = posting.jobAd?.sections?.[key];
      const text = htmlToText(section?.text ?? "");
      return text ? [section?.title ? `${section.title}\n${text}` : text] : [];
    });
    const place = posting.location;
    return {
      title: posting.name.trim(),
      description: sections.join("\n\n"),
      company: company ?? posting.company?.name ?? null,
      location: locationFrom(place),
      workMode: place ? (place.remote ? "remote" : place.hybrid ? "hybrid" : "onsite") : null,
      employmentType: employmentTypeFrom(posting.typeOfEmployment?.label) ?? employmentTypeFrom(posting.typeOfEmployment?.id),
      publishedAt: dateFrom(posting.releasedDate),
    };
  },
};

const REGIONS = new Intl.DisplayNames(["en"], { type: "region" });

function locationFrom(place: SmartRecruitersLocation | null | undefined): string | null {
  if (!place) return null;
  const code = place.country ?? null;
  const country = code && /^[a-z]{2}$/i.test(code) ? (REGIONS.of(code.toUpperCase()) ?? code) : code;
  const location = [place.city, country].filter(Boolean).join(", ");
  return location || place.fullLocation || (place.remote ? "Remote" : null);
}

function boardCountry(config: Record<string, unknown>, token: string): string | null {
  const boards = Array.isArray(config.boards) ? config.boards : [];
  const entry = boards.find((b) => b && typeof b === "object" && b.token?.trim?.() === token);
  if (entry && "country" in entry) return typeof entry.country === "string" && entry.country ? entry.country : null;
  return "il";
}

function numberSetting(ctx: CollectContext, key: string, fallback: number): number {
  const value = ctx.config[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function fetchDetail<T>(ctx: { fetch: typeof fetch; signal?: AbortSignal }, url: string): Promise<T | null> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await ctx.fetch(url, {
    headers: { accept: "application/json" },
    signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
  });
  if (GONE.has(response.status)) return null;
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return (await response.json()) as T;
}
