import { and, count, eq } from "drizzle-orm";
import { careerProfiles, conversationStates, masterCvs, profileSources } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { classifySource, parseLinkedinUrl, readDocumentText } from "../documents.js";
import type {
  IncomingDocument,
  OnboardingService,
  ProfileAssistant,
  ProfileReply,
} from "../services.js";
import { applyChanges, clearDraftProfile, confirmDraftProfile, loadSnapshot, toProfileView } from "./profile.js";

export type OnboardingStepKey = "linkedin" | "documents" | "analyzing" | "questions" | "review";

interface QuestionsContext {
  questions?: string[];
  index?: number;
}

const SKIP = /^\s*(skip|no|none|nope|n\/a|-)\s*[.!]?\s*$/i;
const DONE = /^\s*(done|analy[sz]e|that'?s all|finished|continue)\s*[.!]?\s*$/i;

export class PgOnboardingService implements OnboardingService {
  constructor(
    private readonly db: Db,
    private readonly assistant: ProfileAssistant,
  ) {}

  async start(userId: string): Promise<ProfileReply> {
    await this.db.transaction(async (tx) => {
      await clearDraftProfile(tx, userId);
      const reset = {
        status: "draft" as const,
        headline: null,
        summary: null,
        currentSeniority: null,
        managementScope: null,
        linkedinUrl: null,
        openToAdjacentRoles: true,
        confirmedAt: null,
      };
      await tx.insert(careerProfiles).values({ userId, ...reset }).onConflictDoUpdate({ target: careerProfiles.userId, set: reset });
      await this.setStep(tx, userId, "linkedin", {});
    });
    return { kind: "ask_linkedin" };
  }

  async answer(userId: string, step: string, context: QuestionsContext, text: string): Promise<ProfileReply[]> {
    switch (step as OnboardingStepKey) {
      case "linkedin": {
        const url = parseLinkedinUrl(text);
        if (url) await this.db.update(careerProfiles).set({ linkedinUrl: url }).where(eq(careerProfiles.userId, userId));
        await this.setStep(this.db, userId, "documents", {});
        return [{ kind: "ask_documents", linkedinSaved: url !== null }];
      }
      case "documents":
        if (DONE.test(text)) return [await this.analyze(userId)];
        await this.db.insert(profileSources).values({ userId, kind: "pasted_text", content: text });
        return [{ kind: "source_received", source: "pasted_text", fileName: null }];
      case "analyzing":
        return [{ kind: "busy" }];
      case "questions":
        return this.answerQuestion(userId, context, text);
      case "review":
        return this.correctReview(userId, text);
      default:
        return [await this.start(userId)];
    }
  }

  async addDocument(userId: string, document: IncomingDocument): Promise<ProfileReply> {
    const [state] = await this.db
      .select({ flow: conversationStates.flow, step: conversationStates.step })
      .from(conversationStates)
      .where(eq(conversationStates.userId, userId));
    if (state?.flow !== "onboarding" || (state.step !== "linkedin" && state.step !== "documents")) {
      return { kind: "document_not_expected" };
    }

    const content = await readDocumentText(document).catch((error: unknown) => {
      console.error("document text extraction failed", { userId, error });
      return null;
    });
    if (!content) return { kind: "unreadable_document" };

    const kind = classifySource(content);
    await this.db.transaction(async (tx) => {
      await tx.insert(profileSources).values({ userId, kind, fileRef: document.fileRef, fileName: document.fileName, content });
      if (kind === "cv") {
        await tx
          .insert(masterCvs)
          .values({ userId, originalFileRef: document.fileRef, originalText: content })
          .onConflictDoUpdate({
            target: masterCvs.userId,
            set: { originalFileRef: document.fileRef, originalText: content },
          });
      }
      if (state.step === "linkedin") await this.setStep(tx, userId, "documents", {});
    });
    return { kind: "source_received", source: kind, fileName: document.fileName };
  }

  async analyze(userId: string): Promise<ProfileReply> {
    const [sources] = await this.db
      .select({ n: count() })
      .from(profileSources)
      .where(eq(profileSources.userId, userId));
    if (!sources || sources.n === 0) return { kind: "need_source" };

    const claimed = await this.db
      .update(conversationStates)
      .set({ step: "analyzing" })
      .where(
        and(
          eq(conversationStates.userId, userId),
          eq(conversationStates.flow, "onboarding"),
          eq(conversationStates.step, "documents"),
        ),
      )
      .returning({ userId: conversationStates.userId });
    if (claimed.length === 0) return { kind: "busy" };

    try {
      const [profile] = await this.db
        .select({ linkedinUrl: careerProfiles.linkedinUrl })
        .from(careerProfiles)
        .where(eq(careerProfiles.userId, userId));
      const sourceRows = await this.db
        .select({ kind: profileSources.kind, content: profileSources.content })
        .from(profileSources)
        .where(eq(profileSources.userId, userId))
        .orderBy(profileSources.createdAt);
      const extraction = await this.assistant.extract({ linkedinUrl: profile?.linkedinUrl ?? null, sources: sourceRows });

      await this.db.transaction(async (tx) => {
        await applyChanges(tx, userId, extraction.changes, "draft");
        const questions = extraction.followUpQuestions.filter((q) => q.trim());
        if (questions.length > 0) await this.setStep(tx, userId, "questions", { questions, index: 0 });
        else await this.setStep(tx, userId, "review", {});
      });
    } catch (error) {
      console.error("profile extraction failed", { userId, error });
      await this.setStep(this.db, userId, "documents", {});
      return { kind: "analysis_failed" };
    }
    return this.currentPrompt(userId);
  }

  async confirm(userId: string): Promise<ProfileReply> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx
        .update(conversationStates)
        .set({ flow: "idle", step: null, context: {} })
        .where(
          and(
            eq(conversationStates.userId, userId),
            eq(conversationStates.flow, "onboarding"),
            eq(conversationStates.step, "review"),
          ),
        )
        .returning({ userId: conversationStates.userId });
      if (claimed.length === 0) return { kind: "expired" } as const;
      await confirmDraftProfile(tx, userId);
      return { kind: "onboarding_done" } as const;
    });
  }

  private async answerQuestion(userId: string, context: QuestionsContext, text: string): Promise<ProfileReply[]> {
    const questions = context.questions ?? [];
    const index = context.index ?? 0;
    const replies: ProfileReply[] = [];
    if (!SKIP.test(text)) {
      const snapshot = await loadSnapshot(this.db, userId);
      const interpretation = await this.assistant.interpret({ snapshot, message: text, question: questions[index] ?? null });
      await this.db.transaction((tx) => applyChanges(tx, userId, interpretation.changes, "draft"));
      if (interpretation.changes.length === 0 && interpretation.reply) {
        replies.push({ kind: "no_change", reply: interpretation.reply });
      }
    }
    const next = index + 1;
    if (next < questions.length) await this.setStep(this.db, userId, "questions", { questions, index: next });
    else await this.setStep(this.db, userId, "review", {});
    replies.push(await this.currentPrompt(userId));
    return replies;
  }

  private async correctReview(userId: string, text: string): Promise<ProfileReply[]> {
    const snapshot = await loadSnapshot(this.db, userId);
    const interpretation = await this.assistant.interpret({ snapshot, message: text, question: null });
    if (interpretation.changes.length === 0) {
      return [{ kind: "no_change", reply: interpretation.reply }];
    }
    await this.db.transaction((tx) => applyChanges(tx, userId, interpretation.changes, "draft"));
    return [{ kind: "review", profile: toProfileView(await loadSnapshot(this.db, userId)), note: "updated" }];
  }

  private async currentPrompt(userId: string): Promise<ProfileReply> {
    const [state] = await this.db
      .select({ step: conversationStates.step, context: conversationStates.context })
      .from(conversationStates)
      .where(eq(conversationStates.userId, userId));
    const { questions = [], index = 0 } = (state?.context ?? {}) as QuestionsContext;
    if (state?.step === "questions" && questions[index]) {
      return { kind: "question", text: questions[index], position: index + 1, total: questions.length };
    }
    return { kind: "review", profile: toProfileView(await loadSnapshot(this.db, userId)), note: null };
  }

  private async setStep(db: Db, userId: string, step: OnboardingStepKey, context: QuestionsContext) {
    await db
      .insert(conversationStates)
      .values({ userId, flow: "onboarding", step, context: { ...context } })
      .onConflictDoUpdate({
        target: conversationStates.userId,
        set: { flow: "onboarding", step, context: { ...context } },
      });
  }
}
