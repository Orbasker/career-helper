import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { ProfileChange } from "../../domain/profile.js";
import { careerProfiles, conversationStates } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type { ConversationService, ProfileAssistant, ProfileReply } from "../services.js";
import type { PgOnboardingService } from "./onboarding.js";
import { applyChanges, bumpRevision, describeChanges, loadSnapshot, toProfileView } from "./profile.js";

interface PendingEdit {
  token: string;
  changes: ProfileChange[];
}

export class PgConversationService implements ConversationService {
  constructor(
    private readonly db: Db,
    private readonly onboarding: PgOnboardingService,
    private readonly assistant: ProfileAssistant,
  ) {}

  async handleText(userId: string, text: string): Promise<ProfileReply[]> {
    const [state] = await this.db
      .select({ flow: conversationStates.flow, step: conversationStates.step, context: conversationStates.context })
      .from(conversationStates)
      .where(eq(conversationStates.userId, userId));

    if (state?.flow === "onboarding" && state.step) {
      return this.onboarding.answer(userId, state.step, state.context, text);
    }
    if (!(await this.isConfirmed(userId))) return [{ kind: "not_onboarded" }];

    const snapshot = await loadSnapshot(this.db, userId);
    const { changes, reply } = await this.assistant.interpret({ snapshot, message: text, question: null });
    if (changes.length === 0) return [{ kind: "no_change", reply }];

    const pending: PendingEdit = { token: randomBytes(6).toString("base64url"), changes };
    await this.db
      .insert(conversationStates)
      .values({ userId, flow: "profile_edit", step: "confirm", context: { ...pending } })
      .onConflictDoUpdate({
        target: conversationStates.userId,
        set: { flow: "profile_edit", step: "confirm", context: { ...pending } },
      });
    return [{ kind: "edit_proposed", token: pending.token, changes: describeChanges(changes, snapshot) }];
  }

  async applyEdit(userId: string, token: string): Promise<ProfileReply> {
    return this.db.transaction(async (tx) => {
      const pending = await this.takePendingEdit(tx, userId, token);
      if (!pending) return { kind: "expired" } as const;
      await applyChanges(tx, userId, pending.changes, "confirmed");
      await bumpRevision(tx, userId);
      return { kind: "edit_applied" } as const;
    });
  }

  async cancelEdit(userId: string, token: string): Promise<ProfileReply> {
    return this.db.transaction(async (tx) => {
      const pending = await this.takePendingEdit(tx, userId, token);
      return pending ? ({ kind: "edit_cancelled" } as const) : ({ kind: "expired" } as const);
    });
  }

  async showProfile(userId: string): Promise<ProfileReply> {
    if (!(await this.isConfirmed(userId))) return { kind: "not_onboarded" };
    return { kind: "profile", profile: toProfileView(await loadSnapshot(this.db, userId)) };
  }

  private async takePendingEdit(tx: Db, userId: string, token: string): Promise<PendingEdit | null> {
    const [state] = await tx
      .select({ context: conversationStates.context })
      .from(conversationStates)
      .where(and(eq(conversationStates.userId, userId), eq(conversationStates.flow, "profile_edit")))
      .for("update");
    const pending = state?.context as PendingEdit | undefined;
    if (!pending || pending.token !== token) return null;
    await tx
      .update(conversationStates)
      .set({ flow: "idle", step: null, context: {} })
      .where(eq(conversationStates.userId, userId));
    return pending;
  }

  private async isConfirmed(userId: string): Promise<boolean> {
    const [profile] = await this.db
      .select({ status: careerProfiles.status })
      .from(careerProfiles)
      .where(eq(careerProfiles.userId, userId));
    return profile?.status === "confirmed";
  }
}
