import { and, asc, eq, inArray, lt } from "drizzle-orm";
import type { CvTailorer } from "../../cv/tailoring.js";
import { careerFacts, careerProfiles, cvVersionItems, cvVersions, jobs, masterCvs, matches } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { errorMessage } from "../../ingestion/ingest.js";
import type { CvDecision, CvDraftView, CvRequestOutcome, CvService, CvTailorOutcome } from "../services.js";
import { loadSnapshot } from "./profile.js";

export const STALE_REQUEST_MS = 10 * 60_000;

export class PgCvService implements CvService {
  constructor(
    private readonly db: Db,
    private readonly tailorer: CvTailorer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async requestTailored(userId: string, matchId: string): Promise<CvRequestOutcome> {
    const [match] = await this.db
      .select({ jobId: matches.jobId })
      .from(matches)
      .where(and(eq(matches.id, matchId), eq(matches.userId, userId)));
    if (!match) return { kind: "not_found" };

    await this.db
      .update(cvVersions)
      .set({ status: "failed", failureReason: "Timed out before a draft was produced" })
      .where(
        and(
          eq(cvVersions.userId, userId),
          eq(cvVersions.matchId, matchId),
          eq(cvVersions.status, "requested"),
          lt(cvVersions.updatedAt, new Date(this.now().getTime() - STALE_REQUEST_MS)),
        ),
      );

    const [masterCv] = await this.db.select({ id: masterCvs.id }).from(masterCvs).where(eq(masterCvs.userId, userId));
    const [inserted] = await this.db
      .insert(cvVersions)
      .values({ userId, matchId, jobId: match.jobId, masterCvId: masterCv?.id, status: "requested" })
      .onConflictDoNothing()
      .returning({ id: cvVersions.id });
    if (inserted) return { kind: "requested", versionId: inserted.id };

    const [open] = await this.db
      .select({ id: cvVersions.id, status: cvVersions.status })
      .from(cvVersions)
      .where(and(eq(cvVersions.userId, userId), eq(cvVersions.matchId, matchId), inArray(cvVersions.status, ["requested", "draft"])));
    return open?.status === "draft" ? { kind: "draft", versionId: open.id } : { kind: "in_progress" };
  }

  async tailor(userId: string, versionId: string): Promise<CvTailorOutcome> {
    const [version] = await this.db
      .select({ title: jobs.title, company: jobs.company, description: jobs.description, revision: careerProfiles.revision })
      .from(cvVersions)
      .innerJoin(jobs, eq(jobs.id, cvVersions.jobId))
      .innerJoin(careerProfiles, eq(careerProfiles.userId, cvVersions.userId))
      .where(and(eq(cvVersions.id, versionId), eq(cvVersions.userId, userId), eq(cvVersions.status, "requested")));
    if (!version) return { kind: "not_found" };

    try {
      const profile = await loadSnapshot(this.db, userId, { verifiedOnly: true });
      const { title, company, description } = version;
      const tailored = await this.tailorer.tailor({ profile, job: { title, company, description } });
      if (tailored.violations.length) {
        console.warn(JSON.stringify({ event: "cv.tailor.violations", versionId, violations: tailored.violations }));
      }
      const saved = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(cvVersions)
          .set({
            status: "draft",
            applicationNote: tailored.applicationNote,
            profileRevision: version.revision,
            model: this.tailorer.model,
            promptVersion: this.tailorer.promptVersion,
          })
          .where(and(eq(cvVersions.id, versionId), eq(cvVersions.status, "requested")))
          .returning({ id: cvVersions.id });
        if (!row) return false;
        if (tailored.items.length) {
          await tx.insert(cvVersionItems).values(
            tailored.items.map((item) => ({
              cvVersionId: versionId,
              careerFactId: item.careerFactId,
              section: item.section,
              position: item.position,
              generatedText: item.text,
            })),
          );
        }
        return true;
      });
      if (!saved) return { kind: "not_found" };
    } catch (error) {
      await this.db
        .update(cvVersions)
        .set({ status: "failed", failureReason: errorMessage((error as { cause?: unknown }).cause ?? error) })
        .where(and(eq(cvVersions.id, versionId), eq(cvVersions.status, "requested")));
      return { kind: "failed" };
    }

    const draft = await this.draft(userId, versionId);
    return draft ? { kind: "draft", draft } : { kind: "not_found" };
  }

  async draft(userId: string, versionId: string): Promise<CvDraftView | null> {
    const [version] = await this.db
      .select({ jobTitle: jobs.title, company: jobs.company, applicationNote: cvVersions.applicationNote })
      .from(cvVersions)
      .innerJoin(jobs, eq(jobs.id, cvVersions.jobId))
      .where(and(eq(cvVersions.id, versionId), eq(cvVersions.userId, userId), eq(cvVersions.status, "draft")));
    if (!version) return null;

    const items = await this.db
      .select({ section: cvVersionItems.section, text: cvVersionItems.generatedText, experienceId: careerFacts.workExperienceId })
      .from(cvVersionItems)
      .innerJoin(careerFacts, eq(careerFacts.id, cvVersionItems.careerFactId))
      .where(eq(cvVersionItems.cvVersionId, versionId))
      .orderBy(asc(cvVersionItems.section), asc(cvVersionItems.position));
    const { experiences } = await loadSnapshot(this.db, userId, { verifiedOnly: true });

    const texts = (section: string) => items.filter((i) => i.section === section).map((i) => i.text);
    return {
      versionId,
      jobTitle: version.jobTitle,
      company: version.company,
      summary: texts("summary"),
      experiences: experiences.map((e) => ({
        title: e.title,
        employer: e.employer,
        startDate: e.startDate,
        endDate: e.endDate,
        isCurrent: e.isCurrent,
        bullets: items.filter((i) => i.section === "experience" && i.experienceId === e.id).map((i) => i.text),
      })),
      skills: texts("skills"),
      education: texts("education"),
      certifications: texts("certifications"),
      languages: texts("languages"),
      other: texts("other"),
      applicationNote: version.applicationNote,
    };
  }

  async decide(userId: string, versionId: string, approve: boolean): Promise<CvDecision> {
    const [row] = await this.db
      .update(cvVersions)
      .set(approve ? { status: "approved", approvedAt: this.now() } : { status: "rejected" })
      .where(and(eq(cvVersions.id, versionId), eq(cvVersions.userId, userId), eq(cvVersions.status, "draft")))
      .returning({ id: cvVersions.id });
    if (!row) return "not_found";
    return approve ? "approved" : "discarded";
  }
}
