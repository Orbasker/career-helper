import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  careerFacts,
  careerProfiles,
  jobs,
  matchEvaluations,
  matches,
  preferences,
  users,
  workExperiences,
} from "../src/db/schema.js";
import type { PreferenceSnapshot, ProfileSnapshot } from "../src/domain/profile.js";
import type { PreferenceValue } from "../src/domain/types.js";
import type { JobSourceAdapter } from "../src/ingestion/adapter.js";
import { deduplicateJobs } from "../src/ingestion/dedup.js";
import { ingestFromSource } from "../src/ingestion/ingest.js";
import { applyHardFilters, inferSeniority } from "../src/matching/hard-filters.js";
import { buildRelevanceProfile, scoreRelevance } from "../src/matching/relevance.js";
import { runCheapMatching } from "../src/matching/run.js";
import type { MatchJob } from "../src/matching/types.js";
import { createTestDb, type TestDb } from "./support/db.js";

const PEOPLE_OPS_DESCRIPTION =
  "Own hiring, onboarding and performance reviews for a team of 150, design compensation planning and partner with leadership on culture and employee engagement.";
const BACKEND_DESCRIPTION =
  "Write backend services in Go and Rust, operate Kubernetes clusters and tune Postgres query performance.";

function job(overrides: Partial<MatchJob> = {}): MatchJob {
  return {
    title: "HR Manager",
    description: PEOPLE_OPS_DESCRIPTION,
    location: "Tel Aviv, Israel",
    workMode: null,
    employmentType: null,
    ...overrides,
  };
}

let preferenceCount = 0;
function pref(
  kind: PreferenceSnapshot["kind"],
  value: PreferenceValue,
  overrides: Partial<PreferenceSnapshot> = {},
): PreferenceSnapshot {
  preferenceCount++;
  return {
    id: `p${preferenceCount}`,
    kind,
    dimension: value.type === "terms" ? "role" : value.type === "free_text" ? "other" : value.type,
    label: `${kind} ${preferenceCount}`,
    value,
    status: "active",
    ...overrides,
  };
}

const hrSnapshot = (prefs: PreferenceSnapshot[] = []): ProfileSnapshot => ({
  profile: {
    headline: "HR Business Partner",
    summary: null,
    currentSeniority: "senior",
    managementScope: null,
    openToAdjacentRoles: true,
    linkedinUrl: null,
  },
  experiences: [
    {
      id: "e1",
      employer: "Acme",
      title: "HR Business Partner",
      industry: "Software",
      location: "Tel Aviv",
      seniority: "senior",
      managedHeadcount: null,
      startDate: "2021-01-01",
      endDate: null,
      isCurrent: true,
    },
  ],
  facts: [
    { id: "f1", kind: "responsibility", statement: "Led hiring and onboarding for 120 engineers", workExperienceId: "e1" },
    { id: "f2", kind: "achievement", statement: "Redesigned performance reviews and compensation bands", workExperienceId: "e1" },
    { id: "f3", kind: "skill", statement: "Employee engagement", workExperienceId: null },
    { id: "f4", kind: "language", statement: "Hebrew", workExperienceId: null },
  ],
  preferences: prefs,
});

