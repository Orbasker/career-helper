import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { notAppliedTo } from "../app/postgres/applications.js";
import type { MatchSummary } from "../app/services.js";
import { careerProfiles, jobs, matches, users } from "../db/schema.js";
import type { Db } from "../db/types.js";
import {
  CONFIDENCE_LEVELS,
  type ConfidenceLevel,
  type ConversationLanguage,
  type MatchRecommendation,
} from "../domain/enums.js";
import { errorMessage } from "../ingestion/ingest.js";
import { contactsAtCompanies, contactsFor } from "../connections/lookup.js";
import { employerRelation, loadEmployerHistory } from "../matching/employer.js";

export type NotifiableRecommendation = Exclude<MatchRecommendation, "not_recommended">;

export const NOTIFIABLE_RECOMMENDATIONS: readonly NotifiableRecommendation[] = ["strong_fit", "good_fit", "stretch"];

export interface NotificationThreshold {
  minRecommendation: NotifiableRecommendation;
  minConfidence: ConfidenceLevel;
}

export const DEFAULT_NOTIFICATION_THRESHOLD: NotificationThreshold = { minRecommendation: "good_fit", minConfidence: "low" };
export const DEFAULT_DIGEST_SIZE = 5;

export function parseNotificationThreshold(env: Record<string, string | undefined> = process.env): NotificationThreshold {
  const minRecommendation = env.NOTIFY_MIN_RECOMMENDATION || DEFAULT_NOTIFICATION_THRESHOLD.minRecommendation;
  const minConfidence = env.NOTIFY_MIN_CONFIDENCE || DEFAULT_NOTIFICATION_THRESHOLD.minConfidence;
  if (!(NOTIFIABLE_RECOMMENDATIONS as readonly string[]).includes(minRecommendation)) {
    throw new Error(`NOTIFY_MIN_RECOMMENDATION must be one of ${NOTIFIABLE_RECOMMENDATIONS.join(", ")}`);
  }
  if (!(CONFIDENCE_LEVELS as readonly string[]).includes(minConfidence)) {
    throw new Error(`NOTIFY_MIN_CONFIDENCE must be one of ${CONFIDENCE_LEVELS.join(", ")}`);
  }
  return {
    minRecommendation: minRecommendation as NotifiableRecommendation,
    minConfidence: minConfidence as ConfidenceLevel,
  };
}

export function qualifyingRecommendations(threshold: NotificationThreshold): NotifiableRecommendation[] {
  return NOTIFIABLE_RECOMMENDATIONS.slice(0, NOTIFIABLE_RECOMMENDATIONS.indexOf(threshold.minRecommendation) + 1);
}

export function qualifyingConfidences(threshold: NotificationThreshold): ConfidenceLevel[] {
  return CONFIDENCE_LEVELS.slice(CONFIDENCE_LEVELS.indexOf(threshold.minConfidence));
}

/** Thrown by a notifier when the chat can no longer receive messages, e.g. the user blocked the bot. */
export class RecipientUnavailableError extends Error {}

export interface Notifier {
  /** `language` is the user's chosen language, or null for the default. */
  sendDigest(chatId: number, matches: MatchSummary[], remaining: number, language: ConversationLanguage | null): Promise<void>;
}

export interface NotificationOptions {
  now?: () => Date;
  threshold?: NotificationThreshold;
  digestSize?: number;
}

export interface NotificationReport {
  users: number;
  digestsSent: number;
  matchesNotified: number;
  recipientsDisabled: number;
  errors: { userId: string; error: string }[];
  durationMs: number;
}

/**
 * Sends each user one digest of their best `ready` matches that meet the threshold, skipping jobs they already applied to.
 * Matches are claimed as `notified` before sending so concurrent or repeated runs never send them twice; a failed send
 * releases them.
 */
export async function runNotifications(
  db: Db,
  notifier: Notifier,
  options: NotificationOptions = {},
): Promise<NotificationReport> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const threshold = options.threshold ?? DEFAULT_NOTIFICATION_THRESHOLD;
  const digestSize = options.digestSize ?? DEFAULT_DIGEST_SIZE;
  const report: NotificationReport = {
    users: 0,
    digestsSent: 0,
    matchesNotified: 0,
    recipientsDisabled: 0,
    errors: [],
    durationMs: 0,
  };

  const candidates = await db
    .select({
      userId: users.id,
      chatId: users.telegramChatId,
      language: users.preferredLanguage,
      matchId: matches.id,
      title: jobs.title,
      company: jobs.company,
      location: jobs.location,
      recommendation: matches.recommendation,
      explanation: matches.explanation,
      relevanceScore: matches.relevanceScore,
    })
    .from(matches)
    .innerJoin(users, eq(users.id, matches.userId))
    .innerJoin(careerProfiles, eq(careerProfiles.userId, matches.userId))
    .innerJoin(jobs, eq(jobs.id, matches.jobId))
    .where(
      and(
        eq(matches.status, "ready"),
        isNull(matches.notifiedAt),
        inArray(matches.recommendation, qualifyingRecommendations(threshold)),
        inArray(matches.confidence, qualifyingConfidences(threshold)),
        eq(users.notificationsEnabled, true),
        eq(careerProfiles.status, "confirmed"),
        notAppliedTo(),
      ),
    )
    .orderBy(asc(matches.createdAt), asc(matches.id));

  const histories = await loadEmployerHistory(db, [...new Set(candidates.map((c) => c.userId))]);
  const byUser = new Map<string, typeof candidates>();
  for (const row of candidates) {
    const rows = byUser.get(row.userId) ?? [];
    rows.push(row);
    byUser.set(row.userId, rows);
  }

  for (const [userId, rows] of byUser) {
    report.users++;
    rows.sort(
      (a, b) =>
        NOTIFIABLE_RECOMMENDATIONS.indexOf(a.recommendation as NotifiableRecommendation) -
          NOTIFIABLE_RECOMMENDATIONS.indexOf(b.recommendation as NotifiableRecommendation) ||
        (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0),
    );
    const picked = rows.slice(0, digestSize);
    const claimed = await db
      .update(matches)
      .set({ status: "notified", notifiedAt: now() })
      .where(and(inArray(matches.id, picked.map((r) => r.matchId)), eq(matches.status, "ready"), isNull(matches.notifiedAt)))
      .returning({ id: matches.id });
    const claimedIds = new Set(claimed.map((c) => c.id));
    const digest = picked.filter((r) => claimedIds.has(r.matchId));
    if (digest.length === 0) continue;

    try {
      const contacts = await contactsAtCompanies(db, userId, digest.map((r) => r.company));
      await notifier.sendDigest(
        rows[0]!.chatId,
        digest.map(({ matchId, title, company, location, recommendation, explanation }) => ({
          matchId,
          title,
          company,
          location,
          recommendation,
          explanation,
          employerRelation: employerRelation(company, histories.get(userId) ?? []),
          connectionCount: contactsFor(contacts, company).length,
        })),
        rows.length - picked.length,
        rows[0]!.language,
      );
      report.digestsSent++;
      report.matchesNotified += digest.length;
    } catch (error) {
      await db
        .update(matches)
        .set({ status: "ready", notifiedAt: null })
        .where(and(inArray(matches.id, [...claimedIds]), eq(matches.status, "notified")));
      if (error instanceof RecipientUnavailableError) {
        await db.update(users).set({ notificationsEnabled: false }).where(eq(users.id, userId));
        report.recipientsDisabled++;
      } else {
        report.errors.push({ userId, error: errorMessage(error) });
      }
    }
  }
  report.durationMs = now().getTime() - startedAt.getTime();
  return report;
}
