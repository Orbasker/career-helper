import { and, eq } from "drizzle-orm";
import type { FeedbackVerdict } from "../../domain/enums.js";
import { feedback, matches } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type { FeedbackService } from "../services.js";

export class PgFeedbackService implements FeedbackService {
  constructor(private readonly db: Db) {}

  async record(userId: string, matchId: string, verdict: FeedbackVerdict): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [match] = await tx
        .select({ id: matches.id })
        .from(matches)
        .where(and(eq(matches.id, matchId), eq(matches.userId, userId)));
      if (!match) return false;

      await tx.insert(feedback).values({ userId, matchId, verdict });
      if (verdict === "not_interested") {
        await tx.update(matches).set({ status: "dismissed" }).where(eq(matches.id, matchId));
      }
      return true;
    });
  }
}
