import { Experimental_DecisionMockModelV4, MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AiDeepMatcher,
  confidenceFrom,
  groundVerdict,
  renderProfile,
  toDecision,
  type FitDecision,
  type FitExplanation,
} from "../src/ai/deep-matcher.js";
import { careerFacts, careerProfiles, jobs, matchEvaluations, matches, users, workExperiences } from "../src/db/schema.js";
import type { ProfileSnapshot } from "../src/domain/profile.js";
import type { JobSourceAdapter } from "../src/ingestion/adapter.js";
import { deduplicateJobs } from "../src/ingestion/dedup.js";
import { ingestFromSource } from "../src/ingestion/ingest.js";
import { runDeepMatching, type DeepMatcher, type DeepMatchJob, type DeepMatchVerdict } from "../src/matching/deep-match.js";
import { EVAL_CASES, EVAL_PROFILE, checkVerdict, runDeepMatchEval } from "../src/matching/deep-match-eval.js";
import { runCheapMatching } from "../src/matching/run.js";
import { createTestDb, type TestDb } from "./support/db.js";

const PEOPLE_OPS_DESCRIPTION =
  "Own hiring, onboarding and performance reviews for a team of 150, design compensation planning and partner with leadership on culture and employee engagement.";

const snapshot: ProfileSnapshot = {
  profile: {
    headline: "HR Business Partner",
    summary: null,
    currentSeniority: "senior",
    managementScope: null,
    openToAdjacentRoles: false,
    linkedinUrl: null,
  },
  experiences: [
    {
      id: "exp-1",
      employer: "Acme",
      title: "HR Business Partner",
      industry: "Software",
      location: null,
      seniority: "senior",
      managedHeadcount: 4,
      startDate: "2021-01-01",
      endDate: null,
      isCurrent: true,
    },
  ],
  facts: [
    { id: "fact-1", kind: "responsibility", statement: "Led hiring and onboarding for 120 engineers", workExperienceId: "exp-1" },
    { id: "fact-2", kind: "language", statement: "Hebrew", workExperienceId: null },
  ],
  preferences: [
    {
      id: "pref-1",
      kind: "hard_constraint",
      dimension: "compensation",
      label: "At least 25k ILS",
      value: { type: "compensation", currency: "ILS", min: 25_000, period: "month" },
      status: "active",
    },
    {
      id: "pref-2",
      kind: "dislike",
      dimension: "role",
      label: "Recruiting",
      value: { type: "terms", terms: ["recruiter"] },
      status: "proposed",
    },
  ],
};

const peopleOpsJob: DeepMatchJob = {
  title: "People Operations Lead",
  company: "Beta",
  description: PEOPLE_OPS_DESCRIPTION,
  location: "Tel Aviv",
  workMode: "hybrid",
  employmentType: "full_time",
};

const output = (overrides: Partial<FitExplanation> = {}): FitExplanation => ({
  fitEvidence: [
    { claim: "Has run hiring and onboarding at scale", sources: ["f1", "e1"], jobExcerpt: "Own hiring,  ONBOARDING and performance reviews" },
  ],
  gaps: ["No culture program ownership shown", " "],
  risks: [],
  transferableSkills: ["Onboarding design"],
  adjacencyReasoning: "A natural step from HRBP into people operations.",
  explanation: " Your hiring and onboarding work maps directly onto this role. ",
  ...overrides,
});

const goodFit: FitDecision = { recommendation: "good_fit", confidence: "high", vetoes: [] };

describe("renderProfile", () => {
  it("aliases experiences and facts, nests role facts and lists only active preferences", () => {
    const { text, aliases } = renderProfile(snapshot);

    expect(aliases.experiences).toEqual(new Map([["e1", "exp-1"]]));
    expect(aliases.facts).toEqual(
      new Map([
        ["f1", "fact-1"],
        ["f2", "fact-2"],
      ]),
    );
    expect(text).toContain("[e1] HR Business Partner at Acme, 2021-01 – present (Software, senior, managed 4)");
    expect(text).toContain("  [f1] (responsibility) Led hiring and onboarding for 120 engineers");
    expect(text).toContain("Skills, education and other facts:\n[f2] (language) Hebrew");
    expect(text).toContain("Open to adjacent roles: no");
    expect(text).toContain("Must-haves:\n- At least 25k ILS");
    expect(text).not.toContain("Recruiting");
    expect(text).not.toContain("fact-1");
  });
});

