import type { ProfileSnapshot } from "../domain/profile.js";
import type { PostingCheck } from "./page.js";

export const DEFAULT_QUERIES_PER_USER = 3;
export const DEFAULT_COUNTRY = "IL";

export interface SearchPlan {
  /** Role-and-place queries, e.g. "Backend Engineer jobs Tel Aviv". */
  queries: string[];
  /** Domains to search within; empty for an open web search. */
  domains: string[];
  /** Kinds of work the user wants to avoid, passed to the agent as exclusions. */
  avoid: string[];
  country: string;
}

export interface JobCandidate {
  url: string;
  title: string;
  company: string | null;
}

export interface JobDiscoverer {
  readonly model: string;
  /** Searches the web for open postings matching the plan and returns links to individual postings. */
  search(plan: SearchPlan): Promise<JobCandidate[]>;
  /** Reads a posting from page text when the page has no structured job data. */
  extract(input: { url: string; text: string }): Promise<PostingCheck>;
}

/**
 * Builds search queries from the profile: active target roles first, otherwise the current and recent titles,
 * each paired with the user's first location must-have (or the country).
 */
export function searchPlan(
  profile: ProfileSnapshot,
  domains: readonly string[],
  maxQueries = DEFAULT_QUERIES_PER_USER,
): SearchPlan {
  const active = profile.preferences.filter((p) => p.status === "active");
  const targetRoles = active
    .filter((p) => p.kind === "target_role")
    .flatMap((p) => (p.value.type === "terms" && p.value.terms.length ? p.value.terms : [p.label]));
  const titles = profile.experiences.map((e) => e.title);
  const roles = unique([...targetRoles, ...(targetRoles.length ? [] : [profile.profile.headline ?? "", ...titles])]);

  const location = active.flatMap((p) =>
    p.kind === "hard_constraint" && p.value.type === "location" ? p.value.places : [],
  )[0];
  const place = location?.trim() || "Israel";

  return {
    queries: roles.slice(0, maxQueries).map((role) => `${role} jobs ${place}`),
    domains: [...domains],
    avoid: unique(active.filter((p) => p.kind === "dislike").map((p) => p.label)),
    country: DEFAULT_COUNTRY,
  };
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((v) => v.replace(/\s+/g, " ").trim())
    .filter((v) => {
      const key = v.toLowerCase();
      if (!v || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
