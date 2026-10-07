import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiCvTailorer } from "../src/ai/cv-tailorer.js";
import { renderProfile } from "../src/ai/deep-matcher.js";
import { PgCvService, STALE_REQUEST_MS } from "../src/app/postgres/cv.js";
import { createPgServices } from "../src/app/postgres/index.js";
import { createBot } from "../src/bot/bot.js";
import { encodeCallback } from "../src/bot/callbacks.js";
import { messages } from "../src/bot/views.js";
import { groundTailoring, sectionFor, unsupportedClaims, type TailoringDraft, type TailoringJob } from "../src/cv/tailoring.js";
import {
  careerFacts,
  careerProfiles,
  cvVersionItems,
  cvVersions,
  duplicateGroups,
  jobSources,
  jobs,
  matches,
  rawJobRecords,
  sourceDocuments,
  users,
  workExperiences,
} from "../src/db/schema.js";
import type { ProfileSnapshot } from "../src/domain/profile.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { BOT_INFO, TELEGRAM_USER_ID, callbackUpdate, captureApiCalls, type ApiCall } from "./support/telegram.js";

const profile: ProfileSnapshot = {
  profile: { headline: "HR Business Partner", summary: null, currentSeniority: "senior", managementScope: null, openToAdjacentRoles: true, linkedinUrl: null },
  experiences: [
    {
      id: "exp-acme",
      employer: "Acme",
      title: "HR Business Partner",
      industry: "Software",
      location: "Tel Aviv",
      seniority: "senior",
      managedHeadcount: 4,
      startDate: "2021-03-01",
      endDate: null,
      isCurrent: true,
    },
    {
      id: "exp-globex",
      employer: "Globex",
      title: "HR Generalist",
      industry: null,
      location: null,
      seniority: "mid",
      managedHeadcount: null,
      startDate: "2017-01-01",
      endDate: "2021-02-01",
      isCurrent: false,
    },
  ],
  facts: [
    { id: "hiring", kind: "responsibility", statement: "Led hiring and onboarding for 120 engineers", workExperienceId: "exp-acme" },
    { id: "reviews", kind: "achievement", statement: "Redesigned the performance review process", workExperienceId: "exp-acme" },
    { id: "payroll", kind: "responsibility", statement: "Ran monthly payroll", workExperienceId: "exp-globex" },
    { id: "excel", kind: "skill", statement: "Excel", workExperienceId: null },
    { id: "hris", kind: "skill", statement: "HRIS administration", workExperienceId: null },
    { id: "degree", kind: "education", statement: "BA Psychology, Tel Aviv University", workExperienceId: null },
    { id: "hebrew", kind: "language", statement: "Hebrew (native)", workExperienceId: null },
  ],
  preferences: [],
};

const job: TailoringJob = {
  title: "People Operations Lead",
  company: "Initech",
  description: "Own hiring, onboarding and performance reviews for a team of 150.",
};

const { aliases } = renderProfile(profile);
const alias = (factId: string) => [...aliases.facts].find(([, id]) => id === factId)![0];
const expAlias = (experienceId: string) => [...aliases.experiences].find(([, id]) => id === experienceId)![0];

const draft = (overrides: Partial<TailoringDraft> = {}): TailoringDraft => ({
  summary: [{ text: "HR Business Partner who has led hiring and onboarding at scale.", sources: [alias("hiring"), expAlias("exp-acme")] }],
  highlights: [
    { fact: alias("reviews"), text: "Redesigned performance reviews" },
    { fact: alias("hiring"), text: "Led hiring and onboarding for 120 engineers" },
  ],
  skills: [alias("hris"), alias("excel")],
  applicationNote: { text: "I'd love to bring my hiring experience to Initech.", sources: [alias("hiring")] },
  ...overrides,
});

