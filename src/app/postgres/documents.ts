import { and, count, desc, eq, gt, isNotNull, isNull, ne } from "drizzle-orm";
import { CONVERSATION_LANGUAGES, type ConversationLanguage } from "../../domain/enums.js";
import { careerFacts, careerProfiles, conversationStates, sourceDocuments, workExperiences } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type {
  DefaultRequestOutcome,
  DocumentName,
  DocumentService,
  SetDefaultOutcome,
  SourceDocumentView,
} from "../services.js";

const PENDING_DOCUMENT_ACTION_TTL_MS = 10 * 60_000;
const MAX_LABEL_LENGTH = 60;

type PendingAction = "label" | "replace";

const isLanguage = (value: string | null): value is ConversationLanguage =>
  CONVERSATION_LANGUAGES.some((language) => language === value);

const isDefaultCandidate = (d: SourceDocumentView) => d.kind === "cv" && d.parseStatus === "parsed" && d.language !== null;

export class PgDocumentService implements DocumentService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(userId: string): Promise<SourceDocumentView[] | null> {
    if (!(await this.isConfirmed(userId))) return null;
    return this.views(this.db, userId);
  }

  async get(userId: string, documentId: string): Promise<SourceDocumentView | null> {
    return (await this.views(this.db, userId)).find((d) => d.id === documentId) ?? null;
  }

  async setDefault(userId: string, documentId: string): Promise<SetDefaultOutcome> {
    return this.db.transaction(async (tx) => {
      const [document] = await tx
        .select({ kind: sourceDocuments.kind, language: sourceDocuments.language, parseStatus: sourceDocuments.parseStatus })
        .from(sourceDocuments)
        .where(this.owned(userId, documentId))
        .for("update");
      if (!document) return { kind: "not_found" } as const;
      if (document.kind !== "cv" || document.parseStatus !== "parsed" || !document.language) return { kind: "not_eligible" } as const;
      await tx
        .update(sourceDocuments)
        .set({ isDefault: false })
        .where(
          and(
            eq(sourceDocuments.userId, userId),
            eq(sourceDocuments.language, document.language),
            eq(sourceDocuments.isDefault, true),
            ne(sourceDocuments.id, documentId),
          ),
        );
      await tx.update(sourceDocuments).set({ isDefault: true }).where(eq(sourceDocuments.id, documentId));
      const view = (await this.views(tx, userId)).find((d) => d.id === documentId)!;
      return { kind: "set", document: view } as const;
    });
  }

  async requestDefault(userId: string, language: ConversationLanguage | null): Promise<DefaultRequestOutcome> {
    const documents = await this.list(userId);
    if (!documents) return { kind: "not_onboarded" };
    const candidates = documents.filter((d) => isDefaultCandidate(d) && (language === null || d.language === language));
    if (candidates.length === 0) return { kind: "none", language };
    if (candidates.length > 1) return { kind: "choose", language, documents: candidates };
    const outcome = await this.setDefault(userId, candidates[0]!.id);
    return outcome.kind === "set" ? outcome : { kind: "none", language };
  }

  async awaitLabel(userId: string, documentId: string): Promise<SourceDocumentView | null> {
    return this.awaitAction(userId, documentId, "label");
  }

  async takeLabel(userId: string, text: string): Promise<SourceDocumentView | null> {
    const label = text.trim().slice(0, MAX_LABEL_LENGTH).trim();
    const documentId = await this.db.transaction(async (tx) => {
      const pending = await this.takeAction(tx, userId, "label");
      if (!pending || !label) return null;
      const [row] = await tx
        .update(sourceDocuments)
        .set({ label })
        .where(this.owned(userId, pending))
        .returning({ id: sourceDocuments.id });
      return row?.id ?? null;
    });
    return documentId ? this.get(userId, documentId) : null;
  }

  async awaitReplacement(userId: string, documentId: string): Promise<SourceDocumentView | null> {
    return this.awaitAction(userId, documentId, "replace");
  }

  /** The document the user's next upload should replace, if they asked to replace one recently. */
  async pendingReplacement(userId: string): Promise<string | null> {
    const [state] = await this.db
      .select({ context: conversationStates.context })
      .from(conversationStates)
      .where(this.pendingState(userId, "replace"));
    return (state?.context as { documentId?: string } | undefined)?.documentId ?? null;
  }

  /** Retires `replacedId` for the new document, which inherits its label and same-language default; null when no longer pending. */
  async replace(tx: Db, userId: string, replacedId: string, documentId: string): Promise<DocumentName | null> {
    if ((await this.takeAction(tx, userId, "replace")) !== replacedId) return null;
    const [old] = await tx
      .select({
        kind: sourceDocuments.kind,
        fileName: sourceDocuments.fileName,
        label: sourceDocuments.label,
        language: sourceDocuments.language,
        isDefault: sourceDocuments.isDefault,
      })
      .from(sourceDocuments)
      .where(this.owned(userId, replacedId))
      .for("update");
    if (!old) return null;
    const [added] = await tx
      .select({ kind: sourceDocuments.kind, language: sourceDocuments.language, label: sourceDocuments.label })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.id, documentId));
    await tx.update(sourceDocuments).set({ removedAt: this.now(), isDefault: false }).where(eq(sourceDocuments.id, replacedId));
    await tx
      .update(sourceDocuments)
      .set({
        label: added?.label ?? old.label,
        isDefault: old.isDefault && added?.kind === "cv" && added.language === old.language,
      })
      .where(eq(sourceDocuments.id, documentId));
    return { kind: old.kind, fileName: old.fileName, label: old.label };
  }

  async remove(userId: string, documentId: string): Promise<SourceDocumentView | null> {
    const document = await this.get(userId, documentId);
    if (!document) return null;
    const [removed] = await this.db
      .update(sourceDocuments)
      .set({ removedAt: this.now(), isDefault: false })
      .where(this.owned(userId, documentId))
      .returning({ id: sourceDocuments.id });
    return removed ? document : null;
  }

  private async awaitAction(userId: string, documentId: string, action: PendingAction): Promise<SourceDocumentView | null> {
    if (!(await this.isConfirmed(userId))) return null;
    const document = await this.get(userId, documentId);
    if (!document) return null;
    const state = {
      flow: "cv_library" as const,
      step: action,
      context: { documentId },
      expiresAt: new Date(this.now().getTime() + PENDING_DOCUMENT_ACTION_TTL_MS),
    };
    await this.db
      .insert(conversationStates)
      .values({ userId, ...state })
      .onConflictDoUpdate({ target: conversationStates.userId, set: state });
    return document;
  }

  private async takeAction(tx: Db, userId: string, action: PendingAction): Promise<string | null> {
    const [state] = await tx
      .select({ context: conversationStates.context })
      .from(conversationStates)
      .where(this.pendingState(userId, action))
      .for("update");
    if (!state) return null;
    await tx
      .update(conversationStates)
      .set({ flow: "idle", step: null, context: {}, expiresAt: null })
      .where(eq(conversationStates.userId, userId));
    return (state.context as { documentId?: string }).documentId ?? null;
  }

  private pendingState(userId: string, action: PendingAction) {
    return and(
      eq(conversationStates.userId, userId),
      eq(conversationStates.flow, "cv_library"),
      eq(conversationStates.step, action),
      gt(conversationStates.expiresAt, this.now()),
    );
  }

  private owned(userId: string, documentId: string) {
    return and(eq(sourceDocuments.id, documentId), eq(sourceDocuments.userId, userId), isNull(sourceDocuments.removedAt));
  }

  private async views(db: Db, userId: string): Promise<SourceDocumentView[]> {
    const rows = await db
      .select({
        id: sourceDocuments.id,
        kind: sourceDocuments.kind,
        fileName: sourceDocuments.fileName,
        label: sourceDocuments.label,
        format: sourceDocuments.format,
        language: sourceDocuments.language,
        languageConfirmed: sourceDocuments.languageConfirmed,
        version: sourceDocuments.version,
        parseStatus: sourceDocuments.parseStatus,
        chosen: sourceDocuments.isDefault,
        createdAt: sourceDocuments.createdAt,
      })
      .from(sourceDocuments)
      .where(and(eq(sourceDocuments.userId, userId), isNull(sourceDocuments.removedAt)))
      .orderBy(desc(sourceDocuments.createdAt), desc(sourceDocuments.id));
    const factCounts = new Map<string, number>();
    for (const table of [careerFacts, workExperiences]) {
      const counts = await db
        .select({ documentId: table.sourceDocumentId, n: count() })
        .from(table)
        .where(and(eq(table.userId, userId), eq(table.verificationStatus, "verified"), isNotNull(table.sourceDocumentId)))
        .groupBy(table.sourceDocumentId);
      for (const { documentId, n } of counts) factCounts.set(documentId!, (factCounts.get(documentId!) ?? 0) + n);
    }
    const views: SourceDocumentView[] = rows.map(({ chosen: _, language, ...row }) => ({
      ...row,
      language: isLanguage(language) ? language : null,
      isDefault: false,
      factCount: factCounts.get(row.id) ?? 0,
    }));
    for (const language of CONVERSATION_LANGUAGES) {
      const candidates = views.filter((d) => isDefaultCandidate(d) && d.language === language);
      const chosenId = rows.find((r) => r.chosen && r.language === language)?.id;
      const used = candidates.find((d) => d.id === chosenId) ?? candidates[0];
      if (used) used.isDefault = true;
    }
    return views;
  }

  private async isConfirmed(userId: string): Promise<boolean> {
    const [profile] = await this.db
      .select({ status: careerProfiles.status })
      .from(careerProfiles)
      .where(eq(careerProfiles.userId, userId));
    return profile?.status === "confirmed";
  }
}
