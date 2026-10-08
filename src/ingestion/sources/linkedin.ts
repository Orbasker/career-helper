import type { RawJob } from "../adapter.js";
import { SourceBlockedError, type JobQuery, type JobSearchSource, type SearchContext } from "../search.js";
import { BLOCKED_STATUSES, dateFrom, employmentTypeFrom, fetchText, htmlToText, workModeFrom, type FetchedText } from "./shared.js";

export interface LinkedInCard {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  /** `YYYY-MM-DD` from the card. */
  postedOn: string | null;
  /** Found by a search filtered to remote work. */
  remote: boolean;
}

export interface LinkedInDetail {
  descriptionHtml: string;
  criteria: Record<string, string>;
}

export interface LinkedInPosting {
  card: LinkedInCard;
  detail: LinkedInDetail | null;
}

const SITE = "https://www.linkedin.com";
const SEARCH = `${SITE}/jobs-guest/jobs/api/seeMoreJobPostings/search`;
const POSTING = `${SITE}/jobs-guest/jobs/api/jobPosting`;
const ISRAEL_GEO_ID = "101620260";
const PAGE_SIZE = 10;
const PAST_WEEK = "r604800";
const REMOTE_WORKPLACE = "2";
const REMOTE = /^(?:remote|work from home|מהבית|עבודה מהבית)$/i;
const ISRAEL = /israel|ישראל/i;
const AUTH_WALL = /\/(?:authwall|login|checkpoint|uas\/login)/;
const CLOSED = /closed-job|No longer accepting applications/i;
/** English pages keep the criteria labels ("Employment type") stable. */
const HEADERS = { accept: "text/html", "accept-language": "en-US,en;q=0.9" };

/** LinkedIn's public guest job pages, which need no login; results are limited to the past week, newest first. */
export const linkedinSource: JobSearchSource<LinkedInPosting> = {
  source: { key: "linkedin", name: "LinkedIn", kind: "scraper", baseUrl: SITE },
  requestIntervalMs: 1_500,

  async search(query: JobQuery, ctx: SearchContext): Promise<RawJob<LinkedInPosting>[]> {
    const remote = query.location !== null && REMOTE.test(query.location.trim());
    const found: RawJob<LinkedInPosting>[] = [];
    const seen = new Set<string>();
    for (let start = 0; found.length < ctx.limit; start += PAGE_SIZE) {
      const response = await fetchText(ctx, searchUrl(query, remote, start), { headers: HEADERS });
      assertNotBlocked(response);
      if (response.status === 400 || response.status === 404) break;
      if (!response.ok) throw new Error(`LinkedIn search failed with ${response.status}`);
      const cards = parseSearch(response.text, remote).filter((card) => !seen.has(card.id));
      for (const card of cards) {
        seen.add(card.id);
        if (found.length < ctx.limit) found.push({ externalId: card.id, sourceUrl: `${SITE}/jobs/view/${card.id}`, payload: { card, detail: null } });
      }
      if (cards.length === 0) break;
    }
    return found.sort((a, b) => (b.payload.card.postedOn ?? "").localeCompare(a.payload.card.postedOn ?? ""));
  },

  async details(listed: RawJob<LinkedInPosting>, ctx: SearchContext): Promise<RawJob<LinkedInPosting> | null> {
    const response = await fetchText(ctx, `${POSTING}/${listed.payload.card.id}`, { headers: HEADERS });
    assertNotBlocked(response);
    if (response.status === 404 || response.status === 410) return null;
    if (!response.ok) throw new Error(`LinkedIn posting ${listed.payload.card.id} failed with ${response.status}`);
    if (CLOSED.test(response.text)) return null;
    const detail = parseDetail(response.text);
    if (!detail) throw new Error(`LinkedIn posting ${listed.payload.card.id} has no description`);
    return { ...listed, payload: { ...listed.payload, detail } };
  },

  normalize({ payload: { card, detail } }) {
    if (!detail) return null;
    const description = htmlToText(detail.descriptionHtml);
    if (!description) return null;
    return {
      title: card.title,
      description,
      company: card.company,
      location: card.location,
      workMode: card.remote ? "remote" : workModeFrom(`${card.location ?? ""} ${card.title}`),
      employmentType: employmentTypeFrom(detail.criteria["Employment type"]),
      publishedAt: dateFrom(card.postedOn),
    };
  },
};

function searchUrl(query: JobQuery, remote: boolean, start: number): string {
  const place = remote ? null : query.location?.trim() || null;
  const params = new URLSearchParams({ keywords: query.keywords, location: place ? (ISRAEL.test(place) ? place : `${place}, Israel`) : "Israel" });
  if (!place) params.set("geoId", ISRAEL_GEO_ID);
  params.set("f_TPR", PAST_WEEK);
  if (remote) params.set("f_WT", REMOTE_WORKPLACE);
  params.set("sortBy", "DD");
  params.set("start", String(start));
  return `${SEARCH}?${params}`;
}

function assertNotBlocked(response: FetchedText): void {
  if (BLOCKED_STATUSES.has(response.status)) throw new SourceBlockedError(`LinkedIn answered ${response.status}`);
  if (AUTH_WALL.test(new URL(response.url).pathname)) throw new SourceBlockedError("LinkedIn asked to sign in");
}

function parseSearch(html: string, remote: boolean): LinkedInCard[] {
  return html.split(/<li[\s>]/).flatMap((chunk): LinkedInCard[] => {
    const id = chunk.match(/data-entity-urn="urn:li:jobPosting:(\d+)"/)?.[1];
    const title = textOf(chunk.match(/<h3 class="base-search-card__title">([\s\S]*?)<\/h3>/)?.[1]);
    if (!id || !title) return [];
    const subtitle = chunk.match(/<h4 class="base-search-card__subtitle">([\s\S]*?)<\/h4>/)?.[1];
    return [
      {
        id,
        title,
        company: textOf(subtitle?.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? subtitle),
        location: textOf(chunk.match(/<span class="job-search-card__location">([\s\S]*?)<\/span>/)?.[1]),
        postedOn: chunk.match(/<time class="job-search-card__listdate(?:--new)?" datetime="(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null,
        remote,
      },
    ];
  });
}

function parseDetail(html: string): LinkedInDetail | null {
  const descriptionHtml =
    html.match(/class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<button|<\/section>)/)?.[1] ??
    html.match(/class="description__text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<ul|<\/section>)/)?.[1];
  if (!descriptionHtml?.trim()) return null;
  const criteria: Record<string, string> = {};
  for (const [, label, value] of html.matchAll(/<h3 class="description__job-criteria-subheader">\s*([\s\S]*?)\s*<\/h3>\s*<span[^>]*>\s*([\s\S]*?)\s*<\/span>/g)) {
    const key = textOf(label);
    if (key) criteria[key] = textOf(value) ?? "";
  }
  return { descriptionHtml: descriptionHtml.trim(), criteria };
}

function textOf(html: string | undefined): string | null {
  return html ? htmlToText(html) || null : null;
}