describe("groundVerdict", () => {
  const { aliases } = renderProfile(snapshot);

  it("keeps the decision, maps aliases to real ids and keeps verbatim excerpts", () => {
    const verdict = groundVerdict(goodFit, output(), aliases, peopleOpsJob);

    expect(verdict).toEqual({
      recommendation: "good_fit",
      confidence: "high",
      explanation: "Your hiring and onboarding work maps directly onto this role.",
      evidence: {
        fitEvidence: [
          {
            claim: "Has run hiring and onboarding at scale",
            careerFactIds: ["fact-1"],
            workExperienceIds: ["exp-1"],
            jobExcerpt: "Own hiring,  ONBOARDING and performance reviews",
          },
        ],
        gaps: ["No culture program ownership shown"],
        risks: [],
        transferableSkills: ["Onboarding design"],
        adjacencyReasoning: "A natural step from HRBP into people operations.",
      },
    });
  });

  it("drops ungrounded claims and invented excerpts, and lowers confidence when no evidence is left", () => {
    const verdict = groundVerdict(
      goodFit,
      output({
        fitEvidence: [
          { claim: "Ran payroll for 2,000 people", sources: ["f9", "e7"], jobExcerpt: null },
          { claim: "Speaks Hebrew", sources: ["f2"], jobExcerpt: "Hebrew is a must" },
        ],
      }),
      aliases,
      peopleOpsJob,
    );
    expect(verdict.evidence.fitEvidence).toEqual([{ claim: "Speaks Hebrew", careerFactIds: ["fact-2"] }]);
    expect(verdict.confidence).toBe("high");

    const unsupported = groundVerdict(
      goodFit,
      output({ fitEvidence: [{ claim: "Great culture fit", sources: [], jobExcerpt: null }] }),
      aliases,
      peopleOpsJob,
    );
    expect(unsupported).toMatchObject({ confidence: "low", evidence: { fitEvidence: [] } });
  });
});

describe("toDecision", () => {
  const veto = (name: string, probability: number) => ({
    reason: `${name} reason`,
    explanation: `${name} explanation`,
    probability,
  });

  it("keeps the model's recommendation when no check fires, with confidence from its probability", () => {
    expect(toDecision("stretch", 0.65, [veto("salary", 0.2)])).toEqual({
      recommendation: "stretch",
      confidence: "medium",
      vetoes: [],
    });
  });

  it("rejects when a must-have or dislike check fires, strongest first", () => {
    expect(toDecision("strong_fit", 0.95, [veto("salary", 0.7), veto("recruiting", 0.92), veto("remote", 0.1)])).toEqual({
      recommendation: "not_recommended",
      confidence: "high",
      vetoes: [
        { reason: "recruiting reason", explanation: "recruiting explanation" },
        { reason: "salary reason", explanation: "salary explanation" },
      ],
    });
  });

  it("maps probabilities to confidence and treats a missing distribution as low", () => {
    expect([0.95, 0.8, 0.7, 0.6, 0.4].map(confidenceFrom)).toEqual(["high", "high", "medium", "medium", "low"]);
    expect(confidenceFrom(undefined)).toBe("low");
  });
});

