import type { CareerFactKind, CvSection } from "../domain/enums.js";
import type { ExperienceSnapshot, FactSnapshot, ProfileSnapshot } from "../domain/profile.js";

export const MAX_SUMMARY_SENTENCES = 3;
export const MAX_BULLETS_PER_ROLE = 5;
export const MAX_BULLETS = 15;
export const SECTION_ORDER: readonly CvSection[] = [
  "summary",
  "experience",
  "skills",
  "education",
  "certifications",
  "languages",
  "other",
];

const VERBATIM_SECTIONS: Partial<Record<CareerFactKind, CvSection>> = {
  education: "education",
  certification: "certifications",
  language: "languages",
};

export interface TailoringJob {
  title: string;
  company: string | null;
  description: string;
}

/** What the model returns, citing the aliases (`f*`, `e*`) it was shown. */
export interface TailoringDraft {
  summary: { text: string; sources: string[] }[];
  highlights: { fact: string; text: string }[];
  skills: string[];
  applicationNote: { text: string; sources: string[] };
}

export interface TailoringAliases {
  facts: Map<string, string>;
  experiences: Map<string, string>;
}

export interface TailoredItem {
  careerFactId: string;
  section: CvSection;
  position: number;
  text: string;
}

export interface TailoredCv {
  items: TailoredItem[];
  applicationNote: string | null;
  /** Generated text that was replaced by the verbatim fact or dropped because it claimed something unsupported. */
  violations: string[];
}

export interface CvTailorer {
  readonly model: string;
  readonly promptVersion: string;
  /** `profile` must hold only verified experiences and facts. */
  tailor(input: { profile: ProfileSnapshot; job: TailoringJob }): Promise<TailoredCv>;
}

/** Where a fact goes on the CV; responsibilities and achievements sit under their role when it is known. */
export function sectionFor(fact: FactSnapshot, experienceIds: ReadonlySet<string>): CvSection {
  if (fact.kind === "skill") return "skills";
  const verbatim = VERBATIM_SECTIONS[fact.kind];
  if (verbatim) return verbatim;
  if ((fact.kind === "responsibility" || fact.kind === "achievement") && fact.workExperienceId && experienceIds.has(fact.workExperienceId)) {
    return "experience";
  }
  return "other";
}

/**
 * Lists what `text` claims beyond `sources`: numbers (including years) that no source contains, employers of the
 * user's other roles, and the target company presented as an employer.
 */
export function unsupportedClaims(
  text: string,
  sources: readonly string[],
  context: { employers: readonly string[]; forbiddenNames: readonly string[] },
): string[] {
  const sourceText = ` ${squash(sources.join(" "))} `;
  const sourceNumbers = new Set(numbersIn(sources.join(" ")));
  const claims: string[] = [];
  for (const number of numbersIn(text)) {
    if (!sourceNumbers.has(number)) claims.push(`number ${number}`);
  }
  const lower = ` ${squash(text)} `;
  for (const name of [...context.employers, ...context.forbiddenNames]) {
    const needle = squash(name);
    if (needle.length >= 2 && lower.includes(` ${needle} `) && !sourceText.includes(` ${needle} `)) claims.push(`name ${name}`);
  }
  return [...new Set(claims)];
}

/**
 * Maps a model draft back to real facts and enforces the truth rules: every line cites a verified fact, tailored
 * bullets that claim more than their fact fall back to the fact's own wording, unsupported summary sentences and
 * notes are dropped, and skills, education, certifications and languages are always copied verbatim.
 */