describe("sectionFor", () => {
  it("puts role facts under their role and copies credentials into their own sections", () => {
    const roles = new Set(["exp-acme"]);
    const fact = (kind: ProfileSnapshot["facts"][number]["kind"], workExperienceId: string | null = null) => ({
      id: "x",
      kind,
      statement: "s",
      workExperienceId,
    });
    expect(sectionFor(fact("achievement", "exp-acme"), roles)).toBe("experience");
    expect(sectionFor(fact("responsibility", "gone"), roles)).toBe("other");
    expect(sectionFor(fact("responsibility"), roles)).toBe("other");
    expect(sectionFor(fact("skill"), roles)).toBe("skills");
    expect(sectionFor(fact("education"), roles)).toBe("education");
    expect(sectionFor(fact("certification"), roles)).toBe("certifications");
    expect(sectionFor(fact("language"), roles)).toBe("languages");
  });
});

describe("unsupportedClaims", () => {
  const context = { employers: ["Acme", "Globex"], forbiddenNames: ["Initech"] };

  it("flags numbers, other employers and the target company that the sources do not mention", () => {
    expect(unsupportedClaims("Hired 150 engineers in 6 months", ["Hired 120 engineers"], context)).toEqual(["number 150", "number 6"]);
    expect(unsupportedClaims("Hired 1,200 people", ["Hired 1200 people"], context)).toEqual([]);
    expect(unsupportedClaims("Since 2021 at Acme", ["HR Business Partner Acme 2021-03-01"], context)).toEqual([]);
    expect(unsupportedClaims("Ran payroll at Globex", ["Ran payroll", "HR Business Partner Acme"], context)).toEqual(["name Globex"]);
    expect(unsupportedClaims("Led hiring at Initech", ["Led hiring"], context)).toEqual(["name Initech"]);
    expect(unsupportedClaims("Led onboarding for new hires", ["Led onboarding"], context)).toEqual([]);
  });
});

describe("groundTailoring", () => {
  it("maps aliases to facts, keeps the model's order and copies credentials verbatim", () => {
    const result = groundTailoring(draft(), aliases, profile, job);

    expect(result.violations).toEqual([]);
    expect(result.items).toEqual([
      { careerFactId: "hiring", section: "summary", position: 0, text: "HR Business Partner who has led hiring and onboarding at scale." },
      { careerFactId: "reviews", section: "experience", position: 0, text: "Redesigned performance reviews" },
      { careerFactId: "hiring", section: "experience", position: 1, text: "Led hiring and onboarding for 120 engineers" },
      { careerFactId: "hris", section: "skills", position: 0, text: "HRIS administration" },
      { careerFactId: "excel", section: "skills", position: 1, text: "Excel" },
      { careerFactId: "degree", section: "education", position: 0, text: "BA Psychology, Tel Aviv University" },
      { careerFactId: "hebrew", section: "languages", position: 0, text: "Hebrew (native)" },
    ]);
    expect(result.applicationNote).toBe("I'd love to bring my hiring experience to Initech.");
  });

  it("falls back to the fact's own wording when a bullet claims more than the fact", () => {
    const result = groundTailoring(
      draft({ highlights: [{ fact: alias("hiring"), text: "Led hiring for 150 engineers at Initech" }] }),
      aliases,
      profile,
      job,
    );
    expect(result.items.find((i) => i.section === "experience")).toMatchObject({ careerFactId: "hiring", text: "Led hiring and onboarding for 120 engineers" });
    expect(result.violations).toEqual(["bullet “Led hiring for 150 engineers at Initech”: number 150, name Initech"]);
  });

  it("drops lines that cite nothing real, wrong kinds and unsupported summary sentences or notes", () => {
    const result = groundTailoring(
      draft({
        summary: [
          { text: "Seasoned leader with 10 years of experience.", sources: [alias("hiring")] },
          { text: "Great culture builder.", sources: ["f99"] },
        ],
        highlights: [
          { fact: "f99", text: "Invented bullet" },
          { fact: alias("excel"), text: "Excel wizard" },
          { fact: alias("payroll"), text: "Ran monthly payroll" },
          { fact: alias("payroll"), text: "Ran payroll again" },
        ],
        skills: [alias("payroll"), alias("excel"), alias("excel")],
        applicationNote: { text: "I grew headcount by 40%.", sources: [alias("hiring")] },
      }),
      aliases,
      profile,
      job,
    );

    expect(result.items.filter((i) => i.section === "summary")).toEqual([]);
    expect(result.items.filter((i) => i.section === "experience").map((i) => i.careerFactId)).toEqual(["payroll"]);
    expect(result.items.filter((i) => i.section === "skills").map((i) => i.text)).toEqual(["Excel"]);
    expect(result.applicationNote).toBeNull();
    expect(result.violations).toEqual([
      "summary “Seasoned leader with 10 years of experience.”: number 10",
      "application note: number 40",
    ]);
  });

  it("caps bullets per role", () => {
    const many: ProfileSnapshot = {
      ...profile,
      facts: Array.from({ length: 7 }, (_, i) => ({
        id: `r${i}`,
        kind: "responsibility" as const,
        statement: `Responsibility ${String.fromCharCode(65 + i)}`,
        workExperienceId: "exp-acme",
      })),
    };
    const { aliases: manyAliases } = renderProfile(many);
    const highlights = [...manyAliases.facts.keys()].map((fact) => ({ fact, text: "" }));
    const result = groundTailoring({ ...draft(), summary: [], highlights, applicationNote: { text: "", sources: [] } }, manyAliases, many, job);
    expect(result.items.filter((i) => i.section === "experience")).toHaveLength(5);
  });
});

