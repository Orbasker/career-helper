import type { Db } from "../db/types.js";
import type { JobSourceAdapter } from "./adapter.js";
import { deduplicateJobs, emptyDedupReport, type DedupReport } from "./dedup.js";
import { emptyReport, errorMessage, ingestFromSource, type IngestOptions, type IngestReport } from "./ingest.js";

export type IngestLogger = (entry: Record<string, unknown>) => void;

export interface RunIngestionOptions extends IngestOptions {
  log?: IngestLogger;
}

export interface IngestionRun {
  sources: IngestReport[];
  dedup: DedupReport;
}

export const jsonLogger: IngestLogger = (entry) => console.log(JSON.stringify(entry));

/** Ingests every adapter in turn, then groups duplicates; a failing source is reported and never stops the others. */
export async function runIngestion(
  db: Db,
  adapters: readonly JobSourceAdapter<any>[],
  options: RunIngestionOptions = {},
): Promise<IngestionRun> {
  const log = options.log ?? jsonLogger;
  const reports: IngestReport[] = [];
  for (const adapter of adapters) {
    let report: IngestReport;
    try {
      report = await ingestFromSource(db, adapter, options);
    } catch (error) {
      report = { ...emptyReport(adapter.source.key), errors: [{ scope: "ingest", error: errorMessage(error) }] };
    }
    log({ event: "ingest.source", ...summarize(report), invalid: report.invalid, failed: report.failed, errors: report.errors });
    reports.push(report);
  }

  let dedup: DedupReport;
  try {
    dedup = await deduplicateJobs(db, options);
  } catch (error) {
    dedup = { ...emptyDedupReport(), error: errorMessage(error) };
  }
  log({ event: "dedup.run", ...dedup });
  log({ event: "ingest.run", sources: reports.map(summarize), dedup });
  return { sources: reports, dedup };
}

export function runFailed(run: IngestionRun): boolean {
  return run.dedup.error !== null || run.sources.some((r) => r.errors.length > 0);
}

export function summarize(report: IngestReport) {
  return {
    source: report.source,
    ok: report.errors.length === 0,
    disabled: report.disabled,
    fetched: report.fetched,
    inserted: report.inserted,
    updated: report.updated,
    unchanged: report.unchanged,
    skipped: report.skipped,
    invalid: report.invalid.length,
    failed: report.failed.length,
    errors: report.errors.length,
    errorScopes: report.errors.map((e) => e.scope),
    durationMs: report.durationMs,
  };
}
