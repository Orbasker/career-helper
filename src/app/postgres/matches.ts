import { and, desc, eq, inArray } from "drizzle-orm";
import { feedback, jobs, matchEvaluations, matches } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type { MatchDetails, MatchService, MatchSummary } from "../services.js";

const VISIBLE_STATUSES = ["ready", "notified"] as const;

const summaryColumns = {
  matchId: matches.id,
  title: jobs.title,
  company: jobs.company,
  location: jobs.location,
  recommendation: matches.recommendation,
  explanation: matches.explanation,
};

export class PgMatchService implements MatchService {
  constructor(private readonly db: Db) {}

  async latest(userId: string, limit: number): Promise<MatchSummary[]> {
    return this.db
      .select(summaryColumns)
      .from(matches)
      .innerJoin(jobs, eq(jobs.id, matches.jobId))
      .where(and(eq(matches.userId, userId), inArray(matches.status, VISIBLE_STATUSES)))
      .orderBy(desc(matches.createdAt))
      .limit(limit);
  }

  async details(userId: string, matchId: string): Promise<MatchDetails | null> {
    const [row] = await this.db
      .select({
        ...summaryColumns,
        description: jobs.description,
        sourceUrl: jobs.sourceUrl,
        workMode: jobs.workMode,
        employmentType: jobs.employmentType,
        confidence: matches.confidence,
      })
      .from(matches)
      .innerJoin(jobs, eq(jobs.id, matches.jobId))
      .where(and(eq(matches.id, matchId), eq(matches.userId, userId)));
    if (!row) return null;

    const [evaluation] = await this.db
      .select({ evidence: matchEvaluations.evidence })
      .from(matchEvaluations)
      .where(and(eq(matchEvaluations.matchId, matchId), eq(matchEvaluations.stage, "deep_match")))
      .orderBy(desc(matchEvaluations.createdAt))
      .limit(1);
    const [latestFeedback] = await this.db
      .select({ verdict: feedback.verdict })
      .from(feedback)
      .where(eq(feedback.matchId, matchId))
      .orderBy(desc(feedback.createdAt))
      .limit(1);

    const evidence = evaluation?.evidence;
    return {
      ...row,
      fitEvidence: evidence?.fitEvidence.map((e) => e.claim) ?? [],
      gaps: evidence?.gaps ?? [],
      transferableSkills: evidence?.transferableSkills ?? [],
      feedback: latestFeedback?.verdict ?? null,
    };
  }
}
