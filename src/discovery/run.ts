import { asc, eq, inArray } from "drizzle-orm";
import { loadSnapshot } from "../app/postgres/profile.js";
import { careerProfiles, jobSources, jobs, userJobSites } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { EmploymentType, WorkMode } from "../domain/enums.js";
import type { JobSourceAdapter, RawJob } from "../ingestion/adapter.js";
import { errorMessage, ingestFromSource } from "../ingestion/ingest.js";
import { normalizeCompany } from "../ingestion/normalize.js";
import { summarize } from "../ingestion/run.js";
import { addBoards, atsBoardFromUrl, type AtsBoard } from "./ats.js";
import { RobotsCache, fetchPage, jobPostingFromJsonLd, pageText } from "./page.js";
import { DEFAULT_QUERIES_PER_USER, searchPlan, type JobCandidate, type JobDiscoverer } from "./plan.js";

export const WEB_SEARCH_SOURCE_KEY = "web_search";
export const DEFAULT_MAX_PAGES = 25;

export interface WebPostingPayload {
  url: string;
  foundBy: { userId: string; site: boolean };
  method: "json_ld" | "llm";
  job: {
    title: string;
    description: string;
    company: string | null;
    location: string | null;
    workMode: WorkMode | null;
    employmentType: EmploymentType | null;
    publishedAt: string | null;
  };
}

/** An in-memory source over postings the agent already found and read, so they go through normal ingestion. */
export function webSearchAdapter(records: readonly RawJob<WebPostingPayload>[]): JobSourceAdapter<WebPostingPayload> {
  return {
    source: { key: WEB_SEARCH_SOURCE_KEY, name: "Agent web search", kind: "web_search" },
    collect: () => records,
    normalize: ({ payload: { job } }) => ({ ...job, publishedAt: job.publishedAt ? new Date(job.publishedAt) : null }),
  };
}

export interface DiscoveryOptions {
  now?: () => Date;
  fetch?: typeof fetch;
  /** No new search or page fetch starts after this time. */
  deadline?: Date;
  queriesPerUser?: number;
  maxPages?: number;
}

export interface DiscoveryReport {
  disabled: boolean;
  users: number;
  /** Users whose open and site searches all completed without error. */
  searchedUsers: string[];
  searches: number;
  candidates: number;
  boardsAdded: string[];
  pagesFetched: number;
  postings: number;
  companies: number;
  skipped: { known: number; robots: number; notPosting: number; closed: number; overBudget: number };
  ingest: ReturnType<typeof summarize> | null;
  errors: { scope: string; error: string }[];
  durationMs: number;
}

interface Found extends JobCandidate {
  userId: string;
  site: boolean;
}

/**
 * For every confirmed profile, searches the open web and the user's own sites for postings. Links to supported ATS
 * boards become basic board sources; other new postings are fetched (respecting robots.txt), read from their
 * JobPosting data or by the model, and ingested as the `web_search` source.
 */
