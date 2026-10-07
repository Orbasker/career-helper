import { and, count, eq, isNull, max, sql } from "drizzle-orm";
import type { ConversationLanguage, DocumentKind } from "../../domain/enums.js";
import { parseLanguageChoice } from "../../domain/language.js";
import { careerProfiles, conversationStates, profileSources, sourceDocuments, users } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { classifySource, parseDocument, parseLinkedinUrl } from "../documents.js";
import type {
  IncomingDocument,
  OnboardingService,
  ProfileAssistant,
  ProfileReply,
} from "../services.js";
import { applyChanges, clearDraftProfile, confirmDraftProfile, loadSnapshot, toProfileView } from "./profile.js";

export type OnboardingStepKey = "language" | "linkedin" | "documents" | "analyzing" | "questions" | "review";

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

  async start(userId: string): Promise<ProfileReply[]> {
    const [user] = await this.db
      .select({ language: users.preferredLanguage })
      .from(users)
      .where(eq(users.id, userId));
    const firstStep = user?.language ? "linkedin" : "language";
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
      await this.setStep(tx, userId, firstStep, {});
    });
    return firstStep === "language" ? [{ kind: "ask_language" }] : [{ kind: "onboarding_welcome" }, { kind: "ask_linkedin" }];
  }

  async chooseLanguage(userId: string, language: ConversationLanguage): Promise<ProfileReply[]> {
    return this.db.transaction(async (tx) => {
      await tx.update(users).set({ preferredLanguage: language }).where(eq(users.id, userId));
      const resumed = await tx
        .update(conversationStates)
        .set({ step: "linkedin", context: {} })
        .where(
          and(
            eq(conversationStates.userId, userId),
            eq(conversationStates.flow, "onboarding"),
            eq(conversationStates.step, "language"),
          ),
        )
        .returning({ userId: conversationStates.userId });
      const saved = { kind: "language_saved", language } as const;
      return resumed.length > 0 ? [saved, { kind: "onboarding_welcome" }, { kind: "ask_linkedin" }] : [saved];
    });
  }

  async answer(userId: string, step: string, context: QuestionsContext, text: string): Promise<ProfileReply[]> {
    switch (step as OnboardingStepKey) {
      case "language": {
        const language = parseLanguageChoice(text);
        return language ? this.chooseLanguage(userId, language) : [{ kind: "ask_language" }];
      }
      case "linkedin": {
        const url = parseLinkedinUrl(text);
        if (url) await this.db.update(careerProfiles).set({ linkedinUrl: url }).where(eq(careerProfiles.userId, userId));
        await this.setStep(this.db, userId, "documents", {});
        return [{ kind: "ask_documents", linkedinSaved: url !== null }];
      }
      case "documents":
        if (DONE.test(text)) return [await this.analyze(userId)];
        await this.db.insert(profileSources).values({ userId, kind: "pasted_text", content: text });
        return [{ kind: "source_received", source: "pasted_text", fileName: null, documentId: null, language: null }];
      case "analyzing":
        return [{ kind: "busy" }];
      case "questions":
        return this.answerQuestion(userId, context, text);
      case "review":
        return this.correctReview(userId, text);
      default:
        return this.start(userId);
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

    const parsed = await parseDocument(document);
    const file = {
      userId,
      fileName: document.fileName,
      mimeType: document.mimeType,
      format: parsed.format,
      fileRef: document.fileRef,
      sizeBytes: document.sizeBytes ?? document.data.byteLength,
      label: document.label?.trim() || null,
    };
    if (parsed.status !== "parsed") {
      console.error("document parsing failed", { userId, format: parsed.format, error: parsed.error });
      await this.db.insert(sourceDocuments).values({ ...file, parseStatus: parsed.status, parseError: parsed.error });
      return parsed.format === "doc" ? { kind: "legacy_doc" } : { kind: "unreadable_document" };
    }

    const kind = classifySource(parsed.text);
    const documentId = await this.db.transaction(async (tx) => {
      const version = await nextVersion(tx, userId, kind, parsed.language);
      const [row] = await tx
        .insert(sourceDocuments)
        .values({ ...file, kind, language: parsed.language, version, extractedText: parsed.text, parseStatus: "parsed" })
        .returning({ id: sourceDocuments.id });
      await tx.insert(profileSources).values({ userId, kind, documentId: row!.id });
      if (state.step === "linkedin") await this.setStep(tx, userId, "documents", {});
      return row!.id;
    });
    return { kind: "source_received", source: kind, fileName: document.fileName, documentId, language: parsed.language };
  }

  async setDocumentLanguage(userId: string, documentId: string, language: ConversationLanguage): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ kind: sourceDocuments.kind, language: sourceDocuments.language, version: sourceDocuments.version })
        .from(sourceDocuments)
        .where(and(eq(sourceDocuments.id, documentId), eq(sourceDocuments.userId, userId)))
        .for("update");
      if (!document) return false;
      const version =
        document.kind && document.language !== language
          ? await nextVersion(tx, userId, document.kind, language)
          : document.version;
      await tx.update(sourceDocuments).set({ language, languageConfirmed: true, version }).where(eq(sourceDocuments.id, documentId));
      return true;
    });
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
        .select({
          kind: profileSources.kind,
          content: sql<string>`coalesce(${profileSources.content}, ${sourceDocuments.extractedText})`,
          documentId: profileSources.documentId,
          language: sourceDocuments.language,
        })
        .from(profileSources)
        .leftJoin(sourceDocuments, eq(sourceDocuments.id, profileSources.documentId))
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

async function nextVersion(db: Db, userId: string, kind: DocumentKind, language: string | null): Promise<number> {
  const [row] = await db
    .select({ latest: max(sourceDocuments.version) })
    .from(sourceDocuments)
    .where(
      and(
        eq(sourceDocuments.userId, userId),
        eq(sourceDocuments.kind, kind),
        language === null ? isNull(sourceDocuments.language) : eq(sourceDocuments.language, language),
      ),
    );
  return (row?.latest ?? 0) + 1;
}
