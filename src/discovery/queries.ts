import { and, asc, eq, inArray } from "drizzle-orm";
import { loadSnapshot } from "../app/postgres/profile.js";
import { careerProfiles } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { JobQuery } from "../ingestion/search.js";
import { DEFAULT_QUERIES_PER_USER, jobQueries } from "./plan.js";

export const DEFAULT_MAX_SITE_QUERIES = 12;

export interface QueryOptions {
  userIds?: readonly string[];
  keywords?: string;
  queriesPerUser?: number;
  /** Caps the total; profiles are taken oldest first, starting `rotation` profiles in. */
  maxQueries?: number;
  rotation?: number;
}

/** The job-site queries for confirmed profiles, without repeats across users. */
export async function profileJobQueries(db: Db, options: QueryOptions = {}): Promise<JobQuery[]> {
  const profiles = await db
    .select({ userId: careerProfiles.userId })
    .from(careerProfiles)
    .where(
      and(
        eq(careerProfiles.status, "confirmed"),
        options.userIds ? inArray(careerProfiles.userId, [...options.userIds]) : undefined,
      ),
    )
    .orderBy(asc(careerProfiles.createdAt));
  const queries = new Map<string, JobQuery>();
  const max = options.maxQueries ?? DEFAULT_MAX_SITE_QUERIES;
  const start = profiles.length ? (options.rotation ?? 0) % profiles.length : 0;
  for (const { userId } of [...profiles.slice(start), ...profiles.slice(0, start)]) {
    const profile = await loadSnapshot(db, userId, { verifiedOnly: true });
    for (const query of jobQueries(profile, options.queriesPerUser ?? DEFAULT_QUERIES_PER_USER, options.keywords)) {
      if (queries.size >= max) return [...queries.values()];
      const key = `${query.keywords.toLowerCase()}|${(query.location ?? "").toLowerCase()}`;
      if (!queries.has(key)) queries.set(key, query);
    }
  }
  return [...queries.values()];
}