export async function runDiscovery(
  db: Db,
  discoverer: JobDiscoverer,
  boardAdapters: readonly JobSourceAdapter<any>[],
  options: DiscoveryOptions = {},
): Promise<DiscoveryReport> {
  const now = options.now ?? (() => new Date());
  const fetcher = options.fetch ?? globalThis.fetch;
  const startedAt = now();
  const report: DiscoveryReport = {
    disabled: false,
    users: 0,
    searchedUsers: [],
    searches: 0,
    candidates: 0,
    boardsAdded: [],
    pagesFetched: 0,
    postings: 0,
    companies: 0,
    skipped: { known: 0, robots: 0, notPosting: 0, closed: 0, overBudget: 0 },
    ingest: null,
    errors: [],
    durationMs: 0,
  };
  const pastDeadline = () => options.deadline !== undefined && now() >= options.deadline;
  const finish = () => ((report.durationMs = now().getTime() - startedAt.getTime()), report);

  const [source] = await db
    .select({ isEnabled: jobSources.isEnabled })
    .from(jobSources)
    .where(eq(jobSources.key, WEB_SEARCH_SOURCE_KEY));
  if (source && !source.isEnabled) {
    report.disabled = true;
    return finish();
  }

  const profiles = await db
    .select({ userId: careerProfiles.userId })
    .from(careerProfiles)
    .where(eq(careerProfiles.status, "confirmed"))
    .orderBy(asc(careerProfiles.createdAt));
  const found = new Map<string, Found>();
  for (const { userId } of profiles) {
    if (pastDeadline()) break;
    report.users++;
    try {
      const profile = await loadSnapshot(db, userId, { verifiedOnly: true });
      const sites = await db
        .select({ domain: userJobSites.domain })
        .from(userJobSites)
        .where(eq(userJobSites.userId, userId))
        .orderBy(asc(userJobSites.createdAt));
      const open = searchPlan(profile, [], options.queriesPerUser ?? DEFAULT_QUERIES_PER_USER);
      const plans = sites.length ? [open, { ...open, domains: sites.map((s) => s.domain) }] : [open];
      let searched = 0;
      for (const plan of plans) {
        if (pastDeadline()) break;
        report.searches++;
        for (const candidate of await discoverer.search(plan)) {
          if (!found.has(candidate.url)) found.set(candidate.url, { ...candidate, userId, site: plan.domains.length > 0 });
        }
        searched++;
      }
      if (searched === plans.length) report.searchedUsers.push(userId);
    } catch (error) {
      report.errors.push({ scope: `user:${userId}`, error: errorMessage(error) });
    }
  }
  report.candidates = found.size;

  const boards: AtsBoard[] = [];
  const pages: Found[] = [];
  for (const candidate of found.values()) {
    const board = atsBoardFromUrl(candidate.url);
    if (board) boards.push(board);
    else pages.push(candidate);
  }
  try {
    report.boardsAdded = (await addBoards(db, boardAdapters, boards)).map((b) => `${b.source}:${b.token}`);
  } catch (error) {
    report.errors.push({ scope: "boards", error: errorMessage(error) });
  }

  const known = new Set(
    pages.length
      ? (
          await db
            .select({ url: jobs.sourceUrl })
            .from(jobs)
            .where(inArray(jobs.sourceUrl, pages.map((p) => p.url)))
        ).map((r) => r.url)
      : [],
  );
  const robots = new RobotsCache(fetcher);
  const records: RawJob<WebPostingPayload>[] = [];
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  for (const candidate of pages) {
    if (known.has(candidate.url)) {
      report.skipped.known++;
      continue;
    }
    if (report.pagesFetched >= maxPages || pastDeadline()) {
      report.skipped.overBudget++;
      continue;
    }
    try {
      if (!(await robots.allows(candidate.url))) {
        report.skipped.robots++;
        continue;
      }
      report.pagesFetched++;
      const page = await fetchPage(candidate.url, fetcher);
      if (!page) {
        report.skipped.notPosting++;
        continue;
      }
      let method: WebPostingPayload["method"] = "json_ld";
      let check = jobPostingFromJsonLd(page.html, now());
      if (check.kind === "none") {
        method = "llm";
        check = await discoverer.extract({ url: page.url, text: pageText(page.html) });
      }
      if (check.kind === "closed") report.skipped.closed++;
      if (check.kind !== "posting") {
        if (check.kind === "none") report.skipped.notPosting++;
        continue;
      }
      const { fields } = check;
      records.push({
        sourceUrl: page.url,
        payload: {
          url: page.url,
          foundBy: { userId: candidate.userId, site: candidate.site },
          method,
          job: {
            title: fields.title,
            description: fields.description,
            company: fields.company ?? candidate.company,
            location: fields.location ?? null,
            workMode: fields.workMode ?? null,
            employmentType: fields.employmentType ?? null,
            publishedAt: fields.publishedAt?.toISOString() ?? null,
          },
        },
      });
    } catch (error) {
      report.errors.push({ scope: `page:${candidate.url}`, error: errorMessage(error) });
    }
  }

  report.postings = records.length;
  report.companies = new Set(records.map((r) => normalizeCompany(r.payload.job.company)).filter(Boolean)).size;
  if (records.length) {
    const ingest = await ingestFromSource(db, webSearchAdapter(records), { now });
    report.ingest = summarize(ingest);
    report.errors.push(...ingest.errors);
  }
  return finish();
}

/** Reads `DISCOVERY_QUERIES_PER_USER` and `DISCOVERY_MAX_PAGES`; `DISCOVERY_ENABLED=false` turns discovery off. */
export function discoverySettingsFromEnv(env: Record<string, string | undefined> = process.env) {
  const positive = (name: string) => {
    const raw = env[name];
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  return {
    enabled: env.DISCOVERY_ENABLED !== "false",
    queriesPerUser: positive("DISCOVERY_QUERIES_PER_USER"),
    maxPages: positive("DISCOVERY_MAX_PAGES"),
  };
}
