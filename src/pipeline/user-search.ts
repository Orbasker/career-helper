import { and, count, eq } from "drizzle-orm";
import type { MatchSummary } from "../app/services.js";
import { matches } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { JobDiscoverer } from "../discovery/plan.js";
import { profileJobQueries } from "../discovery/queries.js";
import { runDiscovery, type DiscoveryReport } from "../discovery/run.js";
import type { JobSourceAdapter } from "../ingestion/adapter.js";
import { deduplicateJobs } from "../ingestion/dedup.js";
import { errorMessage } from "../ingestion/ingest.js";
import { runSiteSearch, type JobSearchSource, type SiteSearchReport } from "../ingestion/search.js";
import { runDeepMatching, type DeepMatcher } from "../matching/deep-match.js";
import { runCheapMatching } from "../matching/run.js";
import { runNotifications, type NotificationThreshold } from "./notify.js";

export interface UserSearchDeps {
  boardAdapters: readonly JobSourceAdapter<any>[];
  searchSources: readonly JobSearchSource<any>[];
  /** Omitted to search only the job sites. */
  discoverer?: JobDiscoverer;
  matcher: DeepMatcher;
}

export interface UserSearchOptions {
  now?: () => Date;
  fetch?: typeof fetch;
  threshold?: NotificationThreshold;
  /** No search request starts later than this after the search began. */
  searchCutoffMs?: number;
  /** No deep match starts later than this after the search began. */
  matchCutoffMs?: number;
  deepMatchLimit?: number;
  digestSize?: number;
}

export const USER_SEARCH_CUTOFF_MS = 100_000;
export const USER_MATCH_CUTOFF_MS = 200_000;
export const USER_DEEP_MATCH_LIMIT = 15;
export const USER_DIGEST_SIZE = 8;
const USER_QUERIES = 3;

export interface UserSearchSourceResult {
  source: string;
  name: string;
  /** Postings the site returned for the user's queries. */
  listed: number;
  /** Postings stored for the first time. */
  added: number;
  blocked: boolean;
  failed: boolean;
}

export interface UserSearchResult {
  sources: UserSearchSourceResult[];
  /** Postings the web search found and read; null when web search did not run. */
  webPostings: number | null;
  /** Best new matches, already marked as sent. */
  matches: MatchSummary[];
  /** Further matches that qualified but did not fit in this reply. */
  remaining: number;
  /** Jobs still waiting for a deep match, picked up by the daily run. */
  pendingMatches: number;
  errors: { scope: string; error: string }[];
}

/**
 * Searches every job site and the web for one user right now, then matches what was found against their profile and
 * returns the best new matches. Bounded by `searchCutoffMs` and `matchCutoffMs` so it fits one function invocation.
 */
export async function runUserSearch(
  db: Db,
  deps: UserSearchDeps,
  userId: string,
  keywords: string | null,
  options: UserSearchOptions = {},
): Promise<UserSearchResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const searchDeadline = new Date(startedAt + (options.searchCutoffMs ?? USER_SEARCH_CUTOFF_MS));
  const matchDeadline = new Date(startedAt + (options.matchCutoffMs ?? USER_MATCH_CUTOFF_MS));
  const errors: UserSearchResult["errors"] = [];
  const keywordsOption = keywords?.trim() || undefined;

  const queries = await profileJobQueries(db, { userIds: [userId], keywords: keywordsOption, queriesPerUser: USER_QUERIES });
  const [sites, web] = await Promise.all([
    runSiteSearch(db, deps.searchSources, queries, { now, fetch: options.fetch, deadline: searchDeadline }).catch(
      (error): SiteSearchReport => (errors.push({ scope: "site_search", error: errorMessage(error) }), emptySites()),
    ),
    deps.discoverer
      ? runDiscovery(db, deps.discoverer, deps.boardAdapters, {
          now,
          fetch: options.fetch,
          deadline: searchDeadline,
          userIds: [userId],
          keywords: keywordsOption,
          queriesPerUser: USER_QUERIES,
        }).catch((error): DiscoveryReport | null => (errors.push({ scope: "web_search", error: errorMessage(error) }), null))
      : Promise.resolve(null),
  ]);
  errors.push(...sites.errors);
  if (web) errors.push(...web.errors.filter((e) => !e.scope.startsWith("page:")));

  await deduplicateJobs(db, { now });
  const cheap = await runCheapMatching(db, { now, userIds: [userId] });
  errors.push(...cheap.errors.map((e) => ({ scope: "cheap_matching", error: e.error })));
  const deep = await runDeepMatching(db, deps.matcher, {
    now,
    userIds: [userId],
    limit: options.deepMatchLimit ?? USER_DEEP_MATCH_LIMIT,
    deadline: matchDeadline,
  });
  errors.push(...deep.errors.map((e) => ({ scope: `deep_match:${e.matchId}`, error: e.error })));

  const found: MatchSummary[] = [];
  let remaining = 0;
  await runNotifications(
    db,
    {
      sendDigest: async (_chatId, matches, rest) => {
        found.push(...matches);
        remaining = rest;
      },
    },
    { now, threshold: options.threshold, digestSize: options.digestSize ?? USER_DIGEST_SIZE, userIds: [userId] },
  );

  return {
    sources: sites.sources.filter((s) => !s.ingest.disabled).map((s) => ({
      source: s.source,
      name: deps.searchSources.find((source) => source.source.key === s.source)?.source.name ?? s.source,
      listed: s.listed,
      added: s.ingest.inserted,
      blocked: s.blocked,
      failed: !s.blocked && s.ingest.errors > 0,
    })),
    webPostings: web ? web.postings : null,
    matches: found,
    remaining,
    pendingMatches: await pendingMatchCount(db, userId),
    errors,
  };
}

async function pendingMatchCount(db: Db, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(matches)
    .where(and(eq(matches.userId, userId), eq(matches.status, "pending"), eq(matches.stageReached, "cheap_relevance")));
  return row?.n ?? 0;
}

function emptySites(): SiteSearchReport {
  return { queries: [], sources: [], errors: [], durationMs: 0 };
}
