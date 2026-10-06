import type { SeniorityLevel } from "../domain/enums.js";
import type { PreferenceSnapshot } from "../domain/profile.js";
import type { PreferenceValue } from "../domain/types.js";
import { normalizeLocation, normalizeText, normalizeTitle } from "../ingestion/normalize.js";
import type { MatchJob } from "./types.js";

export interface ConstraintFailure {
  preferenceId: string;
  label: string;
  reason: string;
}

export interface HardFilterResult {
  passed: boolean;
  failures: ConstraintFailure[];
}

const CITIES_BY_COUNTRY: Record<string, string[]> = citiesByCountry({
  israel: [
    "tel aviv",
    "jerusalem",
    "haifa",
    "herzliya",
    "raanana",
    "ra'anana",
    "petah tikva",
    "ramat gan",
    "givatayim",
    "bnei brak",
    "holon",
    "rishon lezion",
    "rehovot",
    "netanya",
    "kfar saba",
    "hod hasharon",
    "rosh haayin",
    "modiin",
    "modi'in",
    "beer sheva",
    "be'er sheva",
    "yokneam",
    "caesarea",
    "or yehuda",
    "airport city",
  ],
});

const SENIORITY_PATTERNS: [RegExp, SeniorityLevel][] = [
  [/\b(?:intern|internship|trainee|graduate|new grad|entry level)\b/, "entry"],
  [/\bjunior\b/, "junior"],
  [/\bsenior\b/, "senior"],
  [/\b(?:lead|principal|staff)\b/, "lead"],
  [/\bmanager\b/, "manager"],
  [/\b(?:head of|director)\b/, "director"],
  [/\b(?:vice president|chief|ceo|cto|cfo|coo|cpo|cro|chro|cmo)\b/, "executive"],
];

/**
 * Applies the user's active hard constraints. A constraint only fails on explicit, contradicting job data:
 * unknown fields, and constraints with no reliable job field (compensation, terms, free text), always pass.
 */
export function applyHardFilters(job: MatchJob, preferences: readonly PreferenceSnapshot[]): HardFilterResult {
  const failures: ConstraintFailure[] = [];
  for (const preference of preferences) {
    if (preference.kind !== "hard_constraint" || preference.status !== "active") continue;
    if (structuredMatch(preference.value, job) !== false) continue;
    failures.push({ preferenceId: preference.id, label: preference.label, reason: failureReason(preference.value, job) });
  }
  return { passed: failures.length === 0, failures };
}

/** Whether the job satisfies a structured preference; null when the job does not say or the value is not structured. */
export function structuredMatch(value: PreferenceValue, job: MatchJob): boolean | null {
  switch (value.type) {
    case "work_mode":
      return job.workMode && value.modes.length ? value.modes.includes(job.workMode) : null;
    case "employment_type":
      return job.employmentType && value.types.length ? value.types.includes(job.employmentType) : null;
    case "location":
      return locationMatch(value.places, job);
    case "seniority": {
      const levels = inferSeniority(job.title);
      return levels.length && value.levels.length ? levels.some((level) => value.levels.includes(level)) : null;
    }
    default:
      return null;
  }
}

/** Seniority levels a title explicitly signals; empty when it says nothing about level. */
export function inferSeniority(title: string): SeniorityLevel[] {
  const normalized = normalizeTitle(title) ?? "";
  return SENIORITY_PATTERNS.filter(([pattern]) => pattern.test(normalized)).map(([, level]) => level);
}

/** Remote postings satisfy any location; a country also covers its known cities. */
function locationMatch(places: readonly string[], job: MatchJob): boolean | null {
  const wanted = places.map(normalizeLocation).filter((place): place is string => place !== null);
  if (!wanted.length || !job.location) return null;

  const jobPlaces = job.location.split(/[;|•/]/).map(normalizeLocation);
  const text = ` ${normalizeText(job.location)} `;
  if (job.workMode === "remote" || jobPlaces.includes("remote") || text.includes(" remote ")) return true;

  const covers = (place: string) =>
    jobPlaces.includes(place) ||
    text.includes(` ${place} `) ||
    (CITIES_BY_COUNTRY[place] ?? []).some((city) => jobPlaces.includes(city) || text.includes(` ${city} `));
  return wanted.some(covers);
}

function failureReason(value: PreferenceValue, job: MatchJob): string {
  switch (value.type) {
    case "work_mode":
      return `work mode is ${job.workMode}`;
    case "employment_type":
      return `employment type is ${job.employmentType?.replace("_", "-")}`;
    case "location":
      return `located in ${job.location}`;
    case "seniority":
      return `title suggests ${inferSeniority(job.title).join("/")} level`;
    default:
      return "does not match";
  }
}

function citiesByCountry(cities: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(cities).map(([country, names]) => [country, names.map(normalizeText)]));
}
