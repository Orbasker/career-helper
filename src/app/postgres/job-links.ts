import { and, eq } from "drizzle-orm";
import { careerProfiles } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { readSubmittedJob, type SubmittedJobDeps } from "../../discovery/submitted.js";
import type { DeepMatcher } from "../../matching/deep-match.js";
import { matchGroupNow } from "../../matching/on-demand.js";
import type { JobLinkOutcome, JobLinkService } from "../services.js";

export interface JobLinkDeps extends SubmittedJobDeps {
  matcher: DeepMatcher;
}

export class PgJobLinkService implements JobLinkService {
  constructor(
    private readonly db: Db,
    private readonly deps: JobLinkDeps,
  ) {}

  async analyze(userId: string, url: string): Promise<JobLinkOutcome> {
    const [profile] = await this.db
      .select({ id: careerProfiles.id })
      .from(careerProfiles)
      .where(and(eq(careerProfiles.userId, userId), eq(careerProfiles.status, "confirmed")));
    if (!profile) return { kind: "not_onboarded" };

    const job = await readSubmittedJob(this.db, userId, url, this.deps);
    if (job.kind !== "job") return job;
    const match = await matchGroupNow(this.db, this.deps.matcher, userId, job.groupId, { now: this.deps.now });
    if (match.kind === "evaluation_failed") return { kind: "evaluation_failed" };
    return { kind: match.kind, matchId: match.matchId, known: job.known };
  }
}
