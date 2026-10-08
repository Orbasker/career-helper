import { sql } from "drizzle-orm";
import { jobSources } from "../db/schema.js";
import type { Db } from "../db/types.js";
import type { JobSourceAdapter } from "../ingestion/adapter.js";
import { boardsFromConfig } from "../ingestion/sources/shared.js";

export interface AtsBoard {
  source: "greenhouse" | "lever" | "ashby" | "comeet" | "workable" | "smartrecruiters" | "workday";
  token: string;
}

type PostingSource = "greenhouse" | "lever" | "ashby";

const BOARD_URLS: [RegExp, PostingSource | "smartrecruiters"][] = [
  [/^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io$/, "greenhouse"],
  [/^jobs(?:\.eu)?\.lever\.co$/, "lever"],
  [/^jobs\.ashbyhq\.com$/, "ashby"],
  [/^(?:jobs|careers)\.smartrecruiters\.com$/, "smartrecruiters"],
];

const NOT_A_BOARD = new Set(["embed", "api", "v1", "jobs", "j", "oneclick-ui", "external-referrals"]);
const NOT_A_WORKABLE_ACCOUNT = new Set(["www", "apply", "api", "jobs", "help", "resources", "careers"]);

/** The public ATS board a URL belongs to, e.g. `https://job-boards.greenhouse.io/acme/jobs/1` → greenhouse `acme`. */
export function atsBoardFromUrl(url: string): AtsBoard | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean).map(safeDecode);
  return pathBoard(host, segments) ?? comeetBoard(host, segments) ?? workableBoard(host, segments) ?? workdayBoard(host, segments);
}

const BOARD_TOKEN = /^[a-z0-9][a-z0-9._-]*$/;

function pathBoard(host: string, segments: string[]): AtsBoard | null {
  const source = BOARD_URLS.find(([pattern]) => pattern.test(host))?.[1];
  const token = (segments[0] ?? "").toLowerCase();
  if (!source || !BOARD_TOKEN.test(token) || NOT_A_BOARD.has(token)) return null;
  return { source, token };
}

function comeetBoard(host: string, [jobs, slug, uid]: string[]): AtsBoard | null {
  if (!/^(?:www\.)?comeet\.co(?:m)?$/.test(host) || jobs !== "jobs" || !slug || !uid) return null;
  if (!BOARD_TOKEN.test(slug.toLowerCase()) || !/^[0-9a-f]{2}\.[0-9a-f]{3}$/i.test(uid)) return null;
  return { source: "comeet", token: `${slug.toLowerCase()}/${uid.toUpperCase()}` };
}

function workableBoard(host: string, segments: string[]): AtsBoard | null {
  const subdomain = /^([a-z0-9-]+)\.workable\.com$/.exec(host)?.[1];
  const token = (host === "apply.workable.com" ? segments[0] : subdomain)?.toLowerCase() ?? "";
  if (!BOARD_TOKEN.test(token) || NOT_A_BOARD.has(token) || NOT_A_WORKABLE_ACCOUNT.has(token)) return null;
  return { source: "workable", token };
}

function workdayBoard(host: string, segments: string[]): AtsBoard | null {
  const jobsHost = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (jobsHost) {
    const site = /^[a-z]{2}-[A-Z]{2}$/.test(segments[0] ?? "") ? segments[1] : segments[0];
    return workdayToken(jobsHost[1]!, jobsHost[2]!, site);
  }
  const siteHost = /^(wd\d+)\.myworkdaysite\.com$/.exec(host);
  const offset = /^[a-z]{2}-[A-Z]{2}$/.test(segments[0] ?? "") ? 1 : 0;
  if (!siteHost || segments[offset] !== "recruiting") return null;
  return workdayToken(segments[offset + 1]?.toLowerCase(), siteHost[1]!, segments[offset + 2]);
}

function workdayToken(tenant: string | undefined, instance: string, site: string | undefined): AtsBoard | null {
  if (!tenant || !site || !/^[a-z0-9-]+$/.test(tenant) || !/^[A-Za-z0-9_-]+$/.test(site) || site === "wday") return null;
  return { source: "workday", token: `${tenant}.${instance}/${site}` };
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export interface AtsPosting extends Omit<AtsBoard, "source"> {
  source: PostingSource;
  postingId: string;
  /** Lever and Greenhouse run separate EU instances with their own APIs. */
  eu: boolean;
}

const POSTING_SOURCES = new Set<AtsBoard["source"]>(["greenhouse", "lever", "ashby"]);

/** The single posting a board URL points to, e.g. `https://jobs.lever.co/acme/1f2e…` → lever `acme` posting `1f2e…`. */
export function atsPostingFromUrl(url: string): AtsPosting | null {
  const board = atsBoardFromUrl(url);
  if (!board || !POSTING_SOURCES.has(board.source)) return null;
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const postingId = board.source === "greenhouse" ? (segments[1] === "jobs" ? segments[2] : undefined) : segments[1];
  const valid = board.source === "greenhouse" ? /^\d+$/ : /^[0-9a-f-]{8,}$/i;
  if (!postingId || !valid.test(postingId)) return null;
  return { source: board.source as PostingSource, token: board.token, postingId: postingId.toLowerCase(), eu: /\.eu\./.test(parsed.hostname) };
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
    const byKey = new Map<string, string>();
    for (const { source, token } of boards) if (source === key && !byKey.has(token.toLowerCase())) byKey.set(token.toLowerCase(), token);
    const tokens = [...byKey.values()];
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
      const fresh = tokens.filter((t) => !known.has(t.toLowerCase()));
      if (fresh.length === 0) return;
      const existing = Array.isArray(config.boards) ? config.boards : [];
      await tx
        .update(jobSources)
        .set({ config: { ...config, boards: [...existing, ...fresh.map((token) => ({ token, addedAt: new Date().toISOString() }))] } })
        .where(sql`${jobSources.key} = ${key}`);
      added.push(...fresh.map((token) => ({ source: key as AtsBoard["source"], token })));
    });
  }
  return added;
}
