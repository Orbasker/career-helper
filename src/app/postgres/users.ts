import { eq, sql } from "drizzle-orm";
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
          displayName: sql`coalesce(excluded.display_name, ${users.displayName})`,
          locale: sql`coalesce(excluded.locale, ${users.locale})`,
        },
      })
      .returning({ id: users.id });
    const [profile] = await this.db
      .select({ id: careerProfiles.id })
      .from(careerProfiles)
      .where(eq(careerProfiles.userId, user!.id));
    return { userId: user!.id, hasProfile: profile !== undefined };
  }
}
