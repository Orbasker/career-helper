import { and, asc, eq, exists, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { duplicateGroups, jobSources, jobs } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { DedupMethod } from "../domain/enums.js";
import { dedupKey, jaccard, normalizeJobKey, normalizeTitle, wordShingles, type NormalizedJobKey } from "./normalize.js";

export const TITLE_SIMILARITY_THRESHOLD = 0.5;
export const DESCRIPTION_SIMILARITY_THRESHOLD = 0.6;

export interface DedupOptions {
  now?: () => Date;
}

export interface DedupReport {
  processed: number;
  joinedByKey: number;
  joinedBySimilarity: number;
  newGroups: number;
  canonicalChanged: number;
  error: string | null;
  durationMs: number;
}

export interface GroupSource {
  jobId: string;
  source: string;
  sourceUrl: string;
  isCanonical: boolean;
}

interface PendingJob {
  id: string;
  title: string;
  company: string | null;
  location: string | null;
  description: string;
}

interface GroupAssignment {
  groupId: string;
  method: DedupMethod;
}

/**
 * Assigns every ungrouped job to a duplicate group: an exact normalized title/company/location match first,
 * then a same-company similarity match, otherwise a new group. Re-selects the canonical job of affected groups.
 */
export async function deduplicateJobs(db: Db, options: DedupOptions = {}): Promise<DedupReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const report = emptyDedupReport();

  const pending = await db
    .select({ id: jobs.id, title: jobs.title, company: jobs.company, location: jobs.location, description: jobs.description })
    .from(jobs)
    .where(isNull(jobs.duplicateGroupId))
    .orderBy(asc(jobs.collectedAt), asc(jobs.id));

  const touched = new Set(await groupsNeedingCanonical(db));
  for (const job of pending) {
    const key = normalizeJobKey(job);
    const match = (await findByKey(db, key)) ?? (await findBySimilar(db, job, key));
    let assignment = match;
    if (!assignment) {
      const group = await createGroup(db, job.id, key);
      if (group.created) report.newGroups++;
      assignment = group;
    }

    await db
      .update(jobs)
      .set({ ...key, duplicateGroupId: assignment.groupId, dedupMethod: assignment.method })
      .where(eq(jobs.id, job.id));
    report.processed++;
    if (match?.method === "deterministic_key") report.joinedByKey++;
    if (match?.method === "similarity") report.joinedBySimilarity++;
    touched.add(assignment.groupId);
  }

  for (const groupId of touched) {
    if (await refreshCanonical(db, groupId)) report.canonicalChanged++;
  }
  report.durationMs = now().getTime() - startedAt.getTime();
  return report;
}

export function emptyDedupReport(): DedupReport {
  return {
    processed: 0,
    joinedByKey: 0,
    joinedBySimilarity: 0,
    newGroups: 0,
    canonicalChanged: 0,
    error: null,
    durationMs: 0,
  };
}

export async function listGroupSources(db: Db, groupId: string): Promise<GroupSource[]> {
  return db
    .select({
      jobId: jobs.id,
      source: jobSources.key,
      sourceUrl: jobs.sourceUrl,
      isCanonical: sql<boolean>`${jobs.id} = ${duplicateGroups.canonicalJobId}`.mapWith(Boolean),
    })
    .from(jobs)
    .innerJoin(jobSources, eq(jobSources.id, jobs.sourceId))
    .innerJoin(duplicateGroups, eq(duplicateGroups.id, jobs.duplicateGroupId))
    .where(eq(jobs.duplicateGroupId, groupId))
    .orderBy(asc(jobs.collectedAt), asc(jobs.id));
}

async function findByKey(db: Db, key: NormalizedJobKey): Promise<GroupAssignment | null> {
  if (!dedupKey(key)) return null;
  const [row] = await db
    .select({ groupId: jobs.duplicateGroupId })
    .from(jobs)
    .where(
      and(
        isNotNull(jobs.duplicateGroupId),
        eq(jobs.normalizedTitle, key.normalizedTitle!),
        eq(jobs.normalizedCompany, key.normalizedCompany!),
        sql`${jobs.normalizedLocation} is not distinct from ${key.normalizedLocation}`,
      ),
    )
    .orderBy(asc(jobs.collectedAt))
    .limit(1);
  return row?.groupId ? { groupId: row.groupId, method: "deterministic_key" } : null;
}

