import type { CareerFactKind } from "../domain/enums.js";
import type { PreferenceSnapshot, ProfileSnapshot } from "../domain/profile.js";
import { TITLE_ABBREVIATIONS, normalizeText } from "../ingestion/normalize.js";
import { structuredMatch } from "./hard-filters.js";
import type { MatchJob } from "./types.js";

export const RELEVANCE_THRESHOLD = 0.2;

const TITLE_HIT_MULTIPLIER = 2;
const SATURATION = 16;
const TARGET_ROLE_PHRASE_BOOST = 0.35;
const TARGET_ROLE_WORD_BOOST = 0.15;
const SOFT_PREFERENCE_BOOST = 0.05;
const DISLIKE_FACTOR = 0.5;
const MAX_REPORTED_TERMS = 12;

const FACT_WEIGHTS: Partial<Record<CareerFactKind, number>> = {
  skill: 2,
  certification: 2,
  responsibility: 1,
  achievement: 1,
};

const TERM_DIMENSIONS = new Set(["role", "industry", "company", "other"]);

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can do for from has have in into is it its of on or our that the their this to " +
    "us we what who will with within you your about across all also any able etc other new using including such per " +
    "role roles job jobs position team teams work working company experience experienced year years responsible " +
    "strong ability skill skills plus well help join looking opportunity based key day must nice ideal candidate " +
    "entry junior mid senior lead principal staff head manager director vice president chief associate intern"
  ).split(" "),
);

export interface RelevanceProfile {
  terms: Map<string, number>;
  targetRoles: PhraseSet[];
  softPreferences: PreferenceSnapshot[];
  dislikes: PreferenceSnapshot[];
}

interface PhraseSet {
  label: string;
  phrases: string[];
}

export interface RelevanceResult {
  score: number;
  passed: boolean;
  matchedTerms: string[];
  targetRoles: string[];
  dislikes: string[];
  softPreferences: string[];
}

/** Collects the profile's vocabulary once so many jobs can be scored against it cheaply. */
export function buildRelevanceProfile(snapshot: ProfileSnapshot): RelevanceProfile {
  const terms = new Map<string, number>();
  const add = (text: string | null, weight: number) => {
    for (const term of tokenize(text)) terms.set(term, Math.max(terms.get(term) ?? 0, weight));
  };

  add(snapshot.profile.headline, 1);
  for (const experience of snapshot.experiences) {
    add(experience.title, 2);
    add(experience.industry, 1);
  }
  for (const fact of snapshot.facts) {
    const weight = FACT_WEIGHTS[fact.kind];
    if (weight) add(fact.statement, weight);
  }

  const active = snapshot.preferences.filter((p) => p.status === "active");
  const targetRoles = active.filter((p) => p.kind === "target_role").map(phraseSet);
  for (const role of targetRoles) add(role.phrases.join(" "), 2);
  for (const preference of active) {
    if (preference.kind === "soft_preference" && TERM_DIMENSIONS.has(preference.dimension)) {
      add(phraseSet(preference).phrases.join(" "), 1);
    }
  }

  return {
    terms,
    targetRoles,
    softPreferences: active.filter((p) => p.kind === "soft_preference"),
    dislikes: active.filter((p) => p.kind === "dislike"),
  };
}

/**
 * Recall-oriented score in [0, 1]: overlap between the profile's vocabulary and the job's title and description,
 * boosted by target roles and satisfied soft preferences, damped by dislikes. A title that differs from past
 * roles is never penalized, so career-adjacent roles survive on description overlap alone.
 */
export function scoreRelevance(job: MatchJob, profile: RelevanceProfile, threshold = RELEVANCE_THRESHOLD): RelevanceResult {
  const titleText = ` ${expand(job.title)} `;
  const descriptionText = ` ${expand(job.description)} `;
  const titleTerms = tokenize(job.title);
  const descriptionTerms = tokenize(job.description);

  let weight = 0;
  const matched: [string, number][] = [];
  for (const [term, termWeight] of profile.terms) {
    const hit = titleTerms.has(term) ? termWeight * TITLE_HIT_MULTIPLIER : descriptionTerms.has(term) ? termWeight : 0;
    if (!hit) continue;
    weight += hit;
    matched.push([term, hit]);
  }
  let score = 1 - Math.exp(-weight / SATURATION);

  const targetRoles: string[] = [];
  let roleBoost = 0;
  for (const role of profile.targetRoles) {
    const boost = role.phrases.some((phrase) => titleText.includes(` ${phrase} `))
      ? TARGET_ROLE_PHRASE_BOOST
      : role.phrases.some((phrase) => [...tokenize(phrase)].some((t) => titleTerms.has(t)))
        ? TARGET_ROLE_WORD_BOOST
        : 0;
    if (boost) targetRoles.push(role.label);
    roleBoost = Math.max(roleBoost, boost);
  }
  score += roleBoost;

  const softPreferences: string[] = [];
  for (const preference of profile.softPreferences) {
    const text = preference.value.type === "terms" ? `${titleText} ${descriptionText}` : null;
    if (satisfies(preference, job, text)) {
      softPreferences.push(preference.label);
      score += SOFT_PREFERENCE_BOOST;
    }
  }

  const dislikes: string[] = [];
  for (const preference of profile.dislikes) {
    if (satisfies(preference, job, titleText)) dislikes.push(preference.label);
  }
  if (dislikes.length) score *= DISLIKE_FACTOR;

  score = Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
  return {
    score,
    passed: score >= threshold,
    matchedTerms: matched
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_REPORTED_TERMS)
      .map(([term]) => term),
    targetRoles,
    dislikes,
    softPreferences,
  };
}

export function tokenize(text: string | null | undefined): Set<string> {
  return new Set(termForms(text).keys());
}

/** Meaningful words of `text` keyed by their stem, keeping the first spelling seen. */
export function termForms(text: string | null | undefined): Map<string, string> {
  const forms = new Map<string, string>();
  if (!text) return forms;
  for (const word of expand(text).split(" ")) {
    if (word.length < 2 || /^\d+$/.test(word) || STOPWORDS.has(word)) continue;
    const term = stem(word);
    if (!forms.has(term)) forms.set(term, word);
  }
  return forms;
}

/** Text-term preferences match as whole phrases in `text`; structured ones defer to the hard-filter matcher. */
function satisfies(preference: PreferenceSnapshot, job: MatchJob, text: string | null): boolean {
  if (preference.value.type !== "terms") return structuredMatch(preference.value, job) === true;
  return text !== null && phraseSet(preference).phrases.some((phrase) => text.includes(` ${phrase} `));
}

function phraseSet(preference: PreferenceSnapshot): PhraseSet {
  const raw =
    preference.value.type === "terms"
      ? preference.value.terms
      : preference.value.type === "free_text"
        ? [preference.value.text]
        : [preference.label];
  return { label: preference.label, phrases: raw.map(expand).filter(Boolean) };
}

function expand(text: string): string {
  return normalizeText(text)
    .split(" ")
    .map((word) => TITLE_ABBREVIATIONS[word] ?? word)
    .join(" ");
}

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}
