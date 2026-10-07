import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { ConversationLanguage, FeedbackVerdict } from "../../domain/enums.js";
import { conversationStates, feedback, jobs, matches, preferenceEvidence, preferences } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { inferPreferences, type FeedbackReasonTag, type FeedbackSignal } from "../../learning/infer.js";
import type { FeedbackService, PreferenceProposalView, ProposalDecision } from "../services.js";
import { bumpRevision, loadSnapshot } from "./profile.js";

export const REASON_TEXT_TTL_MS = 10 * 60_000;
const REASON_STEP = "feedback_reason";

export class PgFeedbackService implements FeedbackService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(userId: string, matchId: string, verdict: FeedbackVerdict): Promise<{ feedbackId: string } | null> {
    return this.db.transaction(async (tx) => {
      const [match] = await tx
        .select({ id: matches.id, status: matches.status, notifiedAt: matches.notifiedAt })
        .from(matches)
        .where(and(eq(matches.id, matchId), eq(matches.userId, userId)))
        .for("update");
      if (!match) return null;

      const [latest] = await tx
        .select({ id: feedback.id, verdict: feedback.verdict })
        .from(feedback)
        .where(eq(feedback.matchId, matchId))
        .orderBy(desc(feedback.createdAt))
        .limit(1);
      if (latest?.verdict === verdict) return { feedbackId: latest.id };

      const [row] = await tx.insert(feedback).values({ userId, matchId, verdict }).returning({ id: feedback.id });
      if (verdict === "not_interested") {
        await tx.update(matches).set({ status: "dismissed" }).where(eq(matches.id, matchId));
      } else if (match.status === "dismissed") {
        await tx
          .update(matches)
          .set({ status: match.notifiedAt ? "notified" : "ready" })
          .where(eq(matches.id, matchId));
      }
      return { feedbackId: row!.id };
    });
  }

  async addReasonTag(userId: string, feedbackId: string, tag: FeedbackReasonTag): Promise<boolean> {
    const updated = await this.db
      .update(feedback)
      .set({ reasonTags: sql`array(select distinct unnest(${feedback.reasonTags} || array[${tag}]::text[]))` })
      .where(and(eq(feedback.id, feedbackId), eq(feedback.userId, userId)))
      .returning({ id: feedback.id });
    return updated.length > 0;
  }

  async awaitReasonText(userId: string, feedbackId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: feedback.id })
      .from(feedback)
      .where(and(eq(feedback.id, feedbackId), eq(feedback.userId, userId)));
    if (!row) return false;
    const state = {
      flow: "preference_update" as const,
      step: REASON_STEP,
      context: { feedbackId },
      expiresAt: new Date(this.now().getTime() + REASON_TEXT_TTL_MS),
    };
    await this.db
      .insert(conversationStates)
      .values({ userId, ...state })
      .onConflictDoUpdate({ target: conversationStates.userId, set: state });
    return true;
  }

  async takeReasonText(userId: string, text: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [state] = await tx
        .select({ context: conversationStates.context })
        .from(conversationStates)
        .where(
          and(
            eq(conversationStates.userId, userId),
            eq(conversationStates.flow, "preference_update"),
            eq(conversationStates.step, REASON_STEP),
            gt(conversationStates.expiresAt, this.now()),
          ),
        )
        .for("update");
      if (!state) return false;

      await tx
        .update(conversationStates)
        .set({ flow: "idle", step: null, context: {}, expiresAt: null })
        .where(eq(conversationStates.userId, userId));
      const feedbackId = (state.context as { feedbackId?: string }).feedbackId;
      if (feedbackId) {
        await tx
          .update(feedback)
          .set({ reason: text.trim() })
          .where(and(eq(feedback.id, feedbackId), eq(feedback.userId, userId)));
      }
      return true;
    });
  }

  async learn(userId: string, language: ConversationLanguage): Promise<PreferenceProposalView[]> {
    const rows = await this.db
      .select({
        feedbackId: feedback.id,
        groupId: matches.duplicateGroupId,
        verdict: feedback.verdict,
        reasonTags: feedback.reasonTags,
        title: jobs.title,
        company: jobs.company,
        workMode: jobs.workMode,
      })
      .from(feedback)
      .innerJoin(matches, eq(matches.id, feedback.matchId))
      .innerJoin(jobs, eq(jobs.id, matches.jobId))
      .where(eq(feedback.userId, userId))
      .orderBy(desc(feedback.createdAt), desc(feedback.id));
    const latestByGroup = new Map<string, FeedbackSignal>();
    for (const row of rows) if (!latestByGroup.has(row.groupId)) latestByGroup.set(row.groupId, row);

    const snapshot = await loadSnapshot(this.db, userId, { verifiedOnly: true });
    const allPreferences = await this.db
      .select({
        id: preferences.id,
        kind: preferences.kind,
        dimension: preferences.dimension,
        label: preferences.label,
        value: preferences.value,
        status: preferences.status,
      })
      .from(preferences)
      .where(eq(preferences.userId, userId));

    const proposals = inferPreferences({
      signals: [...latestByGroup.values()],
      ownTitles: [snapshot.profile.headline ?? "", ...snapshot.experiences.map((e) => e.title)],
      preferences: allPreferences,
      language,
    });
    if (proposals.length === 0) return [];

    return this.db.transaction(async (tx) => {
      const views: PreferenceProposalView[] = [];
      for (const proposal of proposals) {
        const [row] = await tx
          .insert(preferences)
          .values({
            userId,
            ...proposal.preference,
            status: "proposed",
            origin: "inferred_from_feedback",
            rationale: proposal.rationale,
            supersedesId: proposal.supersedesId,
          })
          .returning({ id: preferences.id });
        await tx
          .insert(preferenceEvidence)
          .values(proposal.feedbackIds.map((feedbackId) => ({ preferenceId: row!.id, feedbackId })));
        views.push({
          preferenceId: row!.id,
          kind: proposal.preference.kind,
          label: proposal.preference.label,
          rationale: proposal.rationale,
        });
      }
      return views;
    });
  }

  async decideProposal(userId: string, preferenceId: string, accept: boolean): Promise<ProposalDecision> {
    return this.db.transaction(async (tx) => {
      const decidedAt = this.now();
      const [proposal] = await tx
        .update(preferences)
        .set({ status: accept ? "active" : "rejected", decidedAt })
        .where(
          and(
            eq(preferences.id, preferenceId),
            eq(preferences.userId, userId),
            eq(preferences.origin, "inferred_from_feedback"),
            eq(preferences.status, "proposed"),
          ),
        )
        .returning({ supersedesId: preferences.supersedesId });
      if (!proposal) return "not_found";
      if (!accept) return "rejected";

      if (proposal.supersedesId) {
        await tx
          .update(preferences)
          .set({ status: "superseded", decidedAt })
          .where(
            and(eq(preferences.id, proposal.supersedesId), eq(preferences.userId, userId), eq(preferences.status, "active")),
          );
      }
      await bumpRevision(tx, userId);
      return "accepted";
    });
  }
}