describe("applyHardFilters", () => {
  it("passes when there are no active hard constraints", () => {
    const prefs = [
      pref("soft_preference", { type: "work_mode", modes: ["remote"] }),
      pref("hard_constraint", { type: "work_mode", modes: ["remote"] }, { status: "proposed" }),
    ];
    expect(applyHardFilters(job({ workMode: "onsite" }), prefs)).toEqual({ passed: true, failures: [] });
  });

  it("rejects explicitly contradicting work mode and employment type", () => {
    const workMode = pref("hard_constraint", { type: "work_mode", modes: ["remote", "hybrid"] }, { label: "Remote or hybrid" });
    const fullTime = pref("hard_constraint", { type: "employment_type", types: ["full_time"] }, { label: "Full-time" });

    expect(applyHardFilters(job({ workMode: "onsite", employmentType: "part_time" }), [workMode, fullTime])).toEqual({
      passed: false,
      failures: [
        { preferenceId: workMode.id, label: "Remote or hybrid", reason: "work mode is onsite" },
        { preferenceId: fullTime.id, label: "Full-time", reason: "employment type is part-time" },
      ],
    });
    expect(applyHardFilters(job({ workMode: "hybrid", employmentType: "full_time" }), [workMode, fullTime]).passed).toBe(true);
  });

  it("never rejects on missing job data", () => {
    const prefs = [
      pref("hard_constraint", { type: "work_mode", modes: ["remote"] }),
      pref("hard_constraint", { type: "employment_type", types: ["full_time"] }),
      pref("hard_constraint", { type: "location", places: ["Haifa"] }),
    ];
    expect(applyHardFilters(job({ location: null }), prefs).passed).toBe(true);
  });

  it("matches locations by city, country and remote", () => {
    const israel = [pref("hard_constraint", { type: "location", places: ["Israel"] })];
    const telAviv = [pref("hard_constraint", { type: "location", places: ["Tel Aviv-Yafo"] })];

    expect(applyHardFilters(job({ location: "Herzliya" }), israel).passed).toBe(true);
    expect(applyHardFilters(job({ location: "Ra'anana, Center District" }), israel).passed).toBe(true);
    expect(applyHardFilters(job({ location: "London; Tel Aviv" }), telAviv).passed).toBe(true);
    expect(applyHardFilters(job({ location: "Berlin", workMode: "remote" }), telAviv).passed).toBe(true);
    expect(applyHardFilters(job({ location: "Remote - EMEA" }), telAviv).passed).toBe(true);
    expect(applyHardFilters(job({ location: "Berlin, Germany" }), israel)).toMatchObject({
      passed: false,
      failures: [{ reason: "located in Berlin, Germany" }],
    });
  });

  it("rejects on seniority only when the title states a level", () => {
    const leadership = [pref("hard_constraint", { type: "seniority", levels: ["director", "executive"] })];

    expect(applyHardFilters(job({ title: "Junior HR Coordinator" }), leadership)).toMatchObject({
      passed: false,
      failures: [{ reason: "title suggests junior level" }],
    });
    expect(applyHardFilters(job({ title: "VP People" }), leadership).passed).toBe(true);
    expect(applyHardFilters(job({ title: "People Operations Partner" }), leadership).passed).toBe(true);
  });

  it("does not filter on constraints the job cannot be checked against", () => {
    const prefs = [
      pref("hard_constraint", { type: "compensation", currency: "ILS", min: 40000, period: "month" }),
      pref("hard_constraint", { type: "terms", terms: ["human resources"] }),
      pref("hard_constraint", { type: "free_text", text: "No gambling companies" }),
    ];
    expect(applyHardFilters(job({ title: "Backend Engineer", description: BACKEND_DESCRIPTION }), prefs).passed).toBe(true);
  });

  it("infers seniority from expanded title abbreviations", () => {
    expect(inferSeniority("Sr. Director, People")).toEqual(["senior", "director"]);
    expect(inferSeniority("VP HR")).toEqual(["executive"]);
    expect(inferSeniority("People Partner")).toEqual([]);
  });
});

