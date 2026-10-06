import { eq } from "drizzle-orm";
import { conversationStates, preferences } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type { ConversationService, TextOutcome } from "../services.js";
import type { PgOnboardingService } from "./onboarding.js";

export class PgConversationService implements ConversationService {
  constructor(
    private readonly db: Db,
    private readonly onboarding: PgOnboardingService,
  ) {}

  async handleText(userId: string, text: string): Promise<TextOutcome> {
    const [state] = await this.db
      .select({ flow: conversationStates.flow, step: conversationStates.step })
      .from(conversationStates)
      .where(eq(conversationStates.userId, userId));

    if (state?.flow === "onboarding" && state.step) {
      return { kind: "onboarding", step: await this.onboarding.answer(userId, state.step, text) };
    }

    await this.db.insert(preferences).values({
      userId,
      kind: "soft_preference",
      dimension: "other",
      value: { type: "free_text", text },
      label: text,
      origin: "user_stated",
    });
    return { kind: "preference_noted" };
  }
}
