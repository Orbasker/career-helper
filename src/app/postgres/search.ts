import { and, eq, lt } from "drizzle-orm";
import { careerProfiles, jobSearches, users } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { errorMessage } from "../../ingestion/ingest.js";
import { runUserSearch, type UserSearchDeps, type UserSearchOptions } from "../../pipeline/user-search.js";
import type { SearchOutcome, SearchService, SearchStart } from "../services.js";

/** A search still `running` after this long died with its function invocation, so it is marked failed and no longer blocks a new one. */
const STALE_SEARCH_MS = 10 * 60_000;
const MAX_KEYWORDS_LENGTH = 100;

export interface SearchServiceOptions extends UserSearchOptions {
}

export class PgSearchService implements SearchService {
  constructor(
    private readonly db: Db,
    private readonly deps: UserSearchDeps,
    private readonly options: SearchServiceOptions = {},
  ) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }

  async start(userId: string, keywords: string | null): Promise<SearchStart> {
    const now = this.now();
    return this.db.transaction(async (tx) => {
      const [profile] = await tx
        .select({ id: careerProfiles.id })
        .from(careerProfiles)
        .where(and(eq(careerProfiles.userId, userId), eq(careerProfiles.status, "confirmed")));
      if (!profile) return { kind: "not_onboarded" };
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
      await tx
        .update(jobSearches)
        .set({ status: "failed", finishedAt: now })
        .where(
          and(
            eq(jobSearches.userId, userId),
            eq(jobSearches.status, "running"),
            lt(jobSearches.startedAt, new Date(now.getTime() - STALE_SEARCH_MS)),
          ),
        );

      const [running] = await tx
        .select({ id: jobSearches.id })
        .from(jobSearches)
        .where(and(eq(jobSearches.userId, userId), eq(jobSearches.status, "running")));
      if (running) return { kind: "running" };
      const query = keywords?.replace(/\s+/g, " ").trim().slice(0, MAX_KEYWORDS_LENGTH) || null;
      const [search] = await tx
        .insert(jobSearches)
        .values({ userId, query, startedAt: now })
        .returning({ id: jobSearches.id });
      return { kind: "started", searchId: search!.id };
    });
  }

  async run(userId: string, searchId: string): Promise<SearchOutcome | null> {
    const [search] = await this.db
      .select({ query: jobSearches.query })
      .from(jobSearches)
      .where(and(eq(jobSearches.id, searchId), eq(jobSearches.userId, userId), eq(jobSearches.status, "running")));
    if (!search) return null;
    try {
      const result = await runUserSearch(this.db, this.deps, userId, search.query, this.options);
      const { errors, sources, ...rest } = result;
      await this.finish(searchId, "completed", { ...rest, matches: result.matches.length, sources, errors });
      return { ...rest, sources: sources.map(({ source: _, ...s }) => s) };
    } catch (error) {
      await this.finish(searchId, "failed", { error: errorMessage(error) });
      throw error;
    }
  }

  private async finish(searchId: string, status: "completed" | "failed", report: Record<string, unknown>) {
    await this.db
      .update(jobSearches)
      .set({ status, finishedAt: this.now(), report })
      .where(eq(jobSearches.id, searchId));
  }
}