describe("scoreRelevance", () => {
  it("keeps a career-adjacent role whose title shares nothing with past roles", () => {
    const result = scoreRelevance(job({ title: "Talent & Culture Lead" }), buildRelevanceProfile(hrSnapshot()));

    expect(result.passed).toBe(true);
    expect(result.matchedTerms).toEqual(expect.arrayContaining(["hiring", "onboarding", "performance", "compensation"]));
  });

  it("drops unrelated roles", () => {
    const result = scoreRelevance(
      job({ title: "Backend Engineer", description: BACKEND_DESCRIPTION }),
      buildRelevanceProfile(hrSnapshot()),
    );
    expect(result).toMatchObject({ passed: false, targetRoles: [] });
    expect(result.score).toBeLessThan(0.2);
  });

  it("weighs title hits above description hits", () => {
    const profile = buildRelevanceProfile(hrSnapshot());
    const inTitle = scoreRelevance(job({ title: "HR Business Partner", description: "Join us." }), profile);
    const inDescription = scoreRelevance(job({ title: "Generalist", description: "Be our HR business partner." }), profile);
    expect(inTitle.score).toBeGreaterThan(inDescription.score);
  });

  it("boosts target roles without penalizing other titles", () => {
    const target = pref("target_role", { type: "terms", terms: ["People Operations"] }, { label: "People operations" });
    const withTarget = buildRelevanceProfile(hrSnapshot([target]));
    const without = buildRelevanceProfile(hrSnapshot());

    const hit = scoreRelevance(job({ title: "Head of People Operations" }), withTarget);
    expect(hit.targetRoles).toEqual(["People operations"]);
    expect(hit.score).toBeGreaterThan(scoreRelevance(job({ title: "Head of People Operations" }), without).score);

    const other = job({ title: "Talent & Culture Lead" });
    expect(scoreRelevance(other, withTarget).score).toBeGreaterThanOrEqual(scoreRelevance(other, without).score);
  });

  it("damps but does not eliminate disliked titles, and rewards satisfied nice-to-haves", () => {
    const dislike = pref("dislike", { type: "terms", terms: ["recruiter"] }, { label: "Pure recruiting" });
    const remote = pref("soft_preference", { type: "work_mode", modes: ["remote"] }, { label: "Remote" });
    const profile = buildRelevanceProfile(hrSnapshot([dislike, remote]));
    const base = buildRelevanceProfile(hrSnapshot());

    const recruiter = scoreRelevance(job({ title: "Technical Recruiter" }), profile);
    expect(recruiter.dislikes).toEqual(["Pure recruiting"]);
    expect(recruiter.score).toBeGreaterThan(0);
    expect(recruiter.score).toBeLessThan(scoreRelevance(job({ title: "Technical Recruiter" }), base).score);

    const remoteJob = scoreRelevance(job({ workMode: "remote" }), profile);
    expect(remoteJob.softPreferences).toEqual(["Remote"]);
    expect(remoteJob.score).toBeGreaterThan(scoreRelevance(job({ workMode: "remote" }), base).score);
  });

  it("ignores inactive preferences", () => {
    const proposed = pref("dislike", { type: "terms", terms: ["hr"] }, { status: "proposed" });
    expect(scoreRelevance(job(), buildRelevanceProfile(hrSnapshot([proposed]))).dislikes).toEqual([]);
  });
});

interface Posting {
  id: string;
  title: string;
  company?: string;
  location?: string;
  body?: string;
  mode?: "onsite" | "hybrid" | "remote";
}

function boardAdapter(postings: () => Posting[]): JobSourceAdapter<Posting> {
  return {
    source: { key: "board", name: "Board", kind: "api" },
    *collect() {
      for (const p of postings()) yield { externalId: p.id, sourceUrl: `https://board.example/${p.id}`, payload: p };
    },
    normalize: ({ payload }) => ({
      title: payload.title,
      description: payload.body ?? PEOPLE_OPS_DESCRIPTION,
      company: payload.company ?? "Acme",
      location: payload.location ?? "Tel Aviv",
      workMode: payload.mode ?? null,
    }),
  };
}

