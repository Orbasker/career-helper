import { and, asc, eq, gte, isNull } from "drizzle-orm";
import { loadSnapshot } from "../app/postgres/profile.js";
import { careerProfiles, duplicateGroups, jobs, matchEvaluations, matches } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { MatchEvidence } from "../domain/types.js";
import { errorMessage } from "../ingestion/ingest.js";
import { applyHardFilters, type HardFilterResult } from "./hard-filters.js";
import { RELEVANCE_THRESHOLD, buildRelevanceProfile, scoreRelevance, type RelevanceResult } from "./relevance.js";

export const DEFAULT_MAX_JOB_AGE_DAYS = 30;

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

  for (const job of candidates) {
    const hard = applyHardFilters(job, snapshot.preferences);
    const relevance = hard.passed ? scoreRelevance(job, relevanceProfile, threshold) : null;
    const passed = relevance?.passed ?? false;

    const inserted = await db.transaction(async (tx) => {
      const [match] = await tx
        .insert(matches)
        .values({
          userId,
          duplicateGroupId: job.groupId,
          jobId: job.jobId,
          status: passed ? "pending" : "filtered_out",
          stageReached: relevance ? "cheap_relevance" : "hard_filter",
          relevanceScore: relevance?.score ?? null,
        })
        .onConflictDoNothing({ target: [matches.userId, matches.duplicateGroupId] })
        .returning({ id: matches.id });
      if (!match) return false;

      await tx.insert(matchEvaluations).values({
        matchId: match.id,
        stage: "hard_filter",
        outcome: hard.passed ? "passed" : "rejected",
        explanation: explainHardFilter(hard),
        evidence: { ...EMPTY_EVIDENCE, failedConstraintIds: hard.failures.map((f) => f.preferenceId) },
        profileRevision,
      });
      if (relevance) {
        await tx.insert(matchEvaluations).values({
          matchId: match.id,
          stage: "cheap_relevance",
          outcome: relevance.passed ? "passed" : "rejected",
          score: relevance.score,
          explanation: explainRelevance(relevance, threshold),
          evidence: { ...EMPTY_EVIDENCE, matchedTerms: relevance.matchedTerms },
          profileRevision,
        });
      }
      return true;
    });
    if (!inserted) continue;

    report.evaluated++;
    if (!hard.passed) report.filteredByConstraints++;
    else if (!passed) report.filteredByRelevance++;
    else report.passed++;
  }
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