export function groundTailoring(
  draft: TailoringDraft,
  aliases: TailoringAliases,
  profile: ProfileSnapshot,
  job: TailoringJob,
): TailoredCv {
  const facts = new Map(profile.facts.map((f) => [f.id, f]));
  const experiences = new Map(profile.experiences.map((e) => [e.id, e]));
  const experienceIds = new Set(experiences.keys());
  const context = {
    employers: profile.experiences.map((e) => e.employer),
    forbiddenNames: job.company && !profile.experiences.some((e) => squash(e.employer) === squash(job.company!)) ? [job.company] : [],
  };
  const noteContext = { ...context, forbiddenNames: [] };
  const violations: string[] = [];
  const items: TailoredItem[] = [];
  const positions = new Map<CvSection, number>();
  const push = (careerFactId: string, section: CvSection, text: string) => {
    const position = positions.get(section) ?? 0;
    positions.set(section, position + 1);
    items.push({ careerFactId, section, position, text });
  };
  const factFor = (alias: string) => facts.get(aliases.facts.get(alias.trim()) ?? "");
  const sourcesFor = (aliasList: readonly string[]) => {
    const cited = aliasList.map((a) => a.trim());
    const citedFacts = cited.map((a) => facts.get(aliases.facts.get(a) ?? "")).filter((f): f is FactSnapshot => !!f);
    const citedExperiences = cited
      .map((a) => experiences.get(aliases.experiences.get(a) ?? ""))
      .filter((e): e is ExperienceSnapshot => !!e);
    for (const fact of citedFacts) {
      const experience = fact.workExperienceId ? experiences.get(fact.workExperienceId) : undefined;
      if (experience && !citedExperiences.includes(experience)) citedExperiences.push(experience);
    }
    return { citedFacts, texts: [...citedFacts.map((f) => f.statement), ...citedExperiences.map(describeExperience)] };
  };

  let sentences = 0;
  for (const sentence of draft.summary) {
    const text = sentence.text.trim();
    const { citedFacts, texts } = sourcesFor(sentence.sources);
    if (!text || citedFacts.length === 0 || sentences >= MAX_SUMMARY_SENTENCES) continue;
    const claims = unsupportedClaims(text, texts, context);
    if (claims.length) {
      violations.push(`summary “${text}”: ${claims.join(", ")}`);
      continue;
    }
    push(citedFacts[0]!.id, "summary", text);
    sentences++;
  }

  const used = new Set<string>();
  const perRole = new Map<string, number>();
  let bullets = 0;
  for (const highlight of draft.highlights) {
    const fact = factFor(highlight.fact);
    if (!fact || used.has(fact.id) || bullets >= MAX_BULLETS) continue;
    const section = sectionFor(fact, experienceIds);
    if (section !== "experience" && section !== "other") continue;
    const role = fact.workExperienceId ?? "";
    if (section === "experience" && (perRole.get(role) ?? 0) >= MAX_BULLETS_PER_ROLE) continue;

    let text = highlight.text.trim() || fact.statement;
    const claims = unsupportedClaims(text, sourcesFor([highlight.fact]).texts, context);
    if (claims.length) {
      violations.push(`bullet “${text}”: ${claims.join(", ")}`);
      text = fact.statement;
    }
    used.add(fact.id);
    perRole.set(role, (perRole.get(role) ?? 0) + 1);
    bullets++;
    push(fact.id, section, text);
  }

  for (const alias of draft.skills) {
    const fact = factFor(alias);
    if (!fact || fact.kind !== "skill" || used.has(fact.id)) continue;
    used.add(fact.id);
    push(fact.id, "skills", fact.statement);
  }
  for (const fact of profile.facts) {
    const section = VERBATIM_SECTIONS[fact.kind];
    if (section) push(fact.id, section, fact.statement);
  }

  let applicationNote: string | null = draft.applicationNote.text.trim() || null;
  if (applicationNote) {
    const { citedFacts, texts } = sourcesFor(draft.applicationNote.sources);
    const claims = unsupportedClaims(applicationNote, texts, noteContext);
    if (citedFacts.length === 0) claims.push("no cited facts");
    if (claims.length) {
      violations.push(`application note: ${claims.join(", ")}`);
      applicationNote = null;
    }
  }

  items.sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section) || a.position - b.position);
  return { items, applicationNote, violations };
}

function describeExperience(e: ExperienceSnapshot): string {
  return [
    e.title,
    e.employer,
    e.industry,
    e.location,
    e.startDate,
    e.endDate,
    e.managedHeadcount === null ? null : `managed ${e.managedHeadcount}`,
  ]
    .filter(Boolean)
    .join(" ");
}

function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,(?=\d{3}\b)/g, ""));
}

function squash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
