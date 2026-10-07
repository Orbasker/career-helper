import { and, eq, isNull, sql } from "drizzle-orm";
import { careerProfiles, users } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type { TelegramIdentity, UserService, UserSession } from "../services.js";

export class PgUserService implements UserService {
  constructor(private readonly db: Db) {}

  async ensureUser(identity: TelegramIdentity): Promise<UserSession> {
    const [user] = await this.db
      .insert(users)
      .values({
        telegramUserId: identity.telegramUserId,
        telegramChatId: identity.chatId,
        displayName: identity.displayName,
        locale: identity.locale,
      })
      .onConflictDoUpdate({
        target: users.telegramUserId,
        set: {
          telegramChatId: identity.chatId,
          // Messaging the bot means the user can receive digests again after blocking it.
          notificationsEnabled: true,
          displayName: sql`coalesce(excluded.display_name, ${users.displayName})`,
          locale: sql`coalesce(excluded.locale, ${users.locale})`,
        },
      })
      .returning({ id: users.id, language: users.preferredLanguage, languagePromptedAt: users.languagePromptedAt });
    const [profile] = await this.db
      .select({ status: careerProfiles.status })
      .from(careerProfiles)
      .where(eq(careerProfiles.userId, user!.id));
    const hasProfile = profile?.status === "confirmed";
    return {
      userId: user!.id,
      hasProfile,
      language: user!.language,
      languagePromptDue: hasProfile && !user!.language && !user!.languagePromptedAt,
    };
  }

  async claimLanguagePrompt(userId: string): Promise<boolean> {
    const claimed = await this.db
      .update(users)
      .set({ languagePromptedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.preferredLanguage), isNull(users.languagePromptedAt)))
      .returning({ id: users.id });
    return claimed.length > 0;
  }
}
