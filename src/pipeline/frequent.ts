import type { Db } from "../db/types.js";
import { jsonLogger, type IngestLogger } from "../ingestion/run.js";
import { runDeepMatching, type DeepMatcher, type DeepMatchingReport } from "../matching/deep-match.js";
import { DEFAULT_DEEP_MATCH_CUTOFF_MS, runStage, type StageResult } from "./daily.js";
import { runNotifications, type NotificationOptions, type NotificationReport, type Notifier } from "./notify.js";

export interface MatchAndNotifyOptions extends NotificationOptions {
  deepMatchLimit?: number;
  deepMatchCutoffMs?: number;
  log?: IngestLogger;
}

export interface MatchAndNotifyReport {
  deepMatching: StageResult<DeepMatchingReport>;
  notifications: StageResult<NotificationReport>;
  failed: boolean;
}

/** Works through the deep-match backlog and pushes what qualifies, between the daily runs that ingest new jobs. */
export async function runMatchAndNotify(
  db: Db,
  deps: { matcher: DeepMatcher; notifier: Notifier },
  options: MatchAndNotifyOptions = {},
): Promise<MatchAndNotifyReport> {
  const log = options.log ?? jsonLogger;
  const now = options.now ?? (() => new Date());
  const deadline = new Date(now().getTime() + (options.deepMatchCutoffMs ?? DEFAULT_DEEP_MATCH_CUTOFF_MS));

  const deepMatching = await runStage(
    "deep_matching",
    () => runDeepMatching(db, deps.matcher, { now, limit: options.deepMatchLimit, deadline }),
    log,
  );
  const notifications = await runStage("notifications", () => runNotifications(db, deps.notifier, { ...options, now }), log);

  const failed =
    !deepMatching.ok || deepMatching.report.errors.length > 0 || !notifications.ok || notifications.report.errors.length > 0;
  log({ event: "pipeline.match_and_notify", failed });
  return { deepMatching, notifications, failed };
}
