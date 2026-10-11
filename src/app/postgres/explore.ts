import { eq, sql } from "drizzle-orm";
import { feedback, jobSources, jobs, matchEvaluations, matches, preferences, users } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type { FeedbackVerdict, MatchRecommendation, MatchStage, MatchStatus } from "../../domain/enums.js";
import { DEFAULT_LANGUAGE } from "../../domain/language.js";
import type { MatchEvidence } from "../../domain/types.js";
import type { ExploreData, ExploreItem, ExploreTab, HoldReason } from "../../miniapp/types.js";
import { notAppliedTo } from "./applications.js";

const RECOMMENDATION_ORDER: Record<MatchRecommendation, number> = { strong_fit: 0, good_fit: 1, stretch: 2, not_recommended: 3 };

/** Every job matched for a user, including the ones held back, with why each was held back. */
export class PgExploreService {
  constructor(private readonly db: Db) {}

  async list(userId: string): Promise<ExploreData> {
    const [user] = await this.db.select({ language: users.preferredLanguage }).from(users).where(eq(users.id, userId));
    const latestEvidence = sql<MatchEvidence | null>`(
      select ${matchEvaluations.evidence} from ${matchEvaluations}
      where ${matchEvaluations.matchId} = ${matches.id} and ${matchEvaluations.stage} = ${matches.stageReached}
      order by ${matchEvaluations.createdAt} desc limit 1)`;
    const latestFeedback = sql<FeedbackVerdict | null>`(
      select ${feedback.verdict} from ${feedback} where ${feedback.matchId} = ${matches.id}
      order by ${feedback.createdAt} desc limit 1)`;

    const rows = await this.db
      .select({
        matchId: matches.id,
        status: matches.status,
        stage: matches.stageReached,
        score: matches.relevanceScore,
        recommendation: matches.recommendation,
        explanation: matches.explanation,
        foundAt: matches.createdAt,
        title: jobs.title,
        company: jobs.company,
        location: jobs.location,
        sourceName: jobSources.name,
        evidence: latestEvidence,
        feedback: latestFeedback,
        applied: sql<boolean>`not ${notAppliedTo()}`,
      })
      .from(matches)
      .innerJoin(jobs, eq(jobs.id, matches.jobId))
      .innerJoin(jobSources, eq(jobSources.id, jobs.sourceId))
      .where(eq(matches.userId, userId));

    const labels = new Map(
      (
        await this.db
          .select({ id: preferences.id, label: preferences.label })
          .from(preferences)
          .where(eq(preferences.userId, userId))
      ).map((p) => [p.id, p.label]),
    );

    const items: ExploreItem[] = rows.map(({ status, stage, evidence, foundAt, explanation, ...row }) => {
      const tab = tabOf(status, stage);
      return {
        ...row,
        tab,
        explanation: stage === "deep_match" ? explanation : null,
        reasons: tab === "blocked" || tab === "close" ? holdReasons(stage, evidence, labels) : [],
        foundAt: foundAt.toISOString(),
      };
    });
    items.sort(compareItems);
    return { language: user?.language ?? DEFAULT_LANGUAGE, items };
  }
}

export function tabOf(status: MatchStatus, stage: MatchStage | null): ExploreTab {
  switch (status) {
    case "ready":
    case "notified":
      return "matches";
    case "pending":
      return "waiting";
    case "dismissed":
      return "hidden";
    case "filtered_out":
      return stage === "hard_filter" ? "blocked" : "close";
  }
}

/** Reads the hard filter's failed constraints, or the deep matcher's veto from its recorded risks. */
export function holdReasons(stage: MatchStage | null, evidence: MatchEvidence | null, labels: ReadonlyMap<string, string>): HoldReason[] {
  if (stage === "hard_filter") {
    return (evidence?.failedConstraintIds ?? []).flatMap((id) => {
      const label = labels.get(id);
      return label ? [{ kind: "must_have" as const, label }] : [];
    });
  }
  if (stage === "cheap_relevance") return [{ kind: "low_relevance" }];
  const veto = evidence?.risks[0] ?? "";
  const quoted = /“(.+)”/.exec(veto)?.[1];
  if (quoted && veto.startsWith("Breaks must-have")) return [{ kind: "must_have", label: quoted }];
  if (quoted && veto.startsWith("Matches something to avoid")) return [{ kind: "dislike", label: quoted }];
  if (veto.startsWith("Outside target and past roles")) return [{ kind: "outside_path" }];
  return [{ kind: "not_a_fit" }];
}

function compareItems(a: ExploreItem, b: ExploreItem): number {
  if (a.tab !== b.tab) return a.tab < b.tab ? -1 : 1;
  if (a.tab === "matches") {
    const byRecommendation = rank(a.recommendation) - rank(b.recommendation);
    if (byRecommendation) return byRecommendation;
  }
  const byScore = (b.score ?? -1) - (a.score ?? -1);
  return byScore || b.foundAt.localeCompare(a.foundAt);
}

const rank = (recommendation: MatchRecommendation | null) => (recommendation ? RECOMMENDATION_ORDER[recommendation] : 4);
