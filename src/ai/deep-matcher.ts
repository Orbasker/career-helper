import {
  experimental_decide,
  generateText,
  Output,
  type Experimental_DecisionModel,
  type Experimental_DecisionQuestion,
  type LanguageModel,
} from "ai";
import { z } from "zod";
import { formatMonth } from "../domain/dates.js";
import type { ConfidenceLevel, MatchRecommendation, PreferenceKind } from "../domain/enums.js";
import type { PreferenceSnapshot, ProfileSnapshot } from "../domain/profile.js";
import type { FitEvidence } from "../domain/types.js";
import { employerRelation } from "../matching/employer.js";
import { isRecommended, type DeepMatcher, type DeepMatchJob, type DeepMatchVerdict } from "../matching/deep-match.js";

export const DECISION_MODEL = "typesafe-ai/jev";
export const EXPLANATION_MODEL = "anthropic/claude-sonnet-5.5";
export const DEEP_MATCH_PROMPT_VERSION = "deep-match-v3";
const MAX_DESCRIPTION_CHARS = 20_000;
const VETO_PROBABILITY = 0.5;

const RECOMMENDATIONS: Record<MatchRecommendation, string> = {
  strong_fit:
    "The core of the role is clearly proven by the candidate's history; it is the same role or a natural next step.",
  good_fit: "Most of the core of the role is proven by the history; the gaps are learnable on the job.",
  stretch:
    "A plausible career-adjacent move: proven, transferable skills cover the heart of the role, but there are notable gaps.",
  not_recommended:
    "The core of the role is not proven by the history, or the move makes little sense for this candidate's career.",
};

const RECOMMENDATION_INSTRUCTIONS =
  "How well does this job fit the candidate's verified career history? Judge what the role does day to day, not its title: a different title can be a natural next step, and an identical title can be a poor fit (wrong domain, scope or seniority). Missing information in the posting is not a gap.";

const EXPLANATION_INSTRUCTIONS = `You explain a job match to a job seeker. You see their verified career history and preferences, one job posting, and the recommendation already decided for it. Do not change or question the recommendation; explain it.

Think like an experienced career coach, not a keyword matcher:
- Judge what the role actually does day to day, not its title.
- Career adjacency: say whether this is the same role, a natural step up or sideways, or a real pivot, and which proven skills carry over. Be concrete about what transfers and what does not.

Evidence rules:
- Every fitEvidence claim cites the ids (f* facts, e* experiences) that prove it. Only cite ids shown to you. Claims you cannot back with an id do not belong in fitEvidence.
- jobExcerpt is a short verbatim quote from the posting that the claim answers, or null.
- Never invent experience, skills, numbers or employers.
- gaps: requirements of the job the history does not show. Missing information in the posting is not a gap. risks: anything else that could make it a poor move (seniority jump, domain change, unclear scope, preference concerns).
- Never output numeric scores or percentages.

explanation: one or two plain sentences addressed to the candidate ("you"), saying why this job is worth a look. No jargon, no ids.

When an <employer> note says the candidate works or worked at the hiring company, say so in the explanation: an opening at their current employer is an internal move (they know the product and people, and can talk to their manager or HR); a former employer is a return where their inside knowledge and former colleagues help.`;

const explanationSchema = z.object({
  fitEvidence: z.array(
    z.object({
      claim: z.string(),
      sources: z.array(z.string()).describe("Ids of the facts (f*) and experiences (e*) that prove the claim"),
      jobExcerpt: z.string().nullable().describe("Short verbatim quote from the job posting, or null"),
    }),
  ),
  gaps: z.array(z.string()),
  risks: z.array(z.string()),
  transferableSkills: z.array(z.string()).describe("Proven skills that carry over to this role"),
  adjacencyReasoning: z.string().describe("How this role relates to the candidate's path and why the move makes sense"),
  explanation: z.string(),
});

export type FitExplanation = z.infer<typeof explanationSchema>;

export interface FitDecision {
  recommendation: MatchRecommendation;
  confidence: ConfidenceLevel;
  vetoes: Veto[];
}

export interface ProfileAliases {
  facts: Map<string, string>;
  experiences: Map<string, string>;
}

export interface Veto {
  reason: string;
  explanation: string;
}

const PREFERENCE_SECTIONS: [PreferenceKind, string][] = [
  ["hard_constraint", "Must-haves"],
  ["target_role", "Target roles"],
  ["soft_preference", "Nice-to-haves"],
  ["dislike", "Wants to avoid"],
];

/** Jev decides the recommendation and checks every must-have and dislike; a language model explains recommended matches. */
export class AiDeepMatcher implements DeepMatcher {
  readonly promptVersion = DEEP_MATCH_PROMPT_VERSION;
  readonly model: string;

  constructor(
    private readonly decisionModel: Experimental_DecisionModel = DECISION_MODEL,
    private readonly explanationModel: LanguageModel = EXPLANATION_MODEL,
  ) {
    this.model = `${modelName(decisionModel)} + ${modelName(explanationModel)}`;
  }