describe("AiDeepMatcher", () => {
  type DecideOptions = Parameters<Experimental_DecisionMockModelV4["doDecide"]>[0];

  function decisionModel(answer: (options: DecideOptions) => Record<string, unknown>) {
    const calls: DecideOptions[] = [];
    const model = new Experimental_DecisionMockModelV4({
      provider: "typesafe-ai",
      modelId: "jev-mock",
      supportedQuestionTypes: ["choice", "score", "boolean"],
      doDecide: async (options) => {
        calls.push(options);
        return { answers: answer(options) as never, warnings: [] };
      },
    });
    return { model, calls };
  }

  function languageModel(text: string) {
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      modelId: "sonnet-mock",
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return {
          content: [{ type: "text", text }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 10, text: 10, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    return { model, prompts };
  }

  const choice = (selected: string, probability: number) => ({
    type: "choice",
    choice: selected,
    probabilities: Object.fromEntries(
      ["strong_fit", "good_fit", "stretch", "not_recommended"].map((option) => [
        option,
        option === selected ? probability : (1 - probability) / 3,
      ]),
    ),
  });

  it("asks Jev for the recommendation and one check per must-have and closed adjacency, then explains with the LLM", async () => {
    const jev = decisionModel(() => ({
      recommendation: choice("good_fit", 0.85),
      mustHave1: { type: "boolean", probability: 0.1 },
      outsidePath: { type: "boolean", probability: 0.2 },
    }));
    const llm = languageModel(JSON.stringify(output()));
    const matcher = new AiDeepMatcher(jev.model, llm.model);

    const verdict = await matcher.evaluate({ profile: snapshot, job: peopleOpsJob, language: "en" });

    expect(matcher).toMatchObject({ model: "jev-mock + sonnet-mock", promptVersion: "deep-match-v4" });
    expect(Object.keys(jev.calls[0]!.questions)).toEqual(["recommendation", "mustHave1", "outsidePath"]);
    expect(jev.calls[0]!.questions.mustHave1).toMatchObject({ type: "boolean" });
    expect(JSON.stringify(jev.calls[0]!.questions.mustHave1)).toContain("At least 25k ILS");
    expect(JSON.stringify(jev.calls[0]!.state)).toContain("[f1] (responsibility) Led hiring and onboarding");
    expect(llm.prompts[0]).toContain("good_fit:");
    expect(llm.prompts[0]).toContain("Title: People Operations Lead");
    expect(llm.prompts[0]).not.toContain("the hiring company.</employer>");
    expect(verdict).toMatchObject({ recommendation: "good_fit", confidence: "high" });
    expect(verdict.evidence.fitEvidence[0]?.careerFactIds).toEqual(["fact-1"]);
  });

  it("tells the LLM when the job is at the candidate's current employer", async () => {
    const jev = decisionModel(() => ({
      recommendation: choice("good_fit", 0.85),
      mustHave1: { type: "boolean", probability: 0.1 },
      outsidePath: { type: "boolean", probability: 0.2 },
    }));
    const llm = languageModel(JSON.stringify(output()));

    await new AiDeepMatcher(jev.model, llm.model).evaluate({ profile: snapshot, job: { ...peopleOpsJob, company: "Acme Inc." }, language: "en" });

    expect(llm.prompts[0]).toContain("The candidate currently works at Acme, the hiring company.");
  });

  it("rejects on a must-have without calling the LLM", async () => {
    const jev = decisionModel(() => ({
      recommendation: choice("strong_fit", 0.9),
      mustHave1: { type: "boolean", probability: 0.93 },
      outsidePath: { type: "boolean", probability: 0.05 },
    }));
    const llm = languageModel("{}");

    const verdict = await new AiDeepMatcher(jev.model, llm.model).evaluate({ profile: snapshot, job: peopleOpsJob, language: "en" });

    expect(llm.prompts).toEqual([]);
    expect(verdict).toEqual({
      recommendation: "not_recommended",
      confidence: "high",
      explanation: "This job conflicts with your must-have: At least 25k ILS.",
      evidence: { fitEvidence: [], gaps: [], risks: ["Breaks must-have “At least 25k ILS”"], transferableSkills: [] },
    });
  });

  it("explains in the user's language", async () => {
    const jev = decisionModel(() => ({
      recommendation: choice("good_fit", 0.85),
      mustHave1: { type: "boolean", probability: 0.1 },
      outsidePath: { type: "boolean", probability: 0.2 },
    }));
    const llm = languageModel(JSON.stringify(output()));

    await new AiDeepMatcher(jev.model, llm.model).evaluate({ profile: snapshot, job: peopleOpsJob, language: "he" });
    expect(llm.prompts[0]).toContain("natural, fluent Hebrew");

    const vetoed = decisionModel(() => ({
      recommendation: choice("strong_fit", 0.9),
      mustHave1: { type: "boolean", probability: 0.93 },
      outsidePath: { type: "boolean", probability: 0.05 },
    }));
    const verdict = await new AiDeepMatcher(vetoed.model, llm.model).evaluate({ profile: snapshot, job: peopleOpsJob, language: "he" });
    expect(verdict.explanation).toBe("המשרה הזו מתנגשת בדרישת החובה שלך: At least 25k ILS.");
    expect(verdict.evidence.risks).toEqual(["Breaks must-have “At least 25k ILS”"]);
  });

  it("skips the LLM when Jev does not recommend the job", async () => {
    const jev = decisionModel(() => ({
      recommendation: choice("not_recommended", 0.7),
      mustHave1: { type: "boolean", probability: 0.1 },
      outsidePath: { type: "boolean", probability: 0.3 },
    }));
    const llm = languageModel("{}");

    const verdict = await new AiDeepMatcher(jev.model, llm.model).evaluate({ profile: snapshot, job: peopleOpsJob, language: "en" });

    expect(llm.prompts).toEqual([]);
    expect(verdict).toMatchObject({ recommendation: "not_recommended", confidence: "medium", evidence: { risks: [] } });
  });
});

class FakeMatcher implements DeepMatcher {
  readonly model = "fake-model";
  readonly promptVersion = "fake-v1";
  readonly calls: { profile: ProfileSnapshot; job: DeepMatchJob }[] = [];

  constructor(private readonly decide: (job: DeepMatchJob) => DeepMatchVerdict) {}

  async evaluate(input: { profile: ProfileSnapshot; job: DeepMatchJob }) {
    this.calls.push(input);
    return this.decide(input.job);
  }
}

const verdict = (recommendation: DeepMatchVerdict["recommendation"], factIds: string[] = []): DeepMatchVerdict => ({
  recommendation,
  confidence: "medium",
  explanation: `Verdict: ${recommendation}`,
  evidence: {
    fitEvidence: factIds.length ? [{ claim: "Relevant experience", careerFactIds: factIds }] : [],
    gaps: [],
    risks: [],
    transferableSkills: [],
    adjacencyReasoning: "Adjacent",
  },
});

interface Posting {
  id: string;
  title: string;
  body?: string;
}

function boardAdapter(postings: Posting[]): JobSourceAdapter<Posting> {
  return {
    source: { key: "board", name: "Board", kind: "api" },
    *collect() {
      for (const p of postings) yield { externalId: p.id, sourceUrl: `https://board.example/${p.id}`, payload: p };
    },
    normalize: ({ payload }) => ({
      title: payload.title,
      description: payload.body ?? PEOPLE_OPS_DESCRIPTION,
      company: "Acme",
      location: "Tel Aviv",
    }),
  };
}

describe("runDeepMatching", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const now = () => new Date("2026-10-06T10:00:00Z");

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });

  afterEach(async () => {
    await close();
  });

  async function setup(postings: Posting[]) {
    const verifiedAt = new Date();
    const [user] = await db.insert(users).values({ telegramUserId: 1, telegramChatId: 1 }).returning();
    const userId = user!.id;
    await db.insert(careerProfiles).values({ userId, status: "confirmed", revision: 5, headline: "HR Business Partner" });
    const [experience] = await db
      .insert(workExperiences)
      .values({ userId, employer: "Acme", title: "HR Business Partner", origin: "cv_upload", verificationStatus: "verified", verifiedAt })
      .returning();
    const [verified, unverified] = await db
      .insert(careerFacts)
      .values([
        {
          userId,
          workExperienceId: experience!.id,
          kind: "responsibility",
          statement: "Led hiring, onboarding, performance reviews and compensation planning",
          origin: "cv_upload",
          verificationStatus: "verified",
          verifiedAt,
        },
        { userId, kind: "skill", statement: "Unconfirmed claim about hiring", origin: "cv_upload" },
      ])
      .returning();
    await ingestFromSource(db, boardAdapter(postings), { now });
    await deduplicateJobs(db, { now });
    await runCheapMatching(db, { now });
    return { userId, verifiedFactId: verified!.id, unverifiedFactId: unverified!.id };
  }

  const matchByExternalId = async (externalId: string) => {
    const [row] = await db
      .select({ match: matches })
      .from(matches)
      .innerJoin(jobs, eq(jobs.id, matches.jobId))
      .where(eq(jobs.externalId, externalId));
    return row!.match;
  };

  it("promotes recommended matches, filters the rest and records the evaluation", async () => {
    const { verifiedFactId, unverifiedFactId } = await setup([
      { id: "adjacent", title: "People Operations Lead" },
      { id: "poor", title: "HR Coordinator" },
    ]);
    const matcher = new FakeMatcher((job) =>
      job.title === "People Operations Lead" ? verdict("stretch", [verifiedFactId]) : verdict("not_recommended"),
    );

    const report = await runDeepMatching(db, matcher, { now });

    expect(report).toMatchObject({ evaluated: 2, recommended: 1, notRecommended: 1, errors: [] });
    const factIds = matcher.calls[0]!.profile.facts.map((f) => f.id);
    expect(factIds).toEqual([verifiedFactId]);
    expect(factIds).not.toContain(unverifiedFactId);

    const adjacent = await matchByExternalId("adjacent");
    expect(adjacent).toMatchObject({
      status: "ready",
      stageReached: "deep_match",
      recommendation: "stretch",
      confidence: "medium",
      explanation: "Verdict: stretch",
    });
    const [evaluation] = await db
      .select()
      .from(matchEvaluations)
      .where(eq(matchEvaluations.matchId, adjacent.id))
      .orderBy(matchEvaluations.createdAt)
      .then((rows) => rows.filter((r) => r.stage === "deep_match"));
    expect(evaluation).toMatchObject({
      outcome: "passed",
      recommendation: "stretch",
      score: null,
      profileRevision: 5,
      model: "fake-model",
      promptVersion: "fake-v1",
      evidence: { fitEvidence: [{ careerFactIds: [verifiedFactId] }], adjacencyReasoning: "Adjacent" },
    });

    expect(await matchByExternalId("poor")).toMatchObject({ status: "filtered_out", stageReached: "deep_match" });
    expect(await runDeepMatching(db, matcher, { now })).toMatchObject({ evaluated: 0 });
  });

  it("leaves a match pending when the matcher fails and respects the limit", async () => {
    await setup([
      { id: "a", title: "People Operations Lead" },
      { id: "b", title: "HR Business Partner" },
    ]);
    const failing = new FakeMatcher(() => {
      throw new Error("gateway timeout");
    });

    const report = await runDeepMatching(db, failing, { now, limit: 1 });

    expect(failing.calls).toHaveLength(1);
    expect(report).toMatchObject({ evaluated: 0, errors: [{ error: "gateway timeout" }] });
    const pending = await db.select().from(matches).where(eq(matches.status, "pending"));
    expect(pending).toHaveLength(2);
  });

  it("starts no evaluation after the deadline", async () => {
    await setup([
      { id: "a", title: "People Operations Lead" },
      { id: "b", title: "HR Business Partner" },
    ]);
    let clock = now().getTime();
    const matcher = new FakeMatcher(() => {
      clock += 60_000;
      return verdict("good_fit");
    });

    const report = await runDeepMatching(db, matcher, { now: () => new Date(clock), deadline: new Date(clock + 30_000) });

    expect(report).toMatchObject({ evaluated: 1, errors: [] });
    expect(await db.select().from(matches).where(eq(matches.status, "pending"))).toHaveLength(1);
  });

  it("skips matches that did not pass cheap relevance or belong to unconfirmed profiles", async () => {
    const { userId } = await setup([
      { id: "fit", title: "People Operations Lead" },
      { id: "unrelated", title: "Backend Engineer", body: "Write Go services and operate Kubernetes clusters." },
    ]);
    const matcher = new FakeMatcher(() => verdict("good_fit"));
    await db.update(careerProfiles).set({ status: "draft" }).where(eq(careerProfiles.userId, userId));
    expect(await runDeepMatching(db, matcher, { now })).toMatchObject({ evaluated: 0 });

    await db.update(careerProfiles).set({ status: "confirmed" }).where(eq(careerProfiles.userId, userId));
    expect(await runDeepMatching(db, matcher, { now })).toMatchObject({ evaluated: 1 });
    expect(matcher.calls.map((c) => c.job.title)).toEqual(["People Operations Lead"]);
  });
});

