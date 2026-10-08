import { and, eq, inArray } from "drizzle-orm";
import { jobSources, rawJobRecords } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { JobSourceAdapter, JobSourceDescriptor, NormalizedJobFields, RawJob } from "./adapter.js";
import { errorMessage, ingestFromSource } from "./ingest.js";
import { summarize } from "./run.js";
import { politeFetch } from "./sources/shared.js";

/** One search on a job site, e.g. "Backend Engineer" in "Tel Aviv". */
export interface JobQuery {
  keywords: string;
  /** A place to search in; null searches the source's default area (Israel for the Israeli boards). */
  location: string | null;
}

export interface SearchContext {
  fetch: typeof fetch;
  signal?: AbortSignal;
  /** At most this many postings per query. */
  limit: number;
}

/** A job site searched by keywords rather than collected whole; adapters never touch the database. */
export interface JobSearchSource<TPayload = unknown> {
  readonly source: JobSourceDescriptor;
  /** Least time between two requests to the site. */
  readonly requestIntervalMs: number;
  /** Newest matching postings first; every record needs an `externalId`. */
  search(query: JobQuery, ctx: SearchContext): Promise<RawJob<TPayload>[]>;
  /** Fills in a listed posting from its own page when the result list lacks the description; null when it is gone or closed. */
  details?(listed: RawJob<TPayload>, ctx: SearchContext): Promise<RawJob<TPayload> | null>;
  normalize(raw: RawJob<TPayload>): NormalizedJobFields | null;
}

/** The site refused us (403, captcha, login wall or rate limit); the rest of this run skips it. */
export class SourceBlockedError extends Error {}

export const DEFAULT_RESULTS_PER_QUERY = 25;
export const DEFAULT_DETAILS_PER_SOURCE = 40;

export interface SiteSearchOptions {
  now?: () => Date;
  fetch?: typeof fetch;
  /** No new request starts after this time. */
  deadline?: Date;
  resultsPerQuery?: number;
  /** Per source and run, new postings whose page is fetched for the description; known postings are never refetched. */
  detailsPerSource?: number;
}

export interface SiteSearchSourceReport {
  source: string;
  queries: number;
  listed: number;
  /** Postings already stored from this source, skipped without fetching them again. */
  known: number;
  detailed: number;
  /** New postings left for the next run because of the details budget or the deadline. */
  deferred: number;
  blocked: boolean;
  ingest: ReturnType<typeof summarize>;
}

export interface SiteSearchReport {
  queries: JobQuery[];
  sources: SiteSearchSourceReport[];
  errors: { scope: string; error: string }[];
  durationMs: number;
}

/**
 * Runs every query on every enabled job site in parallel (one site's requests stay sequential), skips postings already
 * stored, fetches details for new ones within budget and ingests them under each site's own source.
 */
export async function runSiteSearch(
  db: Db,
  sources: readonly JobSearchSource<any>[],
  queries: readonly JobQuery[],
  options: SiteSearchOptions = {},
): Promise<SiteSearchReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const reports = await Promise.all(sources.map((source) => searchOne(db, source, queries, options, now)));
  return {
    queries: [...queries],
    sources: reports,
    errors: reports.flatMap((r) => r.errors),
    durationMs: now().getTime() - startedAt.getTime(),
  };
}

async function searchOne<T>(
  db: Db,
  search: JobSearchSource<T>,
  queries: readonly JobQuery[],
  options: SiteSearchOptions,
  now: () => Date,
): Promise<SiteSearchSourceReport & { errors: { scope: string; error: string }[] }> {
  const key = search.source.key;
  const pastDeadline = () => options.deadline !== undefined && now() >= options.deadline;
  const ctx = {
    fetch: siteFetch(key, options.fetch ?? globalThis.fetch, search.requestIntervalMs),
    limit: options.resultsPerQuery ?? DEFAULT_RESULTS_PER_QUERY,
  };
  const stats = { queries: 0, listed: 0, known: 0, detailed: 0, deferred: 0, blocked: false };
  let budget = options.detailsPerSource ?? DEFAULT_DETAILS_PER_SOURCE;

  const adapter: JobSourceAdapter<T> = {
    source: search.source,
    normalize: (raw) => search.normalize(raw),
    async *collect({ reportError }) {
      const seen = new Set<string>();
      const perQuery: RawJob<T>[][] = [];
      for (const query of queries) {
        if (pastDeadline()) break;
        let listed: RawJob<T>[];
        try {
          stats.queries++;
          listed = await search.search(query, ctx);
        } catch (error) {
          if (error instanceof SourceBlockedError) {
            stats.blocked = true;
            reportError("blocked", error);
            return;
          }
          reportError(`query:${query.keywords}`, error);
          continue;
        }
        const fresh = listed.filter((raw) => raw.externalId && !seen.has(raw.externalId) && seen.add(raw.externalId));
        stats.listed += fresh.length;
        const known = await knownIds(db, key, fresh.map((r) => r.externalId!));
        stats.known += known.size;
        const unknown = fresh.filter((r) => !known.has(r.externalId!));
        if (search.details) perQuery.push(unknown);
        else yield* unknown;
      }

      for (const raw of roundRobin(perQuery)) {
        if (budget <= 0 || pastDeadline()) {
          stats.deferred++;
          continue;
        }
        budget--;
        try {
          stats.detailed++;
          const full = await search.details!(raw, ctx);
          if (full) yield full;
        } catch (error) {
          if (error instanceof SourceBlockedError) {
            stats.blocked = true;
            reportError("blocked", error);
            return;
          }
          reportError(`posting:${raw.externalId}`, error);
        }
      }
    },
  };

  try {
    const ingest = await ingestFromSource(db, adapter, { now, fetch: ctx.fetch });
    return { source: key, ...stats, ingest: summarize(ingest), errors: ingest.errors.map((e) => ({ scope: `${key}:${e.scope}`, error: e.error })) };
  } catch (error) {
    const failed = summarize({
      source: key,
      disabled: false,
      fetched: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      invalid: [],
      failed: [],
      errors: [{ scope: "ingest", error: errorMessage(error) }],
      durationMs: 0,
    });
    return { source: key, ...stats, ingest: failed, errors: [{ scope: `${key}:ingest`, error: errorMessage(error) }] };
  }
}

/** Postings already stored for the source, including ones whose raw record never became a job. */
async function knownIds(db: Db, sourceKey: string, externalIds: string[]): Promise<Set<string>> {
  if (externalIds.length === 0) return new Set();
  const rows = await db
    .select({ externalId: rawJobRecords.externalId })
    .from(rawJobRecords)
    .innerJoin(jobSources, eq(jobSources.id, rawJobRecords.sourceId))
    .where(and(eq(jobSources.key, sourceKey), inArray(rawJobRecords.externalId, externalIds)));
  return new Set(rows.map((r) => r.externalId!));
}

/** One posting from each query in turn, so early queries cannot use up the details budget. */
function* roundRobin<T>(lists: T[][]): Generator<T> {
  for (let i = 0; lists.some((list) => i < list.length); i++) {
    for (const list of lists) if (i < list.length) yield list[i]!;
  }
}

const siteFetches = new Map<string, { base: typeof fetch; polite: typeof fetch }>();

/** One request queue per site within this instance, shared by concurrent searches. */
function siteFetch(key: string, base: typeof fetch, minIntervalMs: number): typeof fetch {
  const cached = siteFetches.get(key);
  if (cached?.base === base) return cached.polite;
  const polite = politeFetch(base, { minIntervalMs });
  siteFetches.set(key, { base, polite });
  return polite;
}