  async evaluate({ profile, job }: { profile: ProfileSnapshot; job: DeepMatchJob }): Promise<DeepMatchVerdict> {
    const { text: profileText, aliases } = renderProfile(profile);
    const jobText = renderJob(job);
    const decision = await this.decide(profile, profileText, jobText);

    if (!isRecommended(decision.recommendation)) {
      return {
        recommendation: decision.recommendation,
        confidence: decision.confidence,
        explanation: decision.vetoes[0]?.explanation ?? "This role doesn't build on your proven experience closely enough.",
        evidence: { fitEvidence: [], gaps: [], risks: decision.vetoes.map((v) => v.reason), transferableSkills: [] },
      };
    }

    const { output } = await generateText({
      model: this.explanationModel,
      instructions: EXPLANATION_INSTRUCTIONS,
      prompt: `<candidate>\n${profileText}\n</candidate>\n\n<job>\n${jobText}\n</job>${employerNote(profile, job)}\n\n<recommendation>${decision.recommendation}: ${RECOMMENDATIONS[decision.recommendation]}</recommendation>`,
      output: Output.object({ schema: explanationSchema }),
    });
    return groundVerdict(decision, output, aliases, job);
  }

  private async decide(profile: ProfileSnapshot, profileText: string, jobText: string): Promise<FitDecision> {
    const vetoQuestions = buildVetoQuestions(profile);
    const questions: Record<string, Experimental_DecisionQuestion> = {
      recommendation: { type: "choice", instructions: RECOMMENDATION_INSTRUCTIONS, criteria: RECOMMENDATIONS },
    };
    for (const [id, { question }] of vetoQuestions) questions[id] = question;

    const { answers } = await experimental_decide({
      model: this.decisionModel,
      state: { candidate: profileText, job: jobText },
      questions,
    });
    const probabilities = new Map<string, number>();
    for (const id of vetoQuestions.keys()) {
      const answer = answers[id];
      if (answer?.type === "boolean") probabilities.set(id, answer.probability);
    }
    const recommendation = answers.recommendation;
    if (recommendation?.type !== "choice") throw new Error("Decision model returned no recommendation");
    return toDecision(
      recommendation.choice as MatchRecommendation,
      recommendation.probabilities?.[recommendation.choice],
      [...vetoQuestions].map(([id, { veto }]) => ({ ...veto, probability: probabilities.get(id) ?? 0 })),
    );
  }
}

function buildVetoQuestions(profile: ProfileSnapshot): Map<string, { question: Experimental_DecisionQuestion; veto: Veto }> {
  const questions = new Map<string, { question: Experimental_DecisionQuestion; veto: Veto }>();
  const active = profile.preferences.filter((p) => p.status === "active");
  const add = (id: string, instructions: string, veto: Veto) =>
    questions.set(id, { question: { type: "boolean", instructions }, veto });

  active
    .filter((p) => p.kind === "hard_constraint")
    .forEach((p: PreferenceSnapshot, i) =>
      add(
        `mustHave${i + 1}`,
        `Does this job clearly break the candidate's must-have "${p.label}"? Answer no when the posting does not say.`,
        { reason: `Breaks must-have “${p.label}”`, explanation: `This job conflicts with your must-have: ${p.label}.` },
      ),
    );
  active
    .filter((p) => p.kind === "dislike")
    .forEach((p, i) =>
      add(`dislike${i + 1}`, `Is this job mainly the kind of work the candidate wants to avoid: "${p.label}"?`, {
        reason: `Matches something to avoid: “${p.label}”`,
        explanation: `This looks like the kind of role you want to avoid: ${p.label}.`,
      }),
    );
  if (!profile.profile.openToAdjacentRoles) {
    add(
      "outsidePath",
      "Is this job outside both the candidate's target roles and the kinds of roles they have held before?",
      {
        reason: "Outside target and past roles, and the candidate is not open to adjacent roles",
        explanation: "This role is outside the roles you're targeting, and you asked to skip adjacent roles.",
      },
    );
  }
  return questions;
}

/** A must-have, dislike or closed-adjacency check above the veto threshold overrides the recommendation. */
export function toDecision(
  recommendation: MatchRecommendation,
  probability: number | undefined,
  checks: (Veto & { probability: number })[],
): FitDecision {
  const hits = checks.filter((c) => c.probability >= VETO_PROBABILITY).sort((a, b) => b.probability - a.probability);
  if (hits.length) {
    return {
      recommendation: "not_recommended",
      confidence: confidenceFrom(hits[0]!.probability),
      vetoes: hits.map(({ reason, explanation }) => ({ reason, explanation })),
    };
  }
  return { recommendation, confidence: confidenceFrom(probability), vetoes: [] };
}

/** Without a probability distribution there is no basis for more than low confidence. */
export function confidenceFrom(probability: number | undefined): ConfidenceLevel {
  if (probability === undefined) return "low";
  return probability >= 0.8 ? "high" : probability >= 0.6 ? "medium" : "low";
}

