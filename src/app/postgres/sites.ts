import { and, asc, eq } from "drizzle-orm";
import { userJobSites } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import { addBoards, atsBoardFromUrl } from "../../discovery/ats.js";
import type { JobSourceAdapter } from "../../ingestion/adapter.js";
import type { AddSiteOutcome, JobSiteView, SiteService } from "../services.js";

/** Search domain filters accept at most 20 domains. */
export const MAX_SITES_PER_USER = 20;

const siteColumns = { id: userJobSites.id, domain: userJobSites.domain, url: userJobSites.url };

/** A site from user input such as `drushim.co.il` or `https://www.example.com/careers`; null when it is not a web address. */
export function parseSite(input: string): { domain: string; url: string } | null {
  const text = input.trim().replace(/[.,;!?)]+$/, "");
  if (!text || /\s/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const domain = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) return null;
  return { domain, url: `${url.origin}${url.pathname === "/" ? "" : url.pathname}` };
}

export class PgSiteService implements SiteService {
  constructor(
    private readonly db: Db,
    private readonly boardAdapters: readonly JobSourceAdapter<any>[],
  ) {}

  async list(userId: string): Promise<JobSiteView[]> {
    return this.db.select(siteColumns).from(userJobSites).where(eq(userJobSites.userId, userId)).orderBy(asc(userJobSites.createdAt));
  }

  async add(userId: string, input: string): Promise<AddSiteOutcome> {
    const site = parseSite(input);
    if (!site) return { kind: "invalid" };

    const board = atsBoardFromUrl(site.url);
    if (board) {
      await addBoards(this.db, this.boardAdapters, [board]);
      return { kind: "board", board: `${board.source}:${board.token}` };
    }

    const existing = await this.list(userId);
    const same = existing.find((s) => s.domain === site.domain);
    if (same) return { kind: "exists", site: same };
    if (existing.length >= MAX_SITES_PER_USER) return { kind: "limit" };
    const [row] = await this.db
      .insert(userJobSites)
      .values({ userId, ...site })
      .onConflictDoNothing()
      .returning(siteColumns);
    return row ? { kind: "added", site: row } : { kind: "exists", site: (await this.list(userId)).find((s) => s.domain === site.domain)! };
  }

  async remove(userId: string, siteId: string): Promise<boolean> {
    const removed = await this.db
      .delete(userJobSites)
      .where(and(eq(userJobSites.id, siteId), eq(userJobSites.userId, userId)))
      .returning({ id: userJobSites.id });
    return removed.length > 0;
  }
}
