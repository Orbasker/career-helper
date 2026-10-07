import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { loadSnapshot } from "../app/postgres/profile.js";
import { careerProfiles, jobs, matchEvaluations, matches, users } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { ConfidenceLevel, ConversationLanguage, MatchRecommendation, MatchStatus } from "../domain/enums.js";
import type { ProfileSnapshot } from "../domain/profile.js";
import type { MatchEvidence } from "../domain/types.js";
import { DEFAULT_LANGUAGE } from "../domain/language.js";
import { errorMessage } from "../ingestion/ingest.js";
import type { MatchJob } from "./types.js";

export const DEFAULT_DEEP_MATCH_LIMIT = 50;

export interface DeepMatchJob extends MatchJob {
  company: string | null;
}

export interface DeepMatchVerdict {
  recommendation: MatchRecommendation;
  confidence: ConfidenceLevel;
  explanation: string;
  evidence: MatchEvidence;
}

export interface DeepMatcher {
  readonly model: string;
  readonly promptVersion: string;
  /** `profile` must hold only verified experiences and facts; evidence cites their ids. User-facing text is in `language`. */
  evaluate(input: { profile: ProfileSnapshot; job: DeepMatchJob; language: ConversationLanguage }): Promise<DeepMatchVerdict>;
}

export interface DeepMatchingOptions {
  now?: () => Date;
  limit?: number;
  /** No new evaluation starts after this time; the rest stay pending for the next run. */
  deadline?: Date;
}

export interface DeepMatchingReport {
  evaluated: number;
  recommended: number;
  notRecommended: number;
  errors: { matchId: string; error: string }[];
  durationMs: number;
}

export const isRecommended = (recommendation: MatchRecommendation) => recommendation !== "not_recommended";

/** Evaluates cheap-relevance survivors, most relevant first; a failed evaluation leaves the match pending for a retry. */
export async function runDeepMatching(
  db: Db,
  matcher: DeepMatcher,
  options: DeepMatchingOptions = {},
): Promise<DeepMatchingReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const report: DeepMatchingReport = { evaluated: 0, recommended: 0, notRecommended: 0, errors: [], durationMs: 0 };

  const pending = await db
    .select({
      matchId: matches.id,
      userId: matches.userId,
      profileRevision: careerProfiles.revision,
      language: users.preferredLanguage,
      title: jobs.title,
      company: jobs.company,
      description: jobs.description,
      location: jobs.location,
      workMode: jobs.workMode,
      employmentType: jobs.employmentType,
    })
    .from(matches)
    .innerJoin(jobs, eq(jobs.id, matches.jobId))
    .innerJoin(careerProfiles, eq(careerProfiles.userId, matches.userId))
    .innerJoin(users, eq(users.id, matches.userId))
    .where(
      and(
        eq(matches.status, "pending"),
        eq(matches.stageReached, "cheap_relevance"),
        eq(careerProfiles.status, "confirmed"),
      ),
    )
    .orderBy(desc(matches.relevanceScore), asc(matches.createdAt), asc(matches.id))
    .limit(options.limit ?? DEFAULT_DEEP_MATCH_LIMIT);

  const snapshots = new Map<string, Promise<ProfileSnapshot>>();
  for (const { matchId, userId, profileRevision, language, ...job } of pending) {
    if (options.deadline && now() >= options.deadline) break;
    try {
      let snapshot = snapshots.get(userId);
      if (!snapshot) {
        snapshot = loadSnapshot(db, userId, { verifiedOnly: true });
        snapshots.set(userId, snapshot);
      }
      const verdict = await matcher.evaluate({ profile: await snapshot, job, language: language ?? DEFAULT_LANGUAGE });
      const recommended = isRecommended(verdict.recommendation);

      if (!(await saveDeepVerdict(db, matcher, { matchId, profileRevision, verdict, from: ["pending"] }))) continue;

      report.evaluated++;
      if (recommended) report.recommended++;
      else report.notRecommended++;
    } catch (error) {
      report.errors.push({ matchId, error: errorMessage(error) });
    }
  }
  report.durationMs = now().getTime() - startedAt.getTime();
  return report;
}

/**
 * Stores a deep-match verdict on a match that is still at `cheap_relevance` in one of the `from` statuses; false when
 * another run got there first.
 */
export async function saveDeepVerdict(
  db: Db,
  matcher: Pick<DeepMatcher, "model" | "promptVersion">,
  input: { matchId: string; profileRevision: number; verdict: DeepMatchVerdict; from: MatchStatus[] },
): Promise<boolean> {
  const { matchId, verdict } = input;
  const recommended = isRecommended(verdict.recommendation);
  return db.transaction(async (tx) => {
    const [match] = await tx
      .update(matches)
      .set({
        status: recommended ? "ready" : "filtered_out",
        stageReached: "deep_match",
        recommendation: verdict.recommendation,
        confidence: verdict.confidence,
        explanation: verdict.explanation,
      })
      .where(and(eq(matches.id, matchId), inArray(matches.status, input.from), eq(matches.stageReached, "cheap_relevance")))
      .returning({ id: matches.id });
    if (!match) return false;
    await tx.insert(matchEvaluations).values({
      matchId,
      stage: "deep_match",
      outcome: recommended ? "passed" : "rejected",
      recommendation: verdict.recommendation,
      confidence: verdict.confidence,
      explanation: verdict.explanation,
      evidence: verdict.evidence,
      profileRevision: input.profileRevision,
      model: matcher.model,
      promptVersion: matcher.promptVersion,
    });
    return true;
  });
}
