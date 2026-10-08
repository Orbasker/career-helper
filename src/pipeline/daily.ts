import { eq } from "drizzle-orm";
import { pipelineRuns } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { JobDiscoverer } from "../discovery/plan.js";
import { profileJobQueries } from "../discovery/queries.js";
import { runDiscovery, type DiscoveryOptions, type DiscoveryReport } from "../discovery/run.js";
import type { JobSourceAdapter } from "../ingestion/adapter.js";
import type { DedupReport } from "../ingestion/dedup.js";
import { errorMessage } from "../ingestion/ingest.js";
import { runSiteSearch, type JobSearchSource, type SiteSearchOptions, type SiteSearchReport } from "../ingestion/search.js";
import { jsonLogger, runFailed, runIngestion, summarize, type IngestLogger } from "../ingestion/run.js";
import { runDeepMatching, type DeepMatcher, type DeepMatchingReport } from "../matching/deep-match.js";
import { runCheapMatching, type CheapMatchingReport } from "../matching/run.js";
import { runNotifications, type NotificationOptions, type NotificationReport, type Notifier } from "./notify.js";

export interface DailyPipelineDeps {
  adapters: readonly JobSourceAdapter<any>[];
  /** Job sites searched with every profile's queries, alongside web discovery. */
  searchSources?: readonly JobSearchSource<any>[];
  /** Omitted to run only the basic board sources. */
  discoverer?: JobDiscoverer;
  matcher: DeepMatcher;
  notifier: Notifier;
}

/** No deep match starts later than this after the run began, leaving time to notify within the 300s function limit. */
export const DEFAULT_DEEP_MATCH_CUTOFF_MS = 210_000;
/** No web search or page fetch starts later than this after the run began, leaving time for the other stages. */
export const DEFAULT_DISCOVERY_CUTOFF_MS = 90_000;

export interface DailyPipelineOptions extends NotificationOptions {
  deepMatchLimit?: number;
  deepMatchCutoffMs?: number;
  discovery?: Omit<DiscoveryOptions, "now" | "deadline"> & { cutoffMs?: number };
  siteSearch?: Omit<SiteSearchOptions, "now" | "deadline"> & { maxQueries?: number };
  log?: IngestLogger;
}

export type StageResult<T> = { ok: true; report: T } | { ok: false; error: string };

export interface DailyPipelineReport {
  discovery: StageResult<DiscoveryReport> | null;
  siteSearch: StageResult<SiteSearchReport> | null;
  ingestion: StageResult<{ sources: ReturnType<typeof summarize>[]; dedup: DedupReport; failed: boolean }>;
  cheapMatching: StageResult<CheapMatchingReport>;
  deepMatching: StageResult<DeepMatchingReport>;
  notifications: StageResult<NotificationReport>;
  failed: boolean;
}

/**
 * Discover and search job sites → collect → normalize → deduplicate → hard filter → cheap relevance → deep match → notify. Every stage is
 * idempotent and runs even when an earlier one failed, so work left over from previous runs still progresses.
 */
export async function runDailyPipeline(
  db: Db,
  deps: DailyPipelineDeps,
  options: DailyPipelineOptions = {},
): Promise<DailyPipelineReport> {
  const log = options.log ?? jsonLogger;
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const deepMatchDeadline = new Date(startedAt + (options.deepMatchCutoffMs ?? DEFAULT_DEEP_MATCH_CUTOFF_MS));
  const discoveryDeadline = new Date(startedAt + (options.discovery?.cutoffMs ?? DEFAULT_DISCOVERY_CUTOFF_MS));
  let failed = false;
  const runId = await db
    .insert(pipelineRuns)
    .values({ startedAt: new Date(startedAt) })
    .returning({ id: pipelineRuns.id })
    .then(([row]) => row?.id ?? null)
    .catch((error) => (log({ event: "pipeline.audit_failed", error: errorMessage(error) }), null));

  const stage = async <T>(name: string, run: () => Promise<T>, hasErrors: (report: T) => boolean) => {
    let result: StageResult<T>;
    try {
      const report = await run();
      if (hasErrors(report)) failed = true;
      result = { ok: true, report };
    } catch (error) {
      failed = true;
      result = { ok: false, error: errorMessage(error) };
    }
    log({ event: `pipeline.${name}`, ...result });
    return result;
  };

  const { discoverer, searchSources } = deps;
  const [discovery, siteSearch] = await Promise.all([
    discoverer
      ? stage(
          "discovery",
          () => runDiscovery(db, discoverer, deps.adapters, { ...options.discovery, now, deadline: discoveryDeadline }),
          (r) => r.errors.some((e) => !e.scope.startsWith("page:")),
        )
      : null,
    searchSources?.length
      ? stage(
          "site_search",
          async () => {
            const queries = await profileJobQueries(db, {
              queriesPerUser: options.discovery?.queriesPerUser,
              maxQueries: options.siteSearch?.maxQueries,
              rotation: Math.floor(startedAt / 86_400_000),
            });
            return runSiteSearch(db, searchSources, queries, { ...options.siteSearch, now, deadline: discoveryDeadline });
          },
          (r) => r.sources.some((source) => source.ingest.errors > 0 && !source.blocked),
        )
      : null,
  ]);
  const ingestion = await stage(
    "ingestion",
    async () => {
      const run = await runIngestion(db, deps.adapters, { now, log });
      return { sources: run.sources.map(summarize), dedup: run.dedup, failed: runFailed(run) };
    },
    (report) => report.failed,
  );
  const cheapMatching = await stage("cheap_matching", () => runCheapMatching(db, { now }), (r) => r.errors.length > 0);
  const deepMatching = await stage(
    "deep_matching",
    () =>
      runDeepMatching(db, deps.matcher, {
        now,
        limit: options.deepMatchLimit,
        deadline: deepMatchDeadline,
      }),
    (r) => r.errors.length > 0,
  );
  const notifications = await stage(
    "notifications",
    () => runNotifications(db, deps.notifier, { ...options, now }),
    (r) => r.errors.length > 0,
  );

  const report: DailyPipelineReport = { discovery, siteSearch, ingestion, cheapMatching, deepMatching, notifications, failed };
  log({ event: "pipeline.run", failed });
  if (runId) {
    await db
      .update(pipelineRuns)
      .set({ finishedAt: now(), failed, report: report as unknown as Record<string, unknown> })
      .where(eq(pipelineRuns.id, runId))
      .catch((error) => log({ event: "pipeline.audit_failed", error: errorMessage(error) }));
  }
  return report;
}
