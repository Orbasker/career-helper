import type { Db } from "../db/types.js";
import type { JobSourceAdapter } from "../ingestion/adapter.js";
import type { DedupReport } from "../ingestion/dedup.js";
import { errorMessage } from "../ingestion/ingest.js";
import { jsonLogger, runFailed, runIngestion, summarize, type IngestLogger } from "../ingestion/run.js";
import { runDeepMatching, type DeepMatcher, type DeepMatchingReport } from "../matching/deep-match.js";
import { runCheapMatching, type CheapMatchingReport } from "../matching/run.js";
import { runNotifications, type NotificationOptions, type NotificationReport, type Notifier } from "./notify.js";

export interface DailyPipelineDeps {
  adapters: readonly JobSourceAdapter<any>[];
  matcher: DeepMatcher;
  notifier: Notifier;
}

export const DEFAULT_DEEP_MATCH_BUDGET_MS = 180_000;

export interface DailyPipelineOptions extends NotificationOptions {
  deepMatchLimit?: number;
  deepMatchBudgetMs?: number;
  log?: IngestLogger;
}

export type StageResult<T> = { ok: true; report: T } | { ok: false; error: string };

export interface DailyPipelineReport {
  ingestion: StageResult<{ sources: ReturnType<typeof summarize>[]; dedup: DedupReport; failed: boolean }>;
  cheapMatching: StageResult<CheapMatchingReport>;
  deepMatching: StageResult<DeepMatchingReport>;
  notifications: StageResult<NotificationReport>;
  failed: boolean;
}

/**
 * Collect → normalize → deduplicate → hard filter → cheap relevance → deep match → notify. Every stage is
 * idempotent and runs even when an earlier one failed, so work left over from previous runs still progresses.
 */
export async function runDailyPipeline(
  db: Db,
  deps: DailyPipelineDeps,
  options: DailyPipelineOptions = {},
): Promise<DailyPipelineReport> {
  const log = options.log ?? jsonLogger;
  const now = options.now ?? (() => new Date());
  let failed = false;

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
        deadline: new Date(now().getTime() + (options.deepMatchBudgetMs ?? DEFAULT_DEEP_MATCH_BUDGET_MS)),
      }),
    (r) => r.errors.length > 0,
  );
  const notifications = await stage(
    "notifications",
    () => runNotifications(db, deps.notifier, { ...options, now }),
    (r) => r.errors.length > 0,
  );

  const report: DailyPipelineReport = { ingestion, cheapMatching, deepMatching, notifications, failed };
  log({ event: "pipeline.run", failed });
  return report;
}
