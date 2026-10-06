import { and, eq } from "drizzle-orm";
import { cvVersions, masterCvs, matches } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type { CvRequestOutcome, CvService } from "../services.js";

export class PgCvService implements CvService {
  constructor(private readonly db: Db) {}

  async requestTailored(userId: string, matchId: string): Promise<CvRequestOutcome> {
    const [match] = await this.db
      .select({ jobId: matches.jobId })
      .from(matches)
      .where(and(eq(matches.id, matchId), eq(matches.userId, userId)));
    if (!match) return "not_found";

    const [masterCv] = await this.db
      .select({ id: masterCvs.id })
      .from(masterCvs)
      .where(eq(masterCvs.userId, userId));
    const inserted = await this.db
      .insert(cvVersions)
      .values({ userId, matchId, jobId: match.jobId, masterCvId: masterCv?.id, status: "requested" })
      .onConflictDoNothing()
      .returning({ id: cvVersions.id });
    return inserted.length > 0 ? "requested" : "already_requested";
  }
}
