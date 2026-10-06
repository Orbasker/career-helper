import { and, eq, sql } from "drizzle-orm";
import { jobSources, jobs, rawJobRecords } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { contentHash, toCanonicalJob, type JobSourceAdapter, type RawJob } from "./adapter.js";
import type { CanonicalJob } from "./canonical-job.js";
import { normalizeJobKey } from "./normalize.js";

export interface IngestOptions {
  now?: () => Date;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface IngestReport {
  source: string;
  disabled: boolean;
  fetched: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  invalid: { sourceUrl: string; issues: string[] }[];
  failed: { sourceUrl: string; error: string }[];
  errors: { scope: string; error: string }[];
  durationMs: number;
}

type JobWrite = "inserted" | "updated" | "unchanged";

export async function ingestFromSource<TPayload>(
  db: Db,
  adapter: JobSourceAdapter<TPayload>,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const now = options.now ?? (() => new Date());
  const { key, name, kind, baseUrl } = adapter.source;
  const report = emptyReport(key);

  const [source] = await db
    .insert(jobSources)
    .values({ key, name, kind, baseUrl })
    .onConflictDoUpdate({ target: jobSources.key, set: { name, kind, baseUrl: baseUrl ?? null } })
    .returning();
  if (!source!.isEnabled) return { ...report, disabled: true };

  const startedAt = now();
  try {
    const records = adapter.collect({
      since: source!.lastCollectedAt,
      config: source!.config,
      fetch: options.fetch ?? globalThis.fetch,
      signal: options.signal,
      reportError: (scope, error) => report.errors.push({ scope, error: errorMessage(error) }),
    });
    for await (const raw of records) {
      report.fetched++;
      try {
        const rawRecordId = await storeRawRecord(db, source!.id, raw);
        const result = toCanonicalJob(adapter, raw, now());
        if (result.ok === "skipped") report.skipped++;
        else if (!result.ok) report.invalid.push({ sourceUrl: raw.sourceUrl, issues: result.issues });
        else report[await upsertJob(db, source!.id, rawRecordId, result.job)]++;
      } catch (error) {
        report.failed.push({ sourceUrl: raw.sourceUrl, error: errorMessage(error) });
      }
    }
  } catch (error) {
    report.errors.push({ scope: "collect", error: errorMessage(error) });
  }

  if (!report.errors.length) {
    await db.update(jobSources).set({ lastCollectedAt: startedAt }).where(eq(jobSources.id, source!.id));
  }
  report.durationMs = now().getTime() - startedAt.getTime();
  return report;
}

export function emptyReport(source: string): IngestReport {
  return {
    source,
    disabled: false,
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    invalid: [],
    failed: [],
    errors: [],
    durationMs: 0,
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function storeRawRecord(db: Db, sourceId: string, raw: RawJob): Promise<string> {
  const hash = contentHash(raw);
  const [created] = await db
    .insert(rawJobRecords)
    .values({
      sourceId,
      externalId: raw.externalId ?? null,
      sourceUrl: raw.sourceUrl,
      contentHash: hash,
      payload: raw.payload,
    })
    .onConflictDoNothing({ target: [rawJobRecords.sourceId, rawJobRecords.contentHash] })
    .returning({ id: rawJobRecords.id });
  if (created) return created.id;

  const [existing] = await db
    .select({ id: rawJobRecords.id })
    .from(rawJobRecords)
    .where(and(eq(rawJobRecords.sourceId, sourceId), eq(rawJobRecords.contentHash, hash)));
  return existing!.id;
}

async function upsertJob(db: Db, sourceId: string, rawRecordId: string, job: CanonicalJob): Promise<JobWrite> {
  const target = job.externalId
    ? { target: [jobs.sourceId, jobs.externalId], targetWhere: sql`${jobs.externalId} is not null` }
    : { target: [jobs.sourceId, jobs.sourceUrl] };
  const regroup = sql`${jobs.dedupMethod} is distinct from 'manual' and (${jobs.normalizedTitle}, ${jobs.normalizedCompany}, ${jobs.normalizedLocation}) is distinct from (excluded.normalized_title, excluded.normalized_company, excluded.normalized_location)`;

  const [row] = await db
    .insert(jobs)
    .values({
      sourceId,
      rawRecordId,
      externalId: job.externalId,
      sourceUrl: job.sourceUrl,
      title: job.title,
      company: job.company,
      description: job.description,
      location: job.location,
      workMode: job.workMode,
      employmentType: job.employmentType,
      publishedAt: job.publishedAt,
      collectedAt: job.collectedAt,
      ...normalizeJobKey(job),
    })
    .onConflictDoUpdate({
      ...target,
      set: {
        rawRecordId: sql`excluded.raw_record_id`,
        externalId: sql`excluded.external_id`,
        sourceUrl: sql`excluded.source_url`,
        title: sql`excluded.title`,
        company: sql`excluded.company`,
        description: sql`excluded.description`,
        location: sql`excluded.location`,
        workMode: sql`excluded.work_mode`,
        employmentType: sql`excluded.employment_type`,
        publishedAt: sql`excluded.published_at`,
        normalizedTitle: sql`excluded.normalized_title`,
        normalizedCompany: sql`excluded.normalized_company`,
        normalizedLocation: sql`excluded.normalized_location`,
        duplicateGroupId: sql`case when ${regroup} then null else ${jobs.duplicateGroupId} end`,
        dedupMethod: sql`case when ${regroup} then null else ${jobs.dedupMethod} end`,
      },
      setWhere: sql`${jobs.rawRecordId} is distinct from excluded.raw_record_id`,
    })
    .returning({ inserted: sql<boolean>`xmax = 0` });

  if (!row) return "unchanged";
  return row.inserted ? "inserted" : "updated";
}
