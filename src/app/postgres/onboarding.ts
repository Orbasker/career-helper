import { eq } from "drizzle-orm";
import { careerProfiles, conversationStates, masterCvs, preferences } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type { OnboardingService, OnboardingStep } from "../services.js";

const STEPS = [
  { key: "cv", question: "Paste the text of your current CV (or a short summary of your work history)." },
  { key: "targets", question: "Which roles are you aiming for? Mention adjacent directions you'd consider too." },
  { key: "constraints", question: "Any hard constraints? (location / commute, work mode, salary, hours…). Reply \"none\" if not." },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

export class PgOnboardingService implements OnboardingService {
  constructor(private readonly db: Db) {}

  async start(userId: string): Promise<OnboardingStep> {
    const first = STEPS[0];
    await this.db
      .insert(conversationStates)
      .values({ userId, flow: "onboarding", step: first.key, context: {} })
      .onConflictDoUpdate({
        target: conversationStates.userId,
        set: { flow: "onboarding", step: first.key, context: {} },
      });
    return { done: false, question: first.question };
  }

  async answer(userId: string, step: string, text: string): Promise<OnboardingStep> {
    const index = STEPS.findIndex((s) => s.key === step);
    if (index === -1) return this.start(userId);

    await this.db.transaction(async (tx) => {
      await this.persistAnswer(tx, userId, STEPS[index]!.key, text);
      const next = STEPS[index + 1];
      if (next) {
        await tx.update(conversationStates).set({ step: next.key }).where(eq(conversationStates.userId, userId));
      } else {
        await tx.insert(careerProfiles).values({ userId }).onConflictDoNothing();
        await tx
          .update(conversationStates)
          .set({ flow: "idle", step: null, context: {} })
          .where(eq(conversationStates.userId, userId));
      }
    });

    const next = STEPS[index + 1];
    return next ? { done: false, question: next.question } : { done: true };
  }

  private async persistAnswer(tx: Db, userId: string, step: StepKey, text: string) {
    switch (step) {
      case "cv":
        await tx
          .insert(masterCvs)
          .values({ userId, originalText: text })
          .onConflictDoUpdate({ target: masterCvs.userId, set: { originalText: text } });
        return;
      case "targets":
        await tx.insert(preferences).values({
          userId,
          kind: "target_role",
          dimension: "role",
          value: { type: "free_text", text },
          label: text,
          origin: "onboarding",
        });
        return;
      case "constraints":
        if (/^\s*none\s*$/i.test(text)) return;
        await tx.insert(preferences).values({
          userId,
          kind: "hard_constraint",
          dimension: "other",
          value: { type: "free_text", text },
          label: text,
          origin: "onboarding",
        });
        return;
    }
  }
}