describe("runCheapMatching", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let clock: Date;
  const now = () => clock;
  let postings: Posting[];

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    clock = new Date("2026-10-06T10:00:00Z");
    postings = [];
  });

  afterEach(async () => {
    await close();
  });

  const collect = async () => {
    await ingestFromSource(db, boardAdapter(() => postings), { now });
    await deduplicateJobs(db, { now });
  };

  async function createUser(telegramUserId: number, status: "draft" | "confirmed" = "confirmed") {
    const verifiedAt = new Date();
    const [user] = await db.insert(users).values({ telegramUserId, telegramChatId: telegramUserId }).returning();
    await db.insert(careerProfiles).values({ userId: user!.id, status, revision: 3, headline: "HR Business Partner" });
    const [experience] = await db
      .insert(workExperiences)
      .values({
        userId: user!.id,
        employer: "Acme",
        title: "HR Business Partner",
        origin: "cv_upload",
        verificationStatus: "verified",
        verifiedAt,
      })
      .returning();
    await db.insert(careerFacts).values({
      userId: user!.id,
      workExperienceId: experience!.id,
      kind: "responsibility",
      statement: "Led hiring, onboarding, performance reviews and compensation planning",
      origin: "cv_upload",
      verificationStatus: "verified",
      verifiedAt,
    });
    const [hybrid] = await db
      .insert(preferences)
      .values({
        userId: user!.id,
        kind: "hard_constraint",
        dimension: "work_mode",
        label: "Hybrid or remote",
        value: { type: "work_mode", modes: ["hybrid", "remote"] },
        status: "active",
        origin: "user_stated",
        decidedAt: verifiedAt,
      })
      .returning();
    return { userId: user!.id, hybridId: hybrid!.id };
  }

  const matchFor = async (userId: string, externalId: string) => {
    const [row] = await db
      .select({ match: matches })
      .from(matches)
      .innerJoin(jobs, eq(jobs.id, matches.jobId))
      .where(eq(jobs.externalId, externalId));
    return row?.match.userId === userId ? row.match : undefined;
  };

  it("filters on constraints, then relevance, and records each stage", async () => {
    const { userId, hybridId } = await createUser(1);
    postings = [
      { id: "fit", title: "People Operations Lead", mode: "hybrid" },
      { id: "onsite", title: "HR Business Partner", mode: "onsite" },
      { id: "unrelated", title: "Backend Engineer", body: BACKEND_DESCRIPTION },
    ];
    await collect();

    const report = await runCheapMatching(db, { now });

    expect(report).toMatchObject({
      users: 1,
      evaluated: 3,
      filteredByConstraints: 1,
      filteredByRelevance: 1,
      passed: 1,
      errors: [],
    });
    expect(await matchFor(userId, "fit")).toMatchObject({ status: "pending", stageReached: "cheap_relevance" });
    expect((await matchFor(userId, "fit"))!.relevanceScore).toBeGreaterThan(0.2);
    expect(await matchFor(userId, "onsite")).toMatchObject({
      status: "filtered_out",
      stageReached: "hard_filter",
      relevanceScore: null,
    });
    expect(await matchFor(userId, "unrelated")).toMatchObject({ status: "filtered_out", stageReached: "cheap_relevance" });

    const onsite = await matchFor(userId, "onsite");
    const evaluations = await db
      .select()
      .from(matchEvaluations)
      .where(eq(matchEvaluations.matchId, onsite!.id))
      .orderBy(asc(matchEvaluations.createdAt));
    expect(evaluations).toEqual([
      expect.objectContaining({
        stage: "hard_filter",
        outcome: "rejected",
        profileRevision: 3,
        explanation: "Fails must-have “Hybrid or remote”: work mode is onsite",
        evidence: expect.objectContaining({ failedConstraintIds: [hybridId] }),
      }),
    ]);

    const fit = await matchFor(userId, "fit");
    const fitStages = await db.select().from(matchEvaluations).where(eq(matchEvaluations.matchId, fit!.id));
    expect(fitStages.map((e) => [e.stage, e.outcome])).toEqual(
      expect.arrayContaining([
        ["hard_filter", "passed"],
        ["cheap_relevance", "passed"],
      ]),
    );
    const relevance = fitStages.find((e) => e.stage === "cheap_relevance")!;
    expect(relevance.evidence?.matchedTerms).toEqual(expect.arrayContaining(["hiring", "onboarding"]));
  });

  it("only evaluates new canonical jobs for confirmed profiles", async () => {
    await createUser(1);
    await createUser(2, "draft");
    postings = [{ id: "1", title: "HR Business Partner", mode: "hybrid" }];
    await collect();
    expect(await runCheapMatching(db, { now })).toMatchObject({ users: 1, evaluated: 1 });

    expect(await runCheapMatching(db, { now })).toMatchObject({ evaluated: 0 });

    postings.push({ id: "2", title: "HR Business Partner", company: "Acme Inc.", mode: "hybrid" });
    postings.push({ id: "3", title: "People Partner", company: "Initech", mode: "remote" });
    await collect();
    expect(await runCheapMatching(db, { now })).toMatchObject({ evaluated: 1, passed: 1 });
    expect(await db.$count(matches)).toBe(2);
  });

  it("skips jobs collected before the age cutoff", async () => {
    await createUser(1);
    postings = [{ id: "old", title: "HR Business Partner", mode: "hybrid" }];
    await collect();
    clock = new Date("2026-11-20T10:00:00Z");

    expect(await runCheapMatching(db, { now })).toMatchObject({ evaluated: 0 });
    expect(await runCheapMatching(db, { now, maxJobAgeDays: 60 })).toMatchObject({ evaluated: 1 });
  });
});