describe("deep match eval set", () => {
  it("covers obvious HR, adjacent and clearly negative roles", () => {
    const groups = new Set(EVAL_CASES.map((c) => c.group));
    expect(groups).toEqual(new Set(["obvious_hr", "adjacent", "negative"]));
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
  });

  it("flags wrong recommendations, ungrounded fits and numeric fit scores", () => {
    const negative = EVAL_CASES.find((c) => c.group === "negative")!;
    const obvious = EVAL_CASES.find((c) => c.group === "obvious_hr")!;

    expect(checkVerdict(negative, verdict("not_recommended"))).toEqual([]);
    expect(checkVerdict(obvious, verdict("strong_fit", ["f-partner"]))).toEqual([]);
    expect(checkVerdict(negative, verdict("good_fit", ["f-partner"]))).toEqual(["expected not_recommended, got good_fit"]);
    expect(checkVerdict(obvious, verdict("good_fit"))).toEqual(["recommended without grounded fit evidence"]);
    expect(
      checkVerdict(obvious, { ...verdict("good_fit", ["f-partner"]), explanation: "An 87% match for your background." }),
    ).toEqual(["explanation states a numeric fit score"]);
    expect(
      checkVerdict(obvious, { ...verdict("good_fit", ["f-partner"]), explanation: "You cut attrition from 14% to 8%." }),
    ).toEqual([]);
  });

  it("runs every case against the matcher and reports errors per case", async () => {
    const matcher = new FakeMatcher((job) => {
      if (job.title === "Senior Backend Engineer") throw new Error("boom");
      return verdict("not_recommended");
    });

    const results = await runDeepMatchEval(matcher);

    expect(matcher.calls.every((c) => c.profile === EVAL_PROFILE)).toBe(true);
    expect(results).toHaveLength(EVAL_CASES.length);
    expect(results.find((r) => r.case.id === "backend-engineer")?.problems).toEqual(["error: boom"]);
    expect(results.find((r) => r.case.id === "financial-controller")?.problems).toEqual([]);
    expect(results.find((r) => r.case.id === "hrbp-rnd")?.problems).toEqual(["expected strong_fit | good_fit, got not_recommended"]);
  });
});
