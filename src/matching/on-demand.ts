import { and, desc, eq, isNull } from "drizzle-orm";
import { loadSnapshot } from "../app/postgres/profile.js";
import { careerProfiles, duplicateGroups, jobs, matchEvaluations, matches, users } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { DEFAULT_LANGUAGE } from "../domain/language.js";
import { saveDeepVerdict, type DeepMatcher } from "./deep-match.js";
import { applyHardFilters } from "./hard-filters.js";
import { RELEVANCE_THRESHOLD, buildRelevanceProfile, scoreRelevance } from "./relevance.js";
import { cheapEvaluations, explainHardFilter } from "./run.js";

export type OnDemandMatch =
  | { kind: "evaluated"; matchId: string }
  | { kind: "fails_must_have"; matchId: string }
  | { kind: "evaluation_failed"; matchId: string };

/**
 * Matches one duplicate group for one user right away, reusing the user's match for the group when there is one. Hard
 * filters still apply, but a job the user asked about gets a deep match even below the relevance threshold. A ready
 * match is marked notified, since the user sees it now.
 */
export async function matchGroupNow(
  db: Db,
  matcher: DeepMatcher,
  userId: string,
  groupId: string,
  options: { now?: () => Date; relevanceThreshold?: number } = {},
): Promise<OnDemandMatch> {
  const now = options.now ?? (() => new Date());
  const [profile] = await db
    .select({ revision: careerProfiles.revision, language: users.preferredLanguage })
    .from(careerProfiles)
    .innerJoin(users, eq(users.id, careerProfiles.userId))
    .where(and(eq(careerProfiles.userId, userId), eq(careerProfiles.status, "confirmed")));
  if (!profile) throw new Error(`User ${userId} has no confirmed profile`);
  const [job] = await db
    .select({
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
    .where(eq(duplicateGroups.id, groupId));
  if (!job) throw new Error(`Duplicate group ${groupId} has no canonical job`);

  const match = (await findMatch(db, userId, groupId)) ?? (await createMatch(db, userId, groupId, job, profile.revision, options));

  if (match.stageReached === "hard_filter") {
    if (match.explanation === null) await explainFromHardFilter(db, match.id);
    return { kind: "fails_must_have", matchId: match.id };
  }
  if (match.stageReached === "cheap_relevance" && (match.status === "pending" || match.status === "filtered_out")) {
    try {
      const snapshot = await loadSnapshot(db, userId, { verifiedOnly: true });
      const verdict = await matcher.evaluate({ profile: snapshot, job, language: profile.language ?? DEFAULT_LANGUAGE });
      await saveDeepVerdict(db, matcher, {
        matchId: match.id,
        profileRevision: profile.revision,
        verdict,
        from: ["pending", "filtered_out"],
      });
    } catch (error) {
      console.error("on-demand deep match failed", { matchId: match.id, error });
      return { kind: "evaluation_failed", matchId: match.id };
    }
  }
  await db
    .update(matches)
    .set({ status: "notified", notifiedAt: now() })
    .where(and(eq(matches.id, match.id), eq(matches.status, "ready")));
  return { kind: "evaluated", matchId: match.id };
}

const matchColumns = {
  id: matches.id,
  status: matches.status,
  stageReached: matches.stageReached,
  explanation: matches.explanation,
};

async function findMatch(db: Db, userId: string, groupId: string) {
  const [match] = await db
    .select(matchColumns)
    .from(matches)
    .where(and(eq(matches.userId, userId), eq(matches.duplicateGroupId, groupId)));
  return match ?? null;
}

async function createMatch(
  db: Db,
  userId: string,
  groupId: string,
  job: Parameters<typeof applyHardFilters>[0] & { jobId: string },
  profileRevision: number,
  options: { relevanceThreshold?: number },
) {
  const threshold = options.relevanceThreshold ?? RELEVANCE_THRESHOLD;
  const snapshot = await loadSnapshot(db, userId);
  const hard = applyHardFilters(job, snapshot.preferences);
  const relevance = hard.passed ? scoreRelevance(job, buildRelevanceProfile(snapshot), threshold) : null;
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(matches)
      .values({
        userId,
        duplicateGroupId: groupId,
        jobId: job.jobId,
        status: hard.passed ? "pending" : "filtered_out",
        stageReached: relevance ? "cheap_relevance" : "hard_filter",
        relevanceScore: relevance?.score ?? null,
        explanation: hard.passed ? null : explainHardFilter(hard),
      })
      .onConflictDoNothing({ target: [matches.userId, matches.duplicateGroupId] })
      .returning(matchColumns);
    if (row) await tx.insert(matchEvaluations).values(cheapEvaluations(row.id, hard, relevance, threshold, profileRevision));
    return row;
  });
  return created ?? (await findMatch(db, userId, groupId))!;
}

async function explainFromHardFilter(db: Db, matchId: string) {
  const [evaluation] = await db
    .select({ explanation: matchEvaluations.explanation })
    .from(matchEvaluations)
    .where(and(eq(matchEvaluations.matchId, matchId), eq(matchEvaluations.stage, "hard_filter")))
    .orderBy(desc(matchEvaluations.createdAt))
    .limit(1);
  if (!evaluation?.explanation) return;
  await db
    .update(matches)
    .set({ explanation: evaluation.explanation })
    .where(and(eq(matches.id, matchId), isNull(matches.explanation)));
}