export function renderProfile(snapshot: ProfileSnapshot): { text: string; aliases: ProfileAliases } {
  const aliases: ProfileAliases = { facts: new Map(), experiences: new Map() };
  const factLine = (fact: ProfileSnapshot["facts"][number]) => {
    const alias = `f${aliases.facts.size + 1}`;
    aliases.facts.set(alias, fact.id);
    return `[${alias}] (${fact.kind}) ${fact.statement}`;
  };

  const { profile } = snapshot;
  const lines: string[] = [];
  if (profile.headline) lines.push(`Headline: ${profile.headline}`);
  if (profile.summary) lines.push(`Summary: ${profile.summary}`);
  if (profile.currentSeniority) lines.push(`Current seniority: ${profile.currentSeniority}`);
  if (profile.managementScope) lines.push(`Management scope: ${profile.managementScope}`);
  lines.push(`Open to adjacent roles: ${profile.openToAdjacentRoles ? "yes" : "no"}`);

  lines.push("", "Experience:");
  for (const experience of snapshot.experiences) {
    const alias = `e${aliases.experiences.size + 1}`;
    aliases.experiences.set(alias, experience.id);
    const period = `${formatMonth(experience.startDate) ?? "?"} – ${experience.isCurrent ? "present" : (formatMonth(experience.endDate) ?? "?")}`;
    const details = [
      experience.industry,
      experience.location,
      experience.seniority,
      experience.managedHeadcount ? `managed ${experience.managedHeadcount}` : null,
    ].filter(Boolean);
    lines.push(
      `[${alias}] ${experience.title} at ${experience.employer}, ${period}${details.length ? ` (${details.join(", ")})` : ""}`,
    );
    for (const fact of snapshot.facts) {
      if (fact.workExperienceId === experience.id) lines.push(`  ${factLine(fact)}`);
    }
  }
  if (!snapshot.experiences.length) lines.push("(none)");

  const experienceIds = new Set(snapshot.experiences.map((e) => e.id));
  const general = snapshot.facts.filter((f) => !f.workExperienceId || !experienceIds.has(f.workExperienceId));
  if (general.length) {
    lines.push("", "Skills, education and other facts:");
    for (const fact of general) lines.push(factLine(fact));
  }

  const active = snapshot.preferences.filter((p) => p.status === "active");
  for (const [kind, heading] of PREFERENCE_SECTIONS) {
    const labels = active.filter((p) => p.kind === kind).map((p) => `- ${p.label}`);
    if (labels.length) lines.push("", `${heading}:`, ...labels);
  }
  return { text: lines.join("\n"), aliases };
}

function employerNote(profile: ProfileSnapshot, job: DeepMatchJob): string {
  const relation = employerRelation(job.company, profile.experiences);
  if (!relation) return "";
  const when = relation.kind === "current" ? "currently works" : "used to work";
  return `\n\n<employer>The candidate ${when} at ${relation.employer}, the hiring company.</employer>`;
}

function renderJob(job: DeepMatchJob): string {
  return [
    `Title: ${job.title}`,
    `Company: ${job.company ?? "unknown"}`,
    `Location: ${job.location ?? "unknown"}`,
    `Work mode: ${job.workMode ?? "unknown"}`,
    `Employment type: ${job.employmentType?.replace("_", "-") ?? "unknown"}`,
    "",
    job.description.slice(0, MAX_DESCRIPTION_CHARS),
  ].join("\n");
}

/** Maps aliases back to real ids, dropping claims without a known source and excerpts not found in the posting. */
export function groundVerdict(
  decision: FitDecision,
  output: FitExplanation,
  aliases: ProfileAliases,
  job: DeepMatchJob,
): DeepMatchVerdict {
  const posting = squash(`${job.title} ${job.description}`);
  const fitEvidence: FitEvidence[] = [];
  for (const item of output.fitEvidence) {
    const claim = item.claim.trim();
    const careerFactIds = unique(item.sources.map((s) => aliases.facts.get(s.trim())));
    const workExperienceIds = unique(item.sources.map((s) => aliases.experiences.get(s.trim())));
    if (!claim || (!careerFactIds.length && !workExperienceIds.length)) continue;
    const excerpt = item.jobExcerpt?.trim();
    fitEvidence.push({
      claim,
      careerFactIds,
      ...(workExperienceIds.length ? { workExperienceIds } : {}),
      ...(excerpt && posting.includes(squash(excerpt)) ? { jobExcerpt: excerpt } : {}),
    });
  }

  const adjacencyReasoning = output.adjacencyReasoning.trim();
  return {
    recommendation: decision.recommendation,
    confidence: fitEvidence.length ? decision.confidence : "low",
    explanation: output.explanation.trim(),
    evidence: {
      fitEvidence,
      gaps: cleanList(output.gaps),
      risks: cleanList(output.risks),
      transferableSkills: cleanList(output.transferableSkills),
      ...(adjacencyReasoning ? { adjacencyReasoning } : {}),
    },
  };
}

function modelName(model: string | { modelId: string }): string {
  return typeof model === "string" ? model : model.modelId;
}

function squash(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function unique(ids: (string | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => id !== undefined))];
}

function cleanList(items: string[]): string[] {
  return items.map((item) => item.trim()).filter(Boolean);
}