describe("AiCvTailorer", () => {
  function languageModel(responses: TailoringDraft[]) {
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      modelId: "sonnet-mock",
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return {
          content: [{ type: "text", text: JSON.stringify(responses.shift()) }],
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

  it("returns a clean draft from one call", async () => {
    const llm = languageModel([draft()]);
    const tailorer = new AiCvTailorer(llm.model);
    const result = await tailorer.tailor({ profile, job });

    expect(tailorer).toMatchObject({ model: "sonnet-mock", promptVersion: "cv-tailoring-v1" });
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain("Initech");
    expect(result.violations).toEqual([]);
  });

  it("retries once with the rejected claims and keeps the cleaner attempt", async () => {
    const llm = languageModel([
      draft({ highlights: [{ fact: alias("hiring"), text: "Led hiring for 300 engineers" }] }),
      draft(),
    ]);
    const result = await new AiCvTailorer(llm.model).tailor({ profile, job });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain("number 300");
    expect(result.violations).toEqual([]);
  });
});

describe("CV tailoring flow", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let tailorer: FakeCvTailorer;
  let clock: Date;
  let service: PgCvService;
  let userId: string;
  let matchId: string;
  let factIds: Record<string, string>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    tailorer = new FakeCvTailorer();
    clock = new Date();
    service = new PgCvService(db, tailorer, () => clock);

    const verifiedAt = new Date();
    const [user] = await db.insert(users).values({ telegramUserId: TELEGRAM_USER_ID, telegramChatId: TELEGRAM_USER_ID, preferredLanguage: "en" }).returning();
    userId = user!.id;
    await db.insert(careerProfiles).values({ userId, status: "confirmed", revision: 4, headline: "HR Business Partner" });
    const [experience] = await db
      .insert(workExperiences)
      .values({ userId, employer: "Acme", title: "HR Business Partner", startDate: "2021-03-01", isCurrent: true, origin: "cv_upload", verificationStatus: "verified", verifiedAt })
      .returning();
    const rows = await db
      .insert(careerFacts)
      .values([
        { userId, workExperienceId: experience!.id, kind: "responsibility", statement: "Led hiring for 120 engineers", origin: "cv_upload", verificationStatus: "verified", verifiedAt },
        { userId, kind: "skill", statement: "HRIS administration", origin: "cv_upload", verificationStatus: "verified", verifiedAt },
        { userId, kind: "skill", statement: "Unconfirmed skill", origin: "cv_upload" },
      ])
      .returning();
    factIds = { hiring: rows[0]!.id, hris: rows[1]!.id, unverified: rows[2]!.id };

    const [source] = await db.insert(jobSources).values({ key: "board", name: "Board", kind: "api" }).returning();
    const [raw] = await db.insert(rawJobRecords).values({ sourceId: source!.id, sourceUrl: "https://board.example/1", contentHash: "h", payload: {} }).returning();
    const [group] = await db.insert(duplicateGroups).values({ dedupKey: "k" }).returning();
    const [jobRow] = await db
      .insert(jobs)
      .values({
        sourceId: source!.id,
        rawRecordId: raw!.id,
        sourceUrl: raw!.sourceUrl,
        title: "People Operations Lead",
        company: "Initech",
        description: "Own hiring.",
        collectedAt: new Date(),
        duplicateGroupId: group!.id,
        dedupMethod: "deterministic_key",
      })
      .returning();
    const [match] = await db
      .insert(matches)
      .values({ userId, jobId: jobRow!.id, duplicateGroupId: group!.id, status: "notified", notifiedAt: new Date(), recommendation: "good_fit" })
      .returning();
    matchId = match!.id;
  });

  afterEach(async () => {
    await close();
  });

  const requestId = async () => {
    const outcome = await service.requestTailored(userId, matchId);
    if (outcome.kind !== "requested") throw new Error(`expected a new request, got ${outcome.kind}`);
    return outcome.versionId;
  };

  it("bases a new request on the user's latest readable CV", async () => {
    const document = (fileRef: string, parsed: boolean) => ({
      userId,
      format: "pdf" as const,
      fileRef,
      ...(parsed
        ? { kind: "cv" as const, extractedText: "CV text", parseStatus: "parsed" as const }
        : { parseStatus: "failed" as const, parseError: "no readable text" }),
    });
    const [older] = await db.insert(sourceDocuments).values(document("he", true)).returning();
    const [latest] = await db
      .insert(sourceDocuments)
      .values({ ...document("en", true), createdAt: new Date(older!.createdAt.getTime() + 1000) })
      .returning();
    await db.insert(sourceDocuments).values({ ...document("broken", false), createdAt: new Date(older!.createdAt.getTime() + 2000) });

    const [version] = await db.select().from(cvVersions).where(eq(cvVersions.id, await requestId()));
    expect(version!.sourceDocumentId).toBe(latest!.id);
  });

  it("tailors from verified facts only and saves the version with provenance", async () => {
    const versionId = await requestId();
    const result = await service.tailor(userId, versionId);

    expect(tailorer.calls[0]!.profile.facts.map((f) => f.id)).not.toContain(factIds.unverified);
    expect(tailorer.calls[0]!.job).toEqual({ title: "People Operations Lead", company: "Initech", description: "Own hiring." });
    expect(result).toEqual({
      kind: "draft",
      draft: {
        versionId,
        jobTitle: "People Operations Lead",
        company: "Initech",
        summary: [],
        experiences: [
          { title: "HR Business Partner", employer: "Acme", startDate: "2021-03-01", endDate: null, isCurrent: true, bullets: ["Led hiring for 120 engineers"] },
        ],
        skills: ["HRIS administration"],
        education: [],
        certifications: [],
        languages: [],
        other: [],
        applicationNote: "I'd like to apply for People Operations Lead.",
      },
    });
    const [version] = await db.select().from(cvVersions).where(eq(cvVersions.id, versionId));
    expect(version).toMatchObject({ status: "draft", profileRevision: 4, model: "fake-tailor", promptVersion: "fake-cv-v1" });
    const items = await db.select().from(cvVersionItems).where(eq(cvVersionItems.cvVersionId, versionId));
    expect(items.map((i) => i.careerFactId).sort()).toEqual([factIds.hiring, factIds.hris].sort());

    expect(await service.tailor(userId, versionId)).toEqual({ kind: "not_found" });
  });

  it("refuses to save a version citing an unverified fact", async () => {
    tailorer.result = () => ({
      items: [{ careerFactId: factIds.unverified!, section: "skills", position: 0, text: "Unconfirmed skill" }],
      applicationNote: null,
      violations: [],
    });
    const versionId = await requestId();
    expect(await service.tailor(userId, versionId)).toEqual({ kind: "failed" });
    const [version] = await db.select().from(cvVersions).where(eq(cvVersions.id, versionId));
    expect(version!.status).toBe("failed");
    expect(version!.failureReason).toMatch(/verified career facts/);
  });

  it("renders an approved version once and then reuses the sent Telegram file", async () => {
    await db.update(users).set({ displayName: "Dana" }).where(eq(users.id, userId));
    const versionId = await requestId();
    await service.tailor(userId, versionId);
    expect(await service.document(userId, versionId)).toBeNull();

    await service.decide(userId, versionId, true);
    const rendered = await service.document(userId, versionId);
    expect(rendered).toMatchObject({ kind: "rendered", fileName: "CV - Dana - People Operations Lead.docx" });
    expect(rendered?.kind === "rendered" && rendered.data.byteLength).toBeGreaterThan(1000);

    await service.saveDocumentRef(userId, versionId, "tg-file-1");
    expect(await service.document(userId, versionId)).toEqual({
      kind: "cached",
      fileRef: "tg-file-1",
      fileName: "CV - Dana - People Operations Lead.docx",
    });
    const [other] = await db.insert(users).values({ telegramUserId: 98, telegramChatId: 98 }).returning();
    expect(await service.document(other!.id, versionId)).toBeNull();
  });

  it("reports an open request, resends an open draft and allows a new request after a failure or a stale request", async () => {
    const first = await requestId();
    expect(await service.requestTailored(userId, matchId)).toEqual({ kind: "in_progress" });

    clock = new Date(clock.getTime() + STALE_REQUEST_MS + 60_000);
    const second = await requestId();
    expect(second).not.toBe(first);
    expect((await db.select().from(cvVersions).where(eq(cvVersions.id, first)))[0]!.status).toBe("failed");

    await service.tailor(userId, second);
    expect(await service.requestTailored(userId, matchId)).toEqual({ kind: "draft", versionId: second });
    expect(await service.decide(userId, second, true)).toBe("approved");
    expect(await service.decide(userId, second, false)).toBe("not_found");
    const [version] = await db.select().from(cvVersions).where(eq(cvVersions.id, second));
    expect(version).toMatchObject({ status: "approved", approvedAt: clock });

    const [other] = await db.insert(users).values({ telegramUserId: 99, telegramChatId: 99 }).returning();
    expect(await service.requestTailored(other!.id, matchId)).toEqual({ kind: "not_found" });
  });

  describe("in the bot", () => {
    let bot: ReturnType<typeof createBot>;
    let calls: ApiCall[];

    beforeEach(() => {
      bot = createBot("test-token", createPgServices(db, new FakeProfileAssistant(), tailorer), { botInfo: BOT_INFO });
      calls = captureApiCalls(bot);
    });

    const tap = async (data: string) => {
      calls.length = 0;
      await bot.handleUpdate(callbackUpdate(data));
    };
    const sent = () => calls.filter((c) => c.method === "sendMessage");

    it("sends the draft for review and records the decision", async () => {
      await tap(encodeCallback({ type: "tailor_cv", matchId }));
      const [ack, preview] = sent();
      expect(ack!.payload.text).toBe(messages.cvRequested);
      expect(preview!.payload.text).toContain("Tailored CV for People Operations Lead at Initech");
      expect(preview!.payload.text).toContain("• Led hiring for 120 engineers");
      expect(preview!.payload.text).toContain(messages.cvDraftOutro);
      const approve = preview!.payload.reply_markup.inline_keyboard[0][0].callback_data as string;

      await tap(encodeCallback({ type: "tailor_cv", matchId }));
      expect(sent()[0]!.payload.text).toContain("Tailored CV for People Operations Lead");

      await tap(approve);
      expect(sent().map((c) => c.payload.text)).toEqual([messages.cvApproved]);
      const upload = calls.find((c) => c.method === "sendDocument")!;
      expect(upload.payload.caption).toBe(messages.cvDocumentCaption);
      expect(upload.payload.document.filename).toBe("CV - Dana - People Operations Lead.docx");
      const [version] = await db.select().from(cvVersions);
      expect(version!.status).toBe("approved");
    });

    it("tells the user when tailoring fails", async () => {
      tailorer.result = () => {
        throw new Error("gateway timeout");
      };
      await tap(encodeCallback({ type: "tailor_cv", matchId }));
      expect(sent().map((c) => c.payload.text)).toEqual([messages.cvRequested, messages.cvFailed]);
    });
  });
});
