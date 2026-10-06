import type { EmploymentType, WorkMode } from "../../domain/enums.js";
import type { CollectContext, RawJob } from "../adapter.js";

export interface Board {
  token: string;
  company: string | null;
}

export interface BoardPayload<TPosting> {
  board: string;
  company: string | null;
  posting: TPosting;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Reads `config.boards`, accepting either a board token or `{ token, company }` per entry. */
export function boardsFromConfig(config: Record<string, unknown>): Board[] {
  const boards = Array.isArray(config.boards) ? config.boards : [];
  return boards.flatMap((entry): Board[] => {
    if (typeof entry === "string" && entry.trim()) return [{ token: entry.trim(), company: null }];
    if (entry && typeof entry === "object" && typeof entry.token === "string" && entry.token.trim()) {
      return [{ token: entry.token.trim(), company: typeof entry.company === "string" ? entry.company : null }];
    }
    return [];
  });
}

export async function* collectBoards<TPosting>(
  ctx: CollectContext,
  fetchBoard: (board: Board) => Promise<RawJob<BoardPayload<TPosting>>[]>,
): AsyncGenerator<RawJob<BoardPayload<TPosting>>> {
  for (const board of boardsFromConfig(ctx.config)) {
    let records: RawJob<BoardPayload<TPosting>>[];
    try {
      records = await fetchBoard(board);
    } catch (error) {
      ctx.reportError(`board:${board.token}`, error);
      continue;
    }
    yield* records;
  }
}

export async function fetchJson<T>(ctx: CollectContext, url: string): Promise<T> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await ctx.fetch(url, {
    headers: { accept: "application/json" },
    signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return (await response.json()) as T;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const point = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\s+/g, " ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|ul|ol|tr|section)>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return tidyText(decodeEntities(text));
}

export function tidyText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function employmentTypeFrom(text: string | null | undefined): EmploymentType | null {
  if (!text) return null;
  const value = text.toLowerCase().replace(/[\s_-]+/g, "");
  if (value.includes("fulltime") || value === "permanent") return "full_time";
  if (value.includes("parttime")) return "part_time";
  if (value.includes("intern")) return "internship";
  if (value.includes("freelance")) return "freelance";
  if (value.includes("contract")) return "contract";
  if (value.includes("temp")) return "temporary";
  return null;
}

export function workModeFrom(text: string | null | undefined): WorkMode | null {
  if (!text) return null;
  const value = text.toLowerCase().replace(/[\s_-]+/g, "");
  if (value.includes("hybrid")) return "hybrid";
  if (value.includes("remote")) return "remote";
  if (value.includes("onsite") || value.includes("inoffice")) return "onsite";
  return null;
}

export function dateFrom(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
