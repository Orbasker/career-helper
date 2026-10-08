import type { EmploymentType, WorkMode } from "../../domain/enums.js";
import type { RawJob } from "../adapter.js";
import { SourceBlockedError, type JobQuery, type JobSearchSource, type SearchContext } from "../search.js";
import { BLOCKED_STATUSES, dateFrom, employmentTypeFrom, fetchText, htmlToText, workModeFrom } from "./shared.js";

export interface AlljobsJob {
  id: string;
  title: string;
  company: string | null;
  cities: string[];
  /** The listed job types, e.g. "משרה מלאה ועבודה היברידית" or "Full Time". */
  types: string[];
  /** The description and requirements as the list shows them, in HTML. */
  description: string;
  /** When the list said it was posted, resolved against the time of the search. */
  postedAt: string | null;
  /** Found through the "work from home" region. */
  remote: boolean;
}

interface LocationFilter {
  city?: string;
  region?: string;
}

const SITE = "https://www.alljobs.co.il";
const SEARCH = `${SITE}/SearchResultsGuest.aspx`;
/** The cookie the site's own "newest first" sort button sets. */
const NEWEST_FIRST = `sort=${encodeURIComponent(JSON.stringify({ ID: 1, longitude: 0, latitude: 0 }))}`;
const MAX_PAGES = 10;
const MAX_CITIES = 3;
const WORK_FROM_HOME_REGION = "11";
const BLOCK_PAGE = /captcha|incapsula|cf-chl|access denied|request unsuccessful/i;
const LOGIN_URL = /\/auth\/login|captcha/i;

const CITY_IDS: Record<string, string> = {
  "tel aviv": "779",
  "tel aviv yafo": "779",
  "tel aviv jaffa": "779",
  "תל אביב": "779",
  "תל אביב יפו": "779",
  jerusalem: "1056",
  ירושלים: "1056",
  herzliya: "712",
  הרצליה: "712",
  "ramat gan": "789",
  "רמת גן": "789",
  "petah tikva": "786",
  "petach tikva": "786",
  "פתח תקווה": "786",
  "פתח תקוה": "786",
  netanya: "717",
  נתניה: "717",
  "rishon lezion": "787",
  "rishon letsiyon": "787",
  "ראשון לציון": "787",
  rehovot: "948",
  רחובות: "948",
  ashdod: "802",
  אשדוד: "802",
  "bnei brak": "780",
  "בני ברק": "780",
};

const REGION_IDS: Record<string, string> = {
  haifa: "1",
  חיפה: "1",
  center: "2",
  "central israel": "2",
  מרכז: "2",
  south: "7",
  דרום: "7",
  north: "10",
  צפון: "10",
  remote: WORK_FROM_HOME_REGION,
  "work from home": WORK_FROM_HOME_REGION,
  wfh: WORK_FROM_HOME_REGION,
  מהבית: WORK_FROM_HOME_REGION,
  "עבודה מהבית": WORK_FROM_HOME_REGION,
};

const MINUTE = 60_000;
const AGO_UNITS: [RegExp, number][] = [
  [/דקות|דקה/, MINUTE],
  [/שעות|שעה/, 60 * MINUTE],
  [/ימים|יום/, 24 * 60 * MINUTE],
  [/שבועות|שבוע/, 7 * 24 * 60 * MINUTE],
];

/** AllJobs' public guest search pages, newest first, with full descriptions in the list. */
export const alljobsSource: JobSearchSource<AlljobsJob> = {
  source: { key: "alljobs", name: "AllJobs", kind: "scraper", baseUrl: SITE },
  requestIntervalMs: 1_000,

  async search(query: JobQuery, ctx: SearchContext): Promise<RawJob<AlljobsJob>[]> {
    const filter = locationFilter(query.location);
    const remote = filter.region === WORK_FROM_HOME_REGION;
    const now = new Date();
    const seen = new Set<string>();
    const found: RawJob<AlljobsJob>[] = [];
    for (let page = 1; page <= MAX_PAGES && found.length < ctx.limit; page++) {
      const response = await fetchText(ctx, alljobsSearchUrl(query.keywords, filter, page), { headers: { cookie: NEWEST_FIRST } });
      if (BLOCKED_STATUSES.has(response.status)) throw new SourceBlockedError(`AllJobs answered ${response.status}`);
      if (LOGIN_URL.test(new URL(response.url, SITE).pathname)) throw new SourceBlockedError("AllJobs redirected to a login or captcha page");
      if (!response.ok) throw new Error(`AllJobs search failed with ${response.status}`);
      const jobs = parseAlljobsPage(response.text, now);
      if (jobs.length === 0 && BLOCK_PAGE.test(response.text)) throw new SourceBlockedError("AllJobs answered with a security check");
      let added = 0;
      for (const job of jobs) {
        if (seen.has(job.id) || found.length >= ctx.limit) continue;
        seen.add(job.id);
        added++;
        found.push({ externalId: job.id, sourceUrl: alljobsJobUrl(job.id), payload: { ...job, remote } });
      }
      if (added === 0 || !hasPage(response.text, page + 1)) break;
    }
    return found.sort((a, b) => postedTime(b.payload) - postedTime(a.payload));
  },

  normalize({ payload: job }) {
    return {
      title: job.title,
      description: htmlToText(job.description),
      company: job.company,
      location: job.cities.length ? job.cities.slice(0, MAX_CITIES).join(", ") : null,
      workMode: workModeOf(job),
      employmentType: employmentOf(job.types),
      publishedAt: dateFrom(job.postedAt),
    };
  },
};

