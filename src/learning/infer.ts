import { WORK_MODES, type FeedbackVerdict, type WorkMode } from "../domain/enums.js";
import type { NewPreference, PreferenceSnapshot } from "../domain/profile.js";
import { normalizeCompany, normalizeText } from "../ingestion/normalize.js";
import { termForms, tokenize } from "../matching/relevance.js";

export const FEEDBACK_REASON_TAGS = ["role", "seniority", "location", "work_mode", "company", "pay"] as const;
export type FeedbackReasonTag = (typeof FEEDBACK_REASON_TAGS)[number];

export const MIN_ROLE_SUPPORT = 3;
export const MIN_COMPANY_SUPPORT = 2;
export const MIN_WORK_MODE_SUPPORT = 3;

/** The user's latest verdict on one duplicate group, with the job it was given on. */
export interface FeedbackSignal {
  feedbackId: string;
  groupId: string;
  verdict: FeedbackVerdict;
  reasonTags: readonly string[];
  title: string;
  company: string | null;
  workMode: WorkMode | null;
}

export interface PreferenceProposal {
  preference: NewPreference;
  rationale: string;
  supersedesId: string | null;
  feedbackIds: string[];
}

export interface InferenceInput {
  signals: readonly FeedbackSignal[];
  /** Titles the user has held or describes themselves with; never proposed as something to avoid. */
  ownTitles: readonly string[];
  /** Every preference the user has had, in any status, so rejected proposals are never proposed again. */
  preferences: readonly PreferenceSnapshot[];
}

/**
 * Turns repeated "not interested" feedback into proposed preference changes. Proposals only take effect once the
 * user accepts them, so the rules favour clear, repeated signals over coverage.
 */
export function inferPreferences(input: InferenceInput): PreferenceProposal[] {
  return [...inferRoleDislikes(input), ...inferCompanyDislikes(input), ...inferWorkMode(input)];
}

const rejections = (signals: readonly FeedbackSignal[]) => signals.filter((s) => s.verdict === "not_interested");
const interests = (signals: readonly FeedbackSignal[]) => signals.filter((s) => s.verdict === "interested");

function inferRoleDislikes({ signals, ownTitles, preferences }: InferenceInput): PreferenceProposal[] {
  const protectedTerms = new Set<string>();
  const protect = (text: string) => tokenize(text).forEach((t) => protectedTerms.add(t));
  ownTitles.forEach(protect);
  interests(signals).forEach((s) => protect(s.title));
  preferences
    .filter((p) => p.kind === "target_role" && (p.status === "active" || p.status === "proposed"))
    .forEach((p) => protect(p.value.type === "terms" ? p.value.terms.join(" ") : p.label));
  const known = new Set(
    preferences.filter((p) => p.dimension === "role" && p.value.type === "terms").flatMap((p) => termsOf(p).map(key)),
  );

  const support = new Map<string, { word: string; signals: FeedbackSignal[] }>();
  for (const signal of rejections(signals)) {
    if (signal.reasonTags.length > 0 && !signal.reasonTags.includes("role")) continue;
    for (const [term, word] of termForms(signal.title)) {
      if (protectedTerms.has(term)) continue;
      const entry = support.get(term) ?? { word, signals: [] };
      entry.signals.push(signal);
      support.set(term, entry);
    }
  }

  const candidates = [...support.values()]
    .filter((c) => c.signals.length >= MIN_ROLE_SUPPORT && !known.has(key(c.word)))
    .sort((a, b) => b.signals.length - a.signals.length || a.word.localeCompare(b.word));
  const proposals: PreferenceProposal[] = [];
  const covered: Set<string>[] = [];
  for (const { word, signals: supporting } of candidates) {
    const groups = new Set(supporting.map((s) => s.groupId));
    if (covered.some((c) => [...groups].every((g) => c.has(g)))) continue;
    covered.push(groups);
    proposals.push({
      preference: {
        kind: "dislike",
        dimension: "role",
        label: `${capitalize(word)} roles`,
        value: { type: "terms", terms: [word] },
      },
      rationale: `You passed on ${supporting.length} jobs with “${word}” in the title.`,
      supersedesId: null,
      feedbackIds: supporting.map((s) => s.feedbackId),
    });
  }
  return proposals;
}

function inferCompanyDislikes({ signals, preferences }: InferenceInput): PreferenceProposal[] {
  const liked = new Set(interests(signals).map((s) => normalizeCompany(s.company)));
  const known = new Set(
    preferences.filter((p) => p.dimension === "company").flatMap((p) => termsOf(p).map(normalizeCompany)),
  );
  const byCompany = new Map<string, FeedbackSignal[]>();
  for (const signal of rejections(signals)) {
    const company = normalizeCompany(signal.company);
    if (!company || !signal.reasonTags.includes("company") || liked.has(company) || known.has(company)) continue;
    byCompany.set(company, [...(byCompany.get(company) ?? []), signal]);
  }
  return [...byCompany.values()]
    .filter((supporting) => supporting.length >= MIN_COMPANY_SUPPORT)
    .map((supporting) => {
      const company = supporting[0]!.company!;
      return {
        preference: { kind: "dislike", dimension: "company", label: `Jobs at ${company}`, value: { type: "terms", terms: [company] } },
        rationale: `You passed on ${supporting.length} jobs at ${company} because of the company.`,
        supersedesId: null,
        feedbackIds: supporting.map((s) => s.feedbackId),
      };
    });
}

function inferWorkMode({ signals, preferences }: InferenceInput): PreferenceProposal[] {
  const liked = new Set(interests(signals).map((s) => s.workMode));
  const current = preferences.find(
    (p) => p.kind === "hard_constraint" && p.status === "active" && p.value.type === "work_mode",
  );
  const allowed = current?.value.type === "work_mode" ? current.value.modes : WORK_MODES;
  const known = new Set(
    preferences.flatMap((p) => (p.kind === "hard_constraint" && p.value.type === "work_mode" ? [modesKey(p.value.modes)] : [])),
  );

  const excluded = WORK_MODES.flatMap((mode) => {
    const supporting = rejections(signals).filter((s) => s.workMode === mode && s.reasonTags.includes("work_mode"));
    return supporting.length >= MIN_WORK_MODE_SUPPORT && !liked.has(mode) && allowed.includes(mode)
      ? [{ mode, supporting }]
      : [];
  });
  const modes = allowed.filter((m) => !excluded.some((e) => e.mode === m));
  if (excluded.length === 0 || modes.length === 0 || known.has(modesKey(modes))) return [];

  const supporting = excluded.flatMap((e) => e.supporting);
  return [
    {
      preference: {
        kind: "hard_constraint",
        dimension: "work_mode",
        label: `${modes.map(capitalize).join(" or ")} only`,
        value: { type: "work_mode", modes },
      },
      rationale: `You passed on ${supporting.length} ${excluded.map((e) => e.mode).join(" and ")} jobs because of the work setup.`,
      supersedesId: current?.id ?? null,
      feedbackIds: supporting.map((s) => s.feedbackId),
    },
  ];
}

const termsOf = (p: PreferenceSnapshot) => (p.value.type === "terms" ? p.value.terms : [p.label]);
const key = (text: string) => normalizeText(text);
const modesKey = (modes: readonly WorkMode[]) => [...modes].sort().join(",");
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
