import type { EmploymentType, WorkMode } from "../domain/enums.js";
import type { NormalizedJobFields } from "../ingestion/adapter.js";
import { dateFrom, decodeEntities, employmentTypeFrom, htmlToText, workModeFrom } from "../ingestion/sources/shared.js";

export const USER_AGENT = "CareerAgentBot/1.0 (+job discovery for individual job seekers)";
const MAX_PAGE_BYTES = 2_000_000;
const PAGE_TIMEOUT_MS = 15_000;

export interface FetchedPage {
  url: string;
  html: string;
}

/** Fetches an HTML page with a timeout and size cap; null for non-HTML or failed responses. */
export async function fetchPage(url: string, fetcher: typeof fetch): Promise<FetchedPage | null> {
  const response = await fetcher(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!response.ok || !(response.headers.get("content-type") ?? "").includes("html")) return null;
  const html = await response.text();
  return { url: response.url || url, html: html.slice(0, MAX_PAGE_BYTES) };
}

/** Reads robots.txt rules for `*` and our agent; a missing or unreadable robots.txt allows everything. */
export class RobotsCache {
  private readonly rules = new Map<string, Promise<{ allow: string[]; disallow: string[] }>>();

  constructor(private readonly fetcher: typeof fetch) {}

  async allows(url: string): Promise<boolean> {
    const parsed = new URL(url);
    let rules = this.rules.get(parsed.origin);
    if (!rules) {
      rules = this.load(parsed.origin);
      this.rules.set(parsed.origin, rules);
    }
    const { allow, disallow } = await rules;
    const path = `${parsed.pathname}${parsed.search}`;
    const longest = (prefixes: string[]) => Math.max(-1, ...prefixes.filter((p) => path.startsWith(p)).map((p) => p.length));
    return longest(allow) >= longest(disallow);
  }

  private async load(origin: string): Promise<{ allow: string[]; disallow: string[] }> {
    try {
      const response = await this.fetcher(`${origin}/robots.txt`, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      return response.ok ? parseRobots(await response.text()) : { allow: [], disallow: [] };
    } catch {
      return { allow: [], disallow: [] };
    }
  }
}

export function parseRobots(text: string): { allow: string[]; disallow: string[] } {
  const rules = { allow: [] as string[], disallow: [] as string[] };
  let applies = false;
  let inAgents = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const key = field?.trim().toLowerCase();
    if (key === "user-agent") {
      const agent = value.toLowerCase();
      const matches = agent === "*" || agent.startsWith("careeragentbot");
      applies = inAgents ? applies || matches : matches;
      inAgents = true;
      continue;
    }
    inAgents = false;
    if (!applies || !value) continue;
    if (key === "disallow") rules.disallow.push(value.replace(/\*.*$/, ""));
    if (key === "allow") rules.allow.push(value.replace(/\*.*$/, ""));
  }
  return rules;
}

export type PostingCheck = { kind: "posting"; fields: NormalizedJobFields } | { kind: "closed" } | { kind: "none" };

/** Reads a `schema.org/JobPosting` from the page's JSON-LD; closed postings (past `validThrough`) are reported as such. */
export function jobPostingFromJsonLd(html: string, now: Date): PostingCheck {
  const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const block of blocks) {
    const json = block.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "");
    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      continue;
    }
    const posting = findPosting(data);
    if (!posting) continue;

    const validThrough = dateFrom(stringOf(posting.validThrough));
    if (validThrough && validThrough < now) return { kind: "closed" };
    const title = stringOf(posting.title)?.trim();
    const description = htmlToText(decodeEntities(stringOf(posting.description) ?? ""));
    if (!title || !description) continue;
    const organization = posting.hiringOrganization as Record<string, unknown> | undefined;
    return {
      kind: "posting",
      fields: {
        title,
        description,
        company: stringOf(organization?.name)?.trim() || null,
        location: locationOf(posting.jobLocation),
        workMode: workModeOf(posting),
        employmentType: employmentOf(posting.employmentType),
        publishedAt: dateFrom(stringOf(posting.datePosted)),
      },
    };
  }
  return { kind: "none" };
}

/** Page text for LLM extraction, without scripts, styles and navigation chrome. */
export function pageText(html: string, maxChars = 15_000): string {
  const body = html.replace(/<(nav|header|footer|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  return htmlToText(body).slice(0, maxChars);
}

function findPosting(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const type = record["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return record;
  return findPosting(record["@graph"]);
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
}

function locationOf(value: unknown): string | null {
  const places = (Array.isArray(value) ? value : [value]).flatMap((place) => {
    const address = (place as { address?: unknown } | null)?.address;
    if (typeof address === "string") return [address];
    if (!address || typeof address !== "object") return [];
    const a = address as Record<string, unknown>;
    const parts = [a.addressLocality, a.addressRegion, a.addressCountry].map(
      (p) => stringOf(p) ?? stringOf((p as { name?: unknown } | null)?.name),
    );
    const text = parts.filter(Boolean).join(", ");
    return text ? [text] : [];
  });
  return places.length ? places.join("; ") : null;
}

function workModeOf(posting: Record<string, unknown>): WorkMode | null {
  if (stringOf(posting.jobLocationType)?.toUpperCase() === "TELECOMMUTE") return "remote";
  return workModeFrom(stringOf(posting.workplaceType) ?? locationOf(posting.jobLocation));
}

function employmentOf(value: unknown): EmploymentType | null {
  const first = Array.isArray(value) ? value[0] : value;
  return employmentTypeFrom(stringOf(first));
}