export function alljobsSearchUrl(keywords: string, filter: LocationFilter, page: number): string {
  const params = new URLSearchParams({
    page: String(page),
    position: "",
    type: "",
    freetxt: keywords.trim(),
    city: filter.city ?? "",
    region: filter.region ?? "",
  });
  return `${SEARCH}?${params}`;
}

export function alljobsJobUrl(id: string): string {
  return `${SITE}/Search/UploadSingle.aspx?JobID=${id}`;
}

export function locationFilter(location: string | null): LocationFilter {
  if (!location) return {};
  const key = location
    .split(",")[0]!
    .toLowerCase()
    .replace(/[-_'"׳״()]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ israel$/, "")
    .trim();
  if (CITY_IDS[key]) return { city: CITY_IDS[key] };
  if (REGION_IDS[key]) return { region: REGION_IDS[key] };
  return {};
}

/** Every job box on a result page; relative post times ("לפני 21 שעות", "2 ימים") are resolved against `now`. */
export function parseAlljobsPage(html: string, now: Date): Omit<AlljobsJob, "remote">[] {
  return html
    .split('<div class="job-box job-border')
    .slice(1)
    .flatMap((box) => {
      const id = /<div id="job-box(\d+)">/.exec(box)?.[1] ?? /<div class="jobid-hidden">(\d+)<\/div>/.exec(box)?.[1];
      const heading = /href="\/Search\/UploadSingle\.aspx\?JobID=\d+"[^>]*>(?:<div[^>]*>)?<h2[^>]*>([\s\S]*?)<\/h2>/.exec(box)?.[1];
      const title = heading ? htmlToText(heading) : "";
      if (!id || !title) return [];
      const company = /job-content-top-title(?:-ltr)?[^"]*"[\s\S]*?<div class="T14">([\s\S]*?)<\/div>/.exec(box)?.[1];
      const posted = /<div class="job-content-top-date">\s*([^<]*?)\s*<\/div>/.exec(box)?.[1];
      return [
        {
          id,
          title,
          company: (company && htmlToText(company)) || null,
          cities: citiesOf(box),
          types: typesOf(box),
          description: /<div class="job-content-top-desc[^"]*">\s*<div>([\s\S]*?)<\/div>\s*<div><\/div>/.exec(box)?.[1] ?? "",
          postedAt: posted ? (postedDate(posted, now)?.toISOString() ?? null) : null,
        },
      ];
    });
}

function citiesOf(box: string): string[] {
  const block = /job-content-top-location(?:-ltr)?"([\s\S]*?)job-content-top-type/.exec(box)?.[1] ?? "";
  const names = [...block.matchAll(/<a href="\/SearchResultsGuest\.aspx\?[^"]*city=\d+[^"]*"[^>]*>([^<]+)<\/a>/g)].map((m) => htmlToText(m[1]!));
  return [...new Set(names.filter(Boolean))];
}

function typesOf(box: string): string[] {
  const block = /job-content-top-type(?:-ltr)?"([\s\S]*?)(?:job-content-top-acord|job-content-top-desc)/.exec(box)?.[1] ?? "";
  const listed = /job-types-content">([\s\S]*)/.exec(block)?.[1];
  const types = listed
    ? [...listed.matchAll(/<div>([\s\S]*?)<\/div>/g)].map((m) => htmlToText(m[1]!))
    : [htmlToText(/<\/b>([\s\S]*?)<\/div>/.exec(block)?.[1] ?? "")];
  return types.filter(Boolean);
}

function postedDate(label: string, now: Date): Date | null {
  const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(label.trim());
  if (date) return new Date(Date.UTC(Number(date[3]), Number(date[2]) - 1, Number(date[1])));
  for (const [unit, ms] of AGO_UNITS) {
    const ago = new RegExp(`(?:(\\d+)\\s*)?(?:${unit.source})`).exec(label);
    if (ago) return new Date(now.getTime() - Number(ago[1] ?? 1) * ms);
  }
  return null;
}

function hasPage(html: string, page: number): boolean {
  return new RegExp(`SearchResultsGuest\\.aspx\\?page=${page}&`).test(html);
}

function postedTime(job: AlljobsJob): number {
  return job.postedAt ? Date.parse(job.postedAt) : 0;
}

function workModeOf(job: AlljobsJob): WorkMode | null {
  const text = job.types.join(" ");
  if (/עבודה מהבית|work from home|remote/i.test(text)) return "remote";
  if (/היברידי/.test(text)) return "hybrid";
  if (job.remote) return "remote";
  return workModeFrom(text);
}

function employmentOf(types: string[]): EmploymentType | null {
  const text = types.join(" ");
  if (/משרה מלאה/.test(text)) return "full_time";
  if (/משרה חלקית/.test(text)) return "part_time";
  if (/פרילנס|פרי לנס/.test(text)) return "freelance";
  if (/זמנית/.test(text)) return "temporary";
  return employmentTypeFrom(text);
}
