import { and, asc, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import {
  applicationEvents,
  applications,
  careerProfiles,
  conversationStates,
  cvVersions,
  jobs,
  matches,
} from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type { ApplicationEventSource, ApplicationStatus } from "../../domain/enums.js";
import { normalizeCompany, normalizeTitle } from "../../ingestion/normalize.js";
import type {
  ApplicationService,
  ApplicationSummary,
  ApplicationView,
  ApplyOutcome,
  ManualApplication,
  StatusChange,
} from "../services.js";

export const PENDING_APPLICATION_TTL_MS = 10 * 60_000;
const MAX_NOTE_LENGTH = 1000;

type PendingStep = "details" | "note";

/** An application is for a match's job when it is for its duplicate group or, when logged by hand, the same company and title. */
const isForMatchJob = (): SQL =>
  sql`${applications.userId} = ${matches.userId} and (${applications.duplicateGroupId} = ${matches.duplicateGroupId} or (${applications.normalizedCompany} = ${jobs.normalizedCompany} and ${applications.normalizedTitle} = ${jobs.normalizedTitle}))`;

/** True for a match the user has not applied to; the query must join the match's job. */
export const notAppliedTo = (): SQL => sql`not exists (select 1 from ${applications} where ${isForMatchJob()})`;

const summaryColumns = {
  id: applications.id,
  title: applications.title,
  company: applications.company,
  status: applications.status,
  appliedAt: applications.appliedAt,
  lastEventAt: applications.lastEventAt,
};

export class PgApplicationService implements ApplicationService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(userId: string): Promise<ApplicationSummary[] | null> {
    if (!(await this.isConfirmed(userId))) return null;
    return this.db
      .select(summaryColumns)
      .from(applications)
      .where(eq(applications.userId, userId))
      .orderBy(desc(applications.lastEventAt), desc(applications.id));
  }

  async get(userId: string, applicationId: string): Promise<ApplicationView | null> {
    return this.view(this.db, userId, applicationId);
  }

  async applyToMatch(userId: string, matchId: string): Promise<ApplyOutcome> {
    const [match] = await this.db
      .select({ groupId: matches.duplicateGroupId })
      .from(matches)
      .where(and(eq(matches.id, matchId), eq(matches.userId, userId)));
    if (!match) return { kind: "not_found" };
    const [cv] = await this.db
      .select({ id: cvVersions.id })
      .from(cvVersions)
      .where(and(eq(cvVersions.userId, userId), eq(cvVersions.matchId, matchId), eq(cvVersions.status, "approved")))
      .orderBy(desc(cvVersions.approvedAt))
      .limit(1);
    return this.applyForMatch(userId, matchId, cv?.id ?? null);
  }

  async applyWithCv(userId: string, versionId: string): Promise<ApplyOutcome> {
    const [version] = await this.db
      .select({ matchId: cvVersions.matchId })
      .from(cvVersions)
      .where(and(eq(cvVersions.id, versionId), eq(cvVersions.userId, userId), eq(cvVersions.status, "approved")));
    if (!version?.matchId) return { kind: "not_found" };
    return this.applyForMatch(userId, version.matchId, versionId);
  }

  async logManual(userId: string, details: ManualApplication): Promise<ApplyOutcome> {
    if (!(await this.isConfirmed(userId))) return { kind: "not_found" };
    const normalizedCompany = normalizeCompany(details.company);
    const normalizedTitle = normalizeTitle(details.title);
    const sameJob = and(eq(jobs.normalizedCompany, normalizedCompany ?? ""), eq(jobs.normalizedTitle, normalizedTitle ?? ""));
    const [match] = await this.db
      .select({ id: matches.id })
      .from(matches)
      .innerJoin(jobs, eq(jobs.id, matches.jobId))
      .where(and(eq(matches.userId, userId), sameJob))
      .orderBy(desc(matches.createdAt))
      .limit(1);
    if (match) {
      const outcome = await this.applyToMatch(userId, match.id);
      if (outcome.kind === "created" && details.url && !outcome.application.sourceUrl) {
        await this.db.update(applications).set({ sourceUrl: details.url }).where(eq(applications.id, outcome.application.id));
        return { kind: "created", application: { ...outcome.application, sourceUrl: details.url } };
      }
      return outcome;
    }

    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: applications.id })
        .from(applications)
        .where(
          and(
            eq(applications.userId, userId),
            eq(applications.normalizedCompany, normalizedCompany ?? ""),
            eq(applications.normalizedTitle, normalizedTitle ?? ""),
          ),
        )
        .limit(1);
      if (existing) return { kind: "exists", application: (await this.view(tx, userId, existing.id))! } as const;
      const at = this.now();
      const [row] = await tx
        .insert(applications)
        .values({
          userId,
          company: details.company,
          title: details.title,
          normalizedCompany,
          normalizedTitle,
          sourceUrl: details.url,
          appliedAt: at,
          lastEventAt: at,
        })
        .returning({ id: applications.id });
      await tx.insert(applicationEvents).values({
        applicationId: row!.id,
        kind: "status_changed",
        toStatus: "applied",
        source: "user",
        createdAt: at,
      });
      return { kind: "created", application: (await this.view(tx, userId, row!.id))! } as const;
    });
  }

  async setStatus(
    userId: string,
    applicationId: string,
    status: ApplicationStatus,
    origin: { source: ApplicationEventSource; evidenceRef?: string | null } = { source: "user" },
  ): Promise<StatusChange> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: applications.status })
        .from(applications)
        .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)))
        .for("update");
      if (!current) return { kind: "not_found" } as const;
      if (current.status !== status) {
        const at = this.now();
        await tx.update(applications).set({ status, lastEventAt: at }).where(eq(applications.id, applicationId));
        await tx.insert(applicationEvents).values({
          applicationId,
          kind: "status_changed",
          fromStatus: current.status,
          toStatus: status,
          source: origin.source,
          evidenceRef: origin.evidenceRef ?? null,
          createdAt: at,
        });
      }
      const application = (await this.view(tx, userId, applicationId))!;
      return { kind: current.status === status ? "unchanged" : "changed", application } as const;
    });
  }

  async awaitDetails(userId: string): Promise<boolean> {
    if (!(await this.isConfirmed(userId))) return false;
    await this.await(userId, "details", {});
    return true;
  }

  async takeDetails(userId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => (await this.take(tx, userId, "details")) !== null);
  }

  async awaitNote(userId: string, applicationId: string): Promise<ApplicationView | null> {
    const application = await this.get(userId, applicationId);
    if (!application) return null;
    await this.await(userId, "note", { applicationId });
    return application;
  }

  async takeNote(userId: string, text: string): Promise<ApplicationView | null> {
    const note = text.trim().slice(0, MAX_NOTE_LENGTH).trim();
    return this.db.transaction(async (tx) => {
      const pending = await this.take(tx, userId, "note");
      const applicationId = pending?.applicationId;
      if (!applicationId || !note) return null;
      const at = this.now();
      const [row] = await tx
        .update(applications)
        .set({ notes: note, lastEventAt: at })
        .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)))
        .returning({ id: applications.id });
      if (!row) return null;
      await tx.insert(applicationEvents).values({ applicationId, kind: "note_added", note, source: "user", createdAt: at });
      return this.view(tx, userId, applicationId);
    });
  }

  private async applyForMatch(userId: string, matchId: string, cvVersionId: string | null): Promise<ApplyOutcome> {
    return this.db.transaction(async (tx) => {
      const [job] = await tx
        .select({
          groupId: matches.duplicateGroupId,
          title: jobs.title,
          company: jobs.company,
          sourceUrl: jobs.sourceUrl,
          normalizedCompany: jobs.normalizedCompany,
          normalizedTitle: jobs.normalizedTitle,
        })
        .from(matches)
        .innerJoin(jobs, eq(jobs.id, matches.jobId))
        .where(and(eq(matches.id, matchId), eq(matches.userId, userId)));
      if (!job) return { kind: "not_found" } as const;
      const at = this.now();
      const [created] = await tx
        .insert(applications)
        .values({
          userId,
          matchId,
          duplicateGroupId: job.groupId,
          company: job.company,
          title: job.title,
          normalizedCompany: job.normalizedCompany ?? normalizeCompany(job.company),
          normalizedTitle: job.normalizedTitle ?? normalizeTitle(job.title),
          sourceUrl: job.sourceUrl,
          cvVersionId,
          appliedAt: at,
          lastEventAt: at,
        })
        .onConflictDoNothing()
        .returning({ id: applications.id });
      if (created) {
        await tx.insert(applicationEvents).values({
          applicationId: created.id,
          kind: "status_changed",
          toStatus: "applied",
          cvVersionId,
          source: "user",
          createdAt: at,
        });
        return { kind: "created", application: (await this.view(tx, userId, created.id))! } as const;
      }

      const [existing] = await tx
        .select({ id: applications.id, cvVersionId: applications.cvVersionId })
        .from(applications)
        .where(and(eq(applications.userId, userId), eq(applications.duplicateGroupId, job.groupId)))
        .for("update");
      if (!existing) return { kind: "not_found" } as const;
      if (cvVersionId && existing.cvVersionId !== cvVersionId) {
        await tx.update(applications).set({ cvVersionId, lastEventAt: at }).where(eq(applications.id, existing.id));
        await tx.insert(applicationEvents).values({ applicationId: existing.id, kind: "cv_linked", cvVersionId, source: "user", createdAt: at });
      }
      return { kind: "exists", application: (await this.view(tx, userId, existing.id))! } as const;
    });
  }

  private async view(db: Db, userId: string, applicationId: string): Promise<ApplicationView | null> {
    const [row] = await db
      .select({
        ...summaryColumns,
        matchId: applications.matchId,
        sourceUrl: applications.sourceUrl,
        cvLanguage: cvVersions.language,
        notes: applications.notes,
      })
      .from(applications)
      .leftJoin(cvVersions, eq(cvVersions.id, applications.cvVersionId))
      .where(and(eq(applications.id, applicationId), eq(applications.userId, userId)));
    if (!row) return null;
    const events = await db
      .select({
        kind: applicationEvents.kind,
        fromStatus: applicationEvents.fromStatus,
        toStatus: applicationEvents.toStatus,
        note: applicationEvents.note,
        cvLanguage: cvVersions.language,
        source: applicationEvents.source,
        at: applicationEvents.createdAt,
      })
      .from(applicationEvents)
      .leftJoin(cvVersions, eq(cvVersions.id, applicationEvents.cvVersionId))
      .where(eq(applicationEvents.applicationId, applicationId))
      .orderBy(asc(applicationEvents.createdAt), asc(applicationEvents.id));
    return { ...row, events };
  }

  private async await(userId: string, step: PendingStep, context: Record<string, unknown>): Promise<void> {
    const state = {
      flow: "application" as const,
      step,
      context,
      expiresAt: new Date(this.now().getTime() + PENDING_APPLICATION_TTL_MS),
    };
    await this.db
      .insert(conversationStates)
      .values({ userId, ...state })
      .onConflictDoUpdate({ target: conversationStates.userId, set: state });
  }

  private async take(tx: Db, userId: string, step: PendingStep): Promise<{ applicationId?: string } | null> {
    const [state] = await tx
      .select({ context: conversationStates.context })
      .from(conversationStates)
      .where(
        and(
          eq(conversationStates.userId, userId),
          eq(conversationStates.flow, "application"),
          eq(conversationStates.step, step),
          gt(conversationStates.expiresAt, this.now()),
        ),
      )
      .for("update");
    if (!state) return null;
    await tx
      .update(conversationStates)
      .set({ flow: "idle", step: null, context: {}, expiresAt: null })
      .where(eq(conversationStates.userId, userId));
    return state.context as { applicationId?: string };
  }

  private async isConfirmed(userId: string): Promise<boolean> {
    const [profile] = await this.db
      .select({ status: careerProfiles.status })
      .from(careerProfiles)
      .where(eq(careerProfiles.userId, userId));
    return profile?.status === "confirmed";
  }
}

/** The user's application per match, for the matches given. */
export async function applicationsForMatches(
  db: Db,
  userId: string,
  matchIds: string[],
): Promise<Map<string, { id: string; status: ApplicationStatus }>> {
  if (matchIds.length === 0) return new Map();
  const rows = await db
    .select({ matchId: matches.id, id: applications.id, status: applications.status })
    .from(matches)
    .innerJoin(jobs, eq(jobs.id, matches.jobId))
    .innerJoin(applications, isForMatchJob())
    .where(and(eq(matches.userId, userId), inArray(matches.id, matchIds)));
  return new Map(rows.map(({ matchId, ...application }) => [matchId, application]));
}
