import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import { cvFileName, type CvDocumentContent } from "../../cv/document.js";
import { chooseCvLanguage, type CvLanguageChoice } from "../../cv/language.js";
import { renderCvDocx } from "../../cv/render-docx.js";
import { renderCvPdf } from "../../cv/render-pdf.js";
import type { CvTailorer } from "../../cv/tailoring.js";
import {
  careerFacts,
  careerProfiles,
  cvVersionFiles,
  cvVersionItems,
  cvVersions,
  jobs,
  matches,
  sourceDocuments,
  users,
} from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { CONVERSATION_LANGUAGES, type ConversationLanguage, type CvFileFormat } from "../../domain/enums.js";
import { errorMessage } from "../../ingestion/ingest.js";
import type { CvDecision, CvDocumentFile, CvDraftView, CvRequestOutcome, CvService, CvTailorOutcome } from "../services.js";
import { loadSnapshot } from "./profile.js";

export const STALE_REQUEST_MS = 10 * 60_000;

const RENDERERS: Record<CvFileFormat, (content: CvDocumentContent) => Promise<Uint8Array>> = { docx: renderCvDocx, pdf: renderCvPdf };

export class PgCvService implements CvService {
  constructor(
    private readonly db: Db,
    private readonly tailorer: CvTailorer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async requestTailored(userId: string, matchId: string, language?: ConversationLanguage): Promise<CvRequestOutcome> {
    const [match] = await this.db
      .select({ jobId: matches.jobId, title: jobs.title, description: jobs.description, conversation: users.preferredLanguage })
      .from(matches)
      .innerJoin(jobs, eq(jobs.id, matches.jobId))
      .innerJoin(users, eq(users.id, matches.userId))
      .where(and(eq(matches.id, matchId), eq(matches.userId, userId)));
    if (!match) return { kind: "not_found" };

    const cvs = await this.readableCvs(userId);
    const choice = chooseCvLanguage({
      requested: language ?? null,
      posting: `${match.title}\n${match.description}`,
      cvLanguages: cvs.flatMap((cv) => knownLanguage(cv.language) ?? []),
      conversation: match.conversation,
    });
    return this.open({ userId, matchId, jobId: match.jobId, choice, cvs, basedOnVersionId: null });
  }

  async requestLanguage(userId: string, versionId: string, language: ConversationLanguage): Promise<CvRequestOutcome> {
    const [base] = await this.db
      .select({ matchId: cvVersions.matchId, jobId: cvVersions.jobId })
      .from(cvVersions)
      .where(and(eq(cvVersions.id, versionId), eq(cvVersions.userId, userId), inArray(cvVersions.status, ["draft", "approved"])));
    if (!base?.matchId || !base.jobId) return { kind: "not_found" };

    const [approved] = await this.db
      .select({ id: cvVersions.id })
      .from(cvVersions)
      .where(
        and(
          eq(cvVersions.userId, userId),
          eq(cvVersions.matchId, base.matchId),
          eq(cvVersions.language, language),
          eq(cvVersions.status, "approved"),
        ),
      )
      .orderBy(desc(cvVersions.approvedAt))
      .limit(1);
    if (approved) return { kind: "approved", versionId: approved.id };
    return this.open({
      userId,
      matchId: base.matchId,
      jobId: base.jobId,
      choice: { language, source: "requested" },
      cvs: await this.readableCvs(userId),
      basedOnVersionId: versionId,
    });
  }

  private async open({
    userId,
    matchId,
    jobId,
    choice,
    cvs,
    basedOnVersionId,
  }: {
    userId: string;
    matchId: string;
    jobId: string;
    choice: CvLanguageChoice;
    cvs: { id: string; language: string | null }[];
    basedOnVersionId: string | null;
  }): Promise<CvRequestOutcome> {
    const sameRequest = and(eq(cvVersions.userId, userId), eq(cvVersions.matchId, matchId), eq(cvVersions.language, choice.language));
    await this.db
      .update(cvVersions)
      .set({ status: "failed", failureReason: "Timed out before a draft was produced" })
      .where(
        and(sameRequest, eq(cvVersions.status, "requested"), lt(cvVersions.updatedAt, new Date(this.now().getTime() - STALE_REQUEST_MS))),
      );

    const baseCv = cvs.find((cv) => cv.language === choice.language) ?? cvs[0];
    const [inserted] = await this.db
      .insert(cvVersions)
      .values({
        userId,
        matchId,
        jobId,
        language: choice.language,
        languageSource: choice.source,
        basedOnVersionId,
        sourceDocumentId: baseCv?.id,
        status: "requested",
      })
      .onConflictDoNothing()
      .returning({ id: cvVersions.id });
    if (inserted) return { kind: "requested", versionId: inserted.id };

    const [open] = await this.db
      .select({ id: cvVersions.id, status: cvVersions.status })
      .from(cvVersions)
      .where(and(sameRequest, inArray(cvVersions.status, ["requested", "draft"])));
    return open?.status === "draft" ? { kind: "draft", versionId: open.id } : { kind: "in_progress" };
  }

  /** The user's readable CVs, newest first. */
  private readableCvs(userId: string) {
    return this.db
      .select({ id: sourceDocuments.id, language: sourceDocuments.language })
      .from(sourceDocuments)
      .where(and(eq(sourceDocuments.userId, userId), eq(sourceDocuments.kind, "cv"), eq(sourceDocuments.parseStatus, "parsed")))
      .orderBy(desc(sourceDocuments.createdAt));
  }

  async tailor(userId: string, versionId: string): Promise<CvTailorOutcome> {
    const [version] = await this.db
      .select({
        title: jobs.title,
        company: jobs.company,
        description: jobs.description,
        revision: careerProfiles.revision,
        language: cvVersions.language,
        basedOnVersionId: cvVersions.basedOnVersionId,
        sourceText: sourceDocuments.extractedText,
        sourceLanguage: sourceDocuments.language,
      })
      .from(cvVersions)
      .innerJoin(jobs, eq(jobs.id, cvVersions.jobId))
      .innerJoin(careerProfiles, eq(careerProfiles.userId, cvVersions.userId))
      .leftJoin(sourceDocuments, eq(sourceDocuments.id, cvVersions.sourceDocumentId))
      .where(and(eq(cvVersions.id, versionId), eq(cvVersions.userId, userId), eq(cvVersions.status, "requested")));
    if (!version) return { kind: "not_found" };

    try {
      const profile = await loadSnapshot(this.db, userId, { verifiedOnly: true });
      const { title, company, description, language } = version;
      const tailored = await this.tailorer.tailor({
        profile,
        job: { title, company, description },
        language,
        styleReference: version.sourceLanguage === language ? version.sourceText : null,
        keep: await this.keptFacts(version.basedOnVersionId),
      });
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

  private async keptFacts(versionId: string | null): Promise<{ highlights: string[]; skills: string[] }> {
    if (!versionId) return { highlights: [], skills: [] };
    const items = await this.db
      .select({ factId: cvVersionItems.careerFactId, section: cvVersionItems.section })
      .from(cvVersionItems)
      .where(and(eq(cvVersionItems.cvVersionId, versionId), inArray(cvVersionItems.section, ["experience", "other", "skills"])))
      .orderBy(asc(cvVersionItems.section), asc(cvVersionItems.position));
    return {
      highlights: items.filter((i) => i.section !== "skills").map((i) => i.factId),
      skills: items.filter((i) => i.section === "skills").map((i) => i.factId),
    };
  }

  async draft(userId: string, versionId: string): Promise<CvDraftView | null> {
    return this.view(userId, versionId, "draft");
  }

  async document(userId: string, versionId: string, format: CvFileFormat): Promise<CvDocumentFile | null> {
    const [owner] = await this.db
      .select({ name: users.displayName, headline: careerProfiles.headline, linkedinUrl: careerProfiles.linkedinUrl, fileRef: cvVersionFiles.fileRef })
      .from(cvVersions)
      .innerJoin(users, eq(users.id, cvVersions.userId))
      .innerJoin(careerProfiles, eq(careerProfiles.userId, cvVersions.userId))
      .leftJoin(cvVersionFiles, and(eq(cvVersionFiles.cvVersionId, cvVersions.id), eq(cvVersionFiles.format, format)))
      .where(and(eq(cvVersions.id, versionId), eq(cvVersions.userId, userId), eq(cvVersions.status, "approved")));
    const view = owner && (await this.view(userId, versionId, "approved"));
    if (!owner || !view) return null;

    const name = owner.name ?? "Candidate";
    const file = { format, fileName: cvFileName(name, view.jobTitle, format), language: view.language };
    if (owner.fileRef) return { ...file, kind: "cached", fileRef: owner.fileRef };
    const { language, summary, experiences, skills, education, certifications, languages, other } = view;
    const data = await RENDERERS[format]({
      language,
      name,
      headline: owner.headline,
      contact: owner.linkedinUrl ? [owner.linkedinUrl] : [],
      summary,
      experiences,
      skills,
      education,
      certifications,
      languages,
      other,
    });
    return { ...file, kind: "rendered", data };
  }

  async saveDocumentRef(userId: string, versionId: string, format: CvFileFormat, fileRef: string): Promise<void> {
    const [version] = await this.db
      .select({ id: cvVersions.id })
      .from(cvVersions)
      .where(and(eq(cvVersions.id, versionId), eq(cvVersions.userId, userId), eq(cvVersions.status, "approved")));
    if (!version) return;
    await this.db
      .insert(cvVersionFiles)
      .values({ cvVersionId: versionId, format, fileRef })
      .onConflictDoUpdate({ target: [cvVersionFiles.cvVersionId, cvVersionFiles.format], set: { fileRef } });
  }

  private async view(userId: string, versionId: string, status: "draft" | "approved"): Promise<CvDraftView | null> {
    const [version] = await this.db
      .select({
        jobTitle: jobs.title,
        company: jobs.company,
        applicationNote: cvVersions.applicationNote,
        language: cvVersions.language,
        languageSource: cvVersions.languageSource,
      })
      .from(cvVersions)
      .innerJoin(jobs, eq(jobs.id, cvVersions.jobId))
      .where(and(eq(cvVersions.id, versionId), eq(cvVersions.userId, userId), eq(cvVersions.status, status)));
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
      language: version.language,
      languageSource: version.languageSource,
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

function knownLanguage(language: string | null): ConversationLanguage | null {
  return CONVERSATION_LANGUAGES.find((l) => l === language) ?? null;
}
