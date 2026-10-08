import type { EmploymentType, WorkMode } from "../../domain/enums.js";
import type { RawJob } from "../adapter.js";
import { SourceBlockedError, type JobQuery, type JobSearchSource, type SearchContext } from "../search.js";
import { BLOCKED_STATUSES, dateFrom, fetchText, htmlToText, type FetchedText } from "./shared.js";

export interface JobMasterCard {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  type: string | null;
  /** Relative Hebrew text such as "פורסם לפני 3 שעות". */
  posted: string | null;
  postedAt: string | null;
}

export interface JobMasterDetail {
  descriptionHtml: string | null;
  requirementsHtml: string | null;
  location: string | null;
  type: string | null;
}

export interface JobMasterPosting {
  card: JobMasterCard;
  detail: JobMasterDetail | null;
}

const SITE = "https://www.jobmaster.co.il";
const REMOTE = /^(?:remote|work from home|מהבית|עבודה מהבית)$/i;
const WORK_FROM_HOME = "עבודה מהבית";
const AUTH_HOST = /^account\./;
const HOUR_MS = 3_600_000;
const AGE_UNITS: [RegExp, number][] = [
  [/דק/, 60_000],
  [/שע/, HOUR_MS],
  [/(?:יום|ימים)/, 24 * HOUR_MS],
  [/שבוע/, 7 * 24 * HOUR_MS],
  [/חודש/, 30 * 24 * HOUR_MS],
];

/** JobMaster's public search pages; guests only see the first page, so a query yields at most 10 postings. */
export const jobmasterSource: JobSearchSource<JobMasterPosting> = {
  source: { key: "jobmaster", name: "JobMaster", kind: "scraper", baseUrl: SITE },
  requestIntervalMs: 1_000,

  async search(query: JobQuery, ctx: SearchContext): Promise<RawJob<JobMasterPosting>[]> {
    const response = await fetchText(ctx, searchUrl(query), { headers: { accept: "text/html" } });
    assertNotBlocked(response);
    if (!response.ok) throw new Error(`JobMaster search failed with ${response.status}`);
    const now = new Date();
    return parseSearch(response.text, now)
      .sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""))
      .slice(0, ctx.limit)
      .map((card) => ({ externalId: card.id, sourceUrl: postingUrl(card.id), payload: { card, detail: null } }));
  },

  async details(listed: RawJob<JobMasterPosting>, ctx: SearchContext): Promise<RawJob<JobMasterPosting> | null> {
    const response = await fetchText(ctx, postingUrl(listed.payload.card.id), { headers: { accept: "text/html" } });
    assertNotBlocked(response);
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`JobMaster posting ${listed.payload.card.id} failed with ${response.status}`);
    const detail = parseDetail(response.text);
    if (!detail.descriptionHtml && !detail.requirementsHtml) throw new Error(`JobMaster posting ${listed.payload.card.id} has no description`);
    return { ...listed, payload: { ...listed.payload, detail } };
  },

  normalize({ payload: { card, detail } }) {
    if (!detail) return null;
    const description = [detail.descriptionHtml, detail.requirementsHtml].filter(Boolean).map((html) => htmlToText(html!)).filter(Boolean).join("\n\n");
    if (!description) return null;
    const type = detail.type ?? card.type;
    const location = detail.location ?? card.location;
    return {
      title: card.title,
      description,
      company: card.company,
      location,
      workMode: workModeOf(`${type ?? ""} ${location ?? ""} ${card.title}`),
      employmentType: employmentOf(type),
      publishedAt: dateFrom(card.postedAt),
    };
  },
};

function searchUrl(query: JobQuery): string {
  const place = query.location?.trim() || null;
  const remote = place !== null && REMOTE.test(place);
  const params = new URLSearchParams({ q: remote ? `${query.keywords} ${WORK_FROM_HOME}` : query.keywords });
  if (place && !remote) params.set("l", place);
  return `${SITE}/jobs/?${params}`;
}

const postingUrl = (id: string) => `${SITE}/jobs/checknum.asp?key=${id}`;

function assertNotBlocked(response: FetchedText): void {
  if (BLOCKED_STATUSES.has(response.status)) throw new SourceBlockedError(`JobMaster answered ${response.status}`);
  if (AUTH_HOST.test(new URL(response.url).hostname)) throw new SourceBlockedError("JobMaster asked to sign in");
}

function parseSearch(html: string, now: Date): JobMasterCard[] {
  return html.split(/(?=<article id="misra\d+")/).flatMap((chunk): JobMasterCard[] => {
    const id = chunk.match(/^<article id="misra(\d+)"/)?.[1];
    const title = textOf(chunk.match(/<a class="CardHeader View_Job_Details"[^>]*href='\/jobs\/checknum\.asp\?key=\d+'[^>]*>([\s\S]*?)<\/a>/)?.[1]);
    if (!id || !title) return [];
    const posted = textOf(chunk.match(/<span class="Gray">\s*(פורסם[^<]*?)\s*<\/span>/)?.[1]);
    return [
      {
        id,
        title,
        company: textOf(chunk.match(/class="font14 CompanyNameLink"[^>]*>\s*<span>([^<]*)<\/span>/)?.[1]),
        location: textOf(chunk.match(/<li class="jobLocation">[\s\S]*?<a[^>]*>([^<]*)<\/a>/)?.[1]),
        type: textOf(chunk.match(/<li tabindex="0" class="jobType">[\s\S]*?<a[^>]*>([^<]*)<\/a>/)?.[1]),
        posted,
        postedAt: postedAt(posted, now)?.toISOString() ?? null,
      },
    ];
  });
}

function parseDetail(html: string): JobMasterDetail {
  return {
    descriptionHtml: html.match(/id="jobDescriptionContent"[^>]*>([\s\S]*?)<\/div>/)?.[1]?.trim() || null,
    requirementsHtml: html.match(/id="jobRequirementsContent"[^>]*>([\s\S]*?)<\/div>/)?.[1]?.trim() || null,
    location: textOf(html.match(/id="jobLocationData">\s*<span>\s*([^<]*?)<\/span>/)?.[1]),
    type: textOf(html.match(/<li tabindex="0" class="jobType">([^<]*)<\/li>/)?.[1]),
  };
}

/** Reads "פורסם לפני 3 שעות", "לפני שעה", "היום" or "אתמול" as a time before `now`. */
export function postedAt(text: string | null, now: Date): Date | null {
  if (!text) return null;
  if (/היום/.test(text)) return now;
  if (/אתמול/.test(text)) return new Date(now.getTime() - 24 * HOUR_MS);
  const unit = AGE_UNITS.find(([pattern]) => pattern.test(text));
  if (!unit) return null;
  const count = Number(text.match(/\d+/)?.[0] ?? 1);
  return new Date(now.getTime() - count * unit[1]);
}

function employmentOf(type: string | null): EmploymentType | null {
  if (!type) return null;
  if (/מלאה/.test(type)) return "full_time";
  if (/חלקית/.test(type)) return "part_time";
  if (/פרילנס|עצמאי/.test(type)) return "freelance";
  if (/זמנית/.test(type)) return "temporary";
  if (/התמחות|סטאז/.test(type)) return "internship";
  return null;
}

function workModeOf(text: string): WorkMode | null {
  if (/היברידי/.test(text)) return "hybrid";
  if (/מהבית/.test(text)) return "remote";
  return null;
}

function textOf(html: string | undefined): string | null {
  return html ? htmlToText(html) || null : null;
}