async function findBySimilar(db: Db, job: PendingJob, key: NormalizedJobKey): Promise<GroupAssignment | null> {
  if (!key.normalizedCompany || !key.normalizedTitle) return null;
  const candidates = await db
    .select({
      groupId: jobs.duplicateGroupId,
      title: jobs.title,
      normalizedLocation: jobs.normalizedLocation,
      description: jobs.description,
    })
    .from(jobs)
    .where(and(isNotNull(jobs.duplicateGroupId), eq(jobs.normalizedCompany, key.normalizedCompany), ne(jobs.id, job.id)))
    .orderBy(asc(jobs.collectedAt), asc(jobs.id));

  const titleWords = new Set(key.normalizedTitle.split(" "));
  const descriptionShingles = wordShingles(job.description);
  let best: { groupId: string; score: number } | null = null;
  for (const candidate of candidates) {
    if (!locationsCompatible(key.normalizedLocation, candidate.normalizedLocation)) continue;
    const titleScore = jaccard(titleWords, new Set((normalizeTitle(candidate.title) ?? "").split(" ")));
    if (titleScore < TITLE_SIMILARITY_THRESHOLD) continue;
    const descriptionScore = jaccard(descriptionShingles, wordShingles(candidate.description));
    if (descriptionScore < DESCRIPTION_SIMILARITY_THRESHOLD) continue;
    const score = titleScore + descriptionScore;
    if (!best || score > best.score) best = { groupId: candidate.groupId!, score };
  }
  return best ? { groupId: best.groupId, method: "similarity" } : null;
}

function locationsCompatible(a: string | null, b: string | null): boolean {
  return a === null || b === null || a === b;
}

/** Jobs without a company key on their own id so they never merge with an unrelated posting. */
async function createGroup(
  db: Db,
  jobId: string,
  key: NormalizedJobKey,
): Promise<GroupAssignment & { created: boolean }> {
  const groupKey = dedupKey(key) ?? `job:${jobId}`;
  const [created] = await db
    .insert(duplicateGroups)
    .values({ dedupKey: groupKey })
    .onConflictDoNothing({ target: duplicateGroups.dedupKey })
    .returning({ id: duplicateGroups.id });
  if (created) return { groupId: created.id, method: "deterministic_key", created: true };

  const [existing] = await db
    .select({ id: duplicateGroups.id })
    .from(duplicateGroups)
    .where(eq(duplicateGroups.dedupKey, groupKey));
  return { groupId: existing!.id, method: "deterministic_key", created: false };
}

/** Groups whose canonical job is missing or has since been regrouped elsewhere. */
async function groupsNeedingCanonical(db: Db): Promise<string[]> {
  const canonical = alias(jobs, "canonical");
  const rows = await db
    .select({ id: duplicateGroups.id })
    .from(duplicateGroups)
    .leftJoin(canonical, eq(canonical.id, duplicateGroups.canonicalJobId))
    .where(
      or(
        and(
          isNotNull(duplicateGroups.canonicalJobId),
          sql`${canonical.duplicateGroupId} is distinct from ${duplicateGroups.id}`,
        ),
        and(
          isNull(duplicateGroups.canonicalJobId),
          exists(db.select({ id: jobs.id }).from(jobs).where(eq(jobs.duplicateGroupId, duplicateGroups.id))),
        ),
      ),
    );
  return rows.map((r) => r.id);
}

/** Picks the most complete posting, then the longest description, then the earliest collected. */
async function refreshCanonical(db: Db, groupId: string): Promise<boolean> {
  const members = await db.select().from(jobs).where(eq(jobs.duplicateGroupId, groupId));
  const ranked = members.sort(
    (a, b) =>
      completeness(b) - completeness(a) ||
      b.description.length - a.description.length ||
      a.collectedAt.getTime() - b.collectedAt.getTime() ||
      (a.id < b.id ? -1 : 1),
  );
  const canonicalJobId = ranked[0]?.id ?? null;
  const updated = await db
    .update(duplicateGroups)
    .set({ canonicalJobId })
    .where(and(eq(duplicateGroups.id, groupId), sql`${duplicateGroups.canonicalJobId} is distinct from ${canonicalJobId}`))
    .returning({ id: duplicateGroups.id });
  return updated.length > 0;
}

function completeness(job: typeof jobs.$inferSelect): number {
  return [job.company, job.location, job.workMode, job.employmentType, job.publishedAt].filter((v) => v !== null).length;
}
