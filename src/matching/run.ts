import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { loadSnapshot } from "../app/postgres/profile.js";
import { careerProfiles, duplicateGroups, jobs, matchEvaluations, matches } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { MatchEvidence } from "../domain/types.js";
import { errorMessage } from "../ingestion/ingest.js";
import { applyHardFilters, type HardFilterResult } from "./hard-filters.js";
import { RELEVANCE_THRESHOLD, buildRelevanceProfile, scoreRelevance, type RelevanceResult } from "./relevance.js";

export const DEFAULT_MAX_JOB_AGE_DAYS = 30;
const WRITE_BATCH_SIZE = 200;

export interface CheapMatchingOptions {
  now?: () => Date;
  maxJobAgeDays?: number;
  relevanceThreshold?: number;
}

export interface CheapMatchingReport {
  users: number;
  evaluated: number;
  filteredByConstraints: number;
  filteredByRelevance: number;
  passed: number;
  errors: { userId: string; error: string }[];
  durationMs: number;
}

const EMPTY_EVIDENCE: MatchEvidence = { fitEvidence: [], gaps: [], risks: [], transferableSkills: [] };

/**
 * Runs the hard-filter and cheap-relevance stages for every confirmed profile against each canonical job it has
 * not seen yet. Survivors stay `pending` at `cheap_relevance` for the deep matcher; the rest are `filtered_out`.
 */
export async function runCheapMatching(db: Db, options: CheapMatchingOptions = {}): Promise<CheapMatchingReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const cutoff = new Date(startedAt.getTime() - (options.maxJobAgeDays ?? DEFAULT_MAX_JOB_AGE_DAYS) * 86_400_000);
  const threshold = options.relevanceThreshold ?? RELEVANCE_THRESHOLD;
  const report: CheapMatchingReport = {
    users: 0,
    evaluated: 0,
    filteredByConstraints: 0,
    filteredByRelevance: 0,
    passed: 0,
    errors: [],
    durationMs: 0,
  };

  const profiles = await db
    .select({ userId: careerProfiles.userId, revision: careerProfiles.revision })
    .from(careerProfiles)
    .where(eq(careerProfiles.status, "confirmed"))
    .orderBy(asc(careerProfiles.createdAt));

  for (const { userId, revision } of profiles) {
    report.users++;
    try {
      await matchUser(db, userId, revision, cutoff, threshold, report);
    } catch (error) {
      report.errors.push({ userId, error: errorMessage(error) });
    }
  }
  report.durationMs = now().getTime() - startedAt.getTime();
  return report;
}

async function matchUser(
  db: Db,
  userId: string,
  profileRevision: number,
  cutoff: Date,
  threshold: number,
  report: CheapMatchingReport,
) {
  const snapshot = await loadSnapshot(db, userId);
  const relevanceProfile = buildRelevanceProfile(snapshot);
  const candidates = await db
    .select({
      groupId: duplicateGroups.id,
      jobId: jobs.id,
      title: jobs.title,
      company: jobs.company,
      description: jobs.description,
      location: jobs.location,
      workMode: jobs.workMode,
      employmentType: jobs.employmentType,
    })
    .from(duplicateGroups)
    .innerJoin(jobs, eq(jobs.id, duplicateGroups.canonicalJobId))
    .leftJoin(matches, and(eq(matches.duplicateGroupId, duplicateGroups.id), eq(matches.userId, userId)))
    .where(and(isNull(matches.id), gte(jobs.collectedAt, cutoff)))
    .orderBy(asc(jobs.collectedAt), asc(jobs.id));

  const results = candidates.map((job) => {
    const hard = applyHardFilters(job, snapshot.preferences);
    const relevance = hard.passed ? scoreRelevance(job, relevanceProfile, threshold) : null;
    return { job, hard, relevance, passed: relevance?.passed ?? false };
  });

  for (let i = 0; i < results.length; i += WRITE_BATCH_SIZE) {
    const batch = results.slice(i, i + WRITE_BATCH_SIZE);
    const inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(matches)
        .values(
          batch.map(({ job, relevance, passed }) => ({
            userId,
            duplicateGroupId: job.groupId,
            jobId: job.jobId,
            status: passed ? ("pending" as const) : ("filtered_out" as const),
            stageReached: relevance ? ("cheap_relevance" as const) : ("hard_filter" as const),
            relevanceScore: relevance?.score ?? null,
          })),
        )
        .onConflictDoNothing({ target: [matches.userId, matches.duplicateGroupId] })
        .returning({ id: matches.id, groupId: matches.duplicateGroupId });
      const matchIds = new Map(rows.map((r) => [r.groupId, r.id]));
      const kept = batch.filter((r) => matchIds.has(r.job.groupId));

      const evaluations = kept.flatMap(({ job, hard, relevance }) =>
        cheapEvaluations(matchIds.get(job.groupId)!, hard, relevance, threshold, profileRevision),
      );
      if (evaluations.length) await tx.insert(matchEvaluations).values(evaluations);
      return kept;
    });

    for (const { hard, passed } of inserted) {
      report.evaluated++;
      if (!hard.passed) report.filteredByConstraints++;
      else if (!passed) report.filteredByRelevance++;
      else report.passed++;
    }
  }
}

/** The `hard_filter` evaluation, plus `cheap_relevance` when relevance was scored. */
export function cheapEvaluations(
  matchId: string,
  hard: HardFilterResult,
  relevance: RelevanceResult | null,
  threshold: number,
  profileRevision: number,
): (typeof matchEvaluations.$inferInsert)[] {
  const stages: (typeof matchEvaluations.$inferInsert)[] = [
    {
      matchId,
      stage: "hard_filter",
      outcome: hard.passed ? "passed" : "rejected",
      explanation: explainHardFilter(hard),
      evidence: { ...EMPTY_EVIDENCE, failedConstraintIds: hard.failures.map((f) => f.preferenceId) },
      profileRevision,
    },
  ];
  if (relevance) {
    stages.push({
      matchId,
      stage: "cheap_relevance",
      outcome: relevance.passed ? "passed" : "rejected",
      score: relevance.score,
      explanation: explainRelevance(relevance, threshold),
      evidence: { ...EMPTY_EVIDENCE, matchedTerms: relevance.matchedTerms },
      profileRevision,
    });
  }
  return stages;
}

export function explainHardFilter(result: HardFilterResult): string {
  if (result.passed) return "Meets every must-have";
  return result.failures.map((f) => `Fails must-have “${f.label}”: ${f.reason}`).join("; ");
}

export function explainRelevance(result: RelevanceResult, threshold: number): string {
  const parts = [`Relevance ${result.score} (threshold ${threshold})`];
  if (result.matchedTerms.length) parts.push(`overlap: ${result.matchedTerms.join(", ")}`);
  if (result.targetRoles.length) parts.push(`target role: ${result.targetRoles.join(", ")}`);
  if (result.softPreferences.length) parts.push(`nice-to-have: ${result.softPreferences.join(", ")}`);
  if (result.dislikes.length) parts.push(`avoid: ${result.dislikes.join(", ")}`);
  return parts.join("; ");
}
