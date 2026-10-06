import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { feedback, jobs, matchEvaluations, matches } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { contactsAtCompanies, contactsFor, rankContacts } from "../../connections/lookup.js";
import { connections } from "../../db/schema.js";
import { employerRelation, loadEmployerHistory } from "../../matching/employer.js";
import type { MatchDetails, MatchService, MatchSummary } from "../services.js";

const VISIBLE_STATUSES = ["ready", "notified"] as const;
const MAX_CONTACTS_SHOWN = 5;

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

  async whatsNew(userId: string, limit: number): Promise<MatchSummary[]> {
    const rows = await this.db
      .select({ ...summaryColumns, status: matches.status })
      .from(matches)
      .innerJoin(jobs, eq(jobs.id, matches.jobId))
      .where(and(eq(matches.userId, userId), inArray(matches.status, VISIBLE_STATUSES)))
      .orderBy(sql`${matches.status} = 'ready' desc`, asc(matches.recommendation), desc(matches.createdAt))
      .limit(limit);

    const unseen = rows.filter((r) => r.status === "ready").map((r) => r.matchId);
    if (unseen.length > 0) {
      await this.db
        .update(matches)
        .set({ status: "notified", notifiedAt: new Date() })
        .where(and(inArray(matches.id, unseen), eq(matches.status, "ready")));
    }
    const history = (await loadEmployerHistory(this.db, [userId])).get(userId) ?? [];
    const contacts = await contactsAtCompanies(this.db, userId, rows.map((r) => r.company));
    return rows.map(({ status: _, ...summary }) => ({
      ...summary,
      employerRelation: employerRelation(summary.company, history),
      connectionCount: contactsFor(contacts, summary.company).length,
    }));
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

    const history = (await loadEmployerHistory(this.db, [userId])).get(userId) ?? [];
    const contacts = contactsFor(await contactsAtCompanies(this.db, userId, [row.company]), row.company);
    const [imported] = await this.db
      .select({ at: sql<Date | null>`max(${connections.importedAt})`.mapWith((v) => (v ? new Date(v) : null)) })
      .from(connections)
      .where(eq(connections.userId, userId));
    const evidence = evaluation?.evidence;
    return {
      ...row,
      employerRelation: employerRelation(row.company, history),
      connectionCount: contacts.length,
      contacts: rankContacts(contacts, row.title).slice(0, MAX_CONTACTS_SHOWN),
      connectionsImportedAt: imported?.at ?? null,
      fitEvidence: evidence?.fitEvidence.map((e) => e.claim) ?? [],
      gaps: evidence?.gaps ?? [],
      transferableSkills: evidence?.transferableSkills ?? [],
      feedback: latestFeedback?.verdict ?? null,
    };
  }
}
