import { sql } from "drizzle-orm";
import { jobSources } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { JobSourceAdapter } from "../ingestion/adapter.js";
import { boardsFromConfig } from "../ingestion/sources/shared.js";

export interface AtsBoard {
  source: "greenhouse" | "lever" | "ashby";
  token: string;
}

const BOARD_URLS: [RegExp, AtsBoard["source"]][] = [
  [/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/, "greenhouse"],
  [/^jobs(?:\.eu)?\.lever\.co$/, "lever"],
  [/^jobs\.ashbyhq\.com$/, "ashby"],
];

const NOT_A_BOARD = new Set(["embed", "api", "v1", "jobs"]);

/** The public ATS board a URL belongs to, e.g. `https://job-boards.greenhouse.io/acme/jobs/1` → greenhouse `acme`. */
export function atsBoardFromUrl(url: string): AtsBoard | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const source = BOARD_URLS.find(([pattern]) => pattern.test(host))?.[1];
  const token = decodeURIComponent(parsed.pathname.split("/").filter(Boolean)[0] ?? "").toLowerCase();
  if (!source || !/^[a-z0-9][a-z0-9._-]*$/.test(token) || NOT_A_BOARD.has(token)) return null;
  return { source, token };
}

/**
 * Adds boards to their source's `config.boards` so the basic collectors fetch them from now on; boards already
 * configured are left alone. Returns the boards that were new.
 */
export async function addBoards(
  db: Db,
  adapters: readonly JobSourceAdapter<any>[],
  boards: readonly AtsBoard[],
): Promise<AtsBoard[]> {
  const added: AtsBoard[] = [];
  for (const adapter of adapters) {
    const key = adapter.source.key;
    const tokens = [...new Set(boards.filter((b) => b.source === key).map((b) => b.token))];
    if (tokens.length === 0) continue;

    await db.transaction(async (tx) => {
      const { name, kind, baseUrl } = adapter.source;
      await tx.insert(jobSources).values({ key, name, kind, baseUrl }).onConflictDoNothing({ target: jobSources.key });
      const [source] = await tx
        .select({ config: jobSources.config })
        .from(jobSources)
        .where(sql`${jobSources.key} = ${key}`)
        .for("update");
      const config = source?.config ?? {};
      const known = new Set(boardsFromConfig(config).map((b) => b.token.toLowerCase()));
      const fresh = tokens.filter((t) => !known.has(t));
      if (fresh.length === 0) return;
      const existing = Array.isArray(config.boards) ? config.boards : [];
      await tx
        .update(jobSources)
        .set({ config: { ...config, boards: [...existing, ...fresh] } })
        .where(sql`${jobSources.key} = ${key}`);
      added.push(...fresh.map((token) => ({ source: key as AtsBoard["source"], token })));
    });
  }
  return added;
}
