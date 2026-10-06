import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgServices } from "../src/app/postgres/index.js";
import { PgFeedbackService, REASON_TEXT_TTL_MS } from "../src/app/postgres/feedback.js";
import { loadSnapshot } from "../src/app/postgres/profile.js";
import { createBot } from "../src/bot/bot.js";
import { encodeCallback } from "../src/bot/callbacks.js";
import { messages } from "../src/bot/views.js";
import {
  careerProfiles,
  duplicateGroups,
  feedback,
  jobSources,
  jobs,
  matches,
  preferenceEvidence,
  preferences,
  rawJobRecords,
  users,
  workExperiences,
} from "../src/db/schema.js";
import type { WorkMode } from "../src/domain/enums.js";
import type { PreferenceSnapshot } from "../src/domain/profile.js";
import { inferPreferences, type FeedbackSignal } from "../src/learning/infer.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { BOT_INFO, TELEGRAM_USER_ID, callbackUpdate, captureApiCalls, textUpdate, type ApiCall } from "./support/telegram.js";

let signalCount = 0;
function signal(title: string, overrides: Partial<FeedbackSignal> = {}): FeedbackSignal {
  signalCount++;
  return {
    feedbackId: `fb${signalCount}`,
    groupId: `g${signalCount}`,
    verdict: "not_interested",
    reasonTags: [],
    title,
    company: "Acme",
    workMode: null,
    ...overrides,
  };
}

const workModePreference = (modes: WorkMode[], overrides: Partial<PreferenceSnapshot> = {}): PreferenceSnapshot => ({
  id: "wm",
  kind: "hard_constraint",
  dimension: "work_mode",
  label: "Work mode",
  value: { type: "work_mode", modes },
  status: "active",
  ...overrides,
});

const infer = (signals: FeedbackSignal[], preferences: PreferenceSnapshot[] = [], ownTitles = ["HR Business Partner"]) =>
  inferPreferences({ signals, ownTitles, preferences });

describe("inferPreferences", () => {
  it("proposes avoiding a title word after three passes, citing the feedback", () => {
    const signals = [signal("Technical Recruiter"), signal("Senior Recruiter"), signal("Recruiter, EMEA")];
    expect(infer(signals)).toEqual([
      {
        preference: { kind: "dislike", dimension: "role", label: "Recruiter roles", value: { type: "terms", terms: ["recruiter"] } },
        rationale: "You passed on 3 jobs with “recruiter” in the title.",
        supersedesId: null,
        feedbackIds: signals.map((s) => s.feedbackId),
      },
    ]);
    expect(infer(signals.slice(0, 2))).toEqual([]);
  });

  it("proposes one preference when several title words cover the same jobs", () => {
    const proposals = infer([signal("Technical Recruiter"), signal("Technical Recruiter II"), signal("Technical Recruiter, Israel")]);
    expect(proposals.map((p) => p.preference.label)).toEqual(["Recruiter roles"]);
  });

  it("never proposes avoiding the user's own roles, target roles or roles they liked", () => {
    const passes = [signal("HR Partner, Sales"), signal("Sales HR Partner"), signal("HR Partner - Sales org")];
    expect(infer(passes, [], ["HR Business Partner", "Sales Operations"])).toEqual([]);

    const target: PreferenceSnapshot = {
      id: "t",
      kind: "target_role",
      dimension: "role",
      label: "Payroll",
      value: { type: "terms", terms: ["payroll"] },
      status: "active",
    };
    expect(infer([signal("Payroll Lead"), signal("Payroll Specialist"), signal("Payroll Analyst")], [target])).toEqual([]);
    const withLike = [signal("Recruiter"), signal("Recruiter II"), signal("Lead Recruiter"), signal("Recruiter", { verdict: "interested" })];
    expect(infer(withLike)).toEqual([]);
  });

  it("only counts passes that were about the role", () => {
    const tagged = ["location", "pay", "role"].map((tag) => signal("Recruiter", { reasonTags: [tag] }));
    expect(infer(tagged)).toEqual([]);
    expect(infer([...tagged, signal("Recruiter")])).toEqual([]);
    expect(infer([...tagged, signal("Recruiter"), signal("Recruiter")])).toHaveLength(1);
  });

  it("does not propose again what the user already has, rejected or retired", () => {
    const signals = [signal("Recruiter"), signal("Recruiter II"), signal("Lead Recruiter")];
    const rejected: PreferenceSnapshot = {
      id: "r",
      kind: "dislike",
      dimension: "role",
      label: "Recruiter roles",
      value: { type: "terms", terms: ["Recruiter"] },
      status: "rejected",
    };
    expect(infer(signals, [rejected])).toEqual([]);
  });

  it("proposes avoiding a company passed on twice because of the company", () => {
    const signals = [
      signal("HR Manager", { company: "Globex Ltd", reasonTags: ["company"] }),
      signal("People Partner", { company: "Globex", reasonTags: ["company"] }),
      signal("HR Lead", { company: "Initech", reasonTags: ["company"] }),
    ];
    expect(infer(signals)).toEqual([
      {
        preference: { kind: "dislike", dimension: "company", label: "Jobs at Globex Ltd", value: { type: "terms", terms: ["Globex Ltd"] } },
        rationale: "You passed on 2 jobs at Globex Ltd because of the company.",
        supersedesId: null,
        feedbackIds: [signals[0]!.feedbackId, signals[1]!.feedbackId],
      },
    ]);
    expect(infer([...signals, signal("HR Partner", { company: "globex", verdict: "interested" })])).toEqual([]);
  });

  it("proposes narrowing the work mode, replacing an existing must-have", () => {
    const onsite = [1, 2, 3].map(() => signal("HR Partner", { workMode: "onsite", reasonTags: ["work_mode"] }));
    expect(infer(onsite)).toEqual([
      {
        preference: {
          kind: "hard_constraint",
          dimension: "work_mode",
          label: "Hybrid or Remote only",
          value: { type: "work_mode", modes: ["hybrid", "remote"] },
        },
        rationale: "You passed on 3 onsite jobs because of the work setup.",
        supersedesId: null,
        feedbackIds: onsite.map((s) => s.feedbackId),
      },
    ]);

    const current = workModePreference(["onsite", "hybrid"]);
    expect(infer(onsite, [current])[0]).toMatchObject({
      preference: { label: "Hybrid only", value: { modes: ["hybrid"] } },
      supersedesId: "wm",
    });
    expect(infer(onsite, [workModePreference(["hybrid", "remote"])])).toEqual([]);
    expect(infer(onsite, [workModePreference(["onsite"])])).toEqual([]);
  });

  it("does not narrow the work mode when the user liked jobs with it", () => {
    const onsite = [1, 2, 3].map(() => signal("HR Partner", { workMode: "onsite", reasonTags: ["work_mode"] }));
    expect(infer([...onsite, signal("HR Partner", { workMode: "onsite", verdict: "interested" })])).toEqual([]);
  });
});

describe("feedback loop", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let service: PgFeedbackService;
  let clock: Date;
  let userId: string;
  let sourceId: string;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    clock = new Date("2026-10-06T10:00:00Z");
    service = new PgFeedbackService(db, () => clock);
    const [user] = await db.insert(users).values({ telegramUserId: TELEGRAM_USER_ID, telegramChatId: TELEGRAM_USER_ID }).returning();
    userId = user!.id;
    await db.insert(careerProfiles).values({ userId, status: "confirmed", headline: "HR Business Partner" });
    await db.insert(workExperiences).values({
      userId,
      employer: "Acme",
      title: "HR Business Partner",
      origin: "cv_upload",
      verificationStatus: "verified",
      verifiedAt: new Date(),
    });
    const [source] = await db.insert(jobSources).values({ key: "board", name: "Board", kind: "api" }).returning();
    sourceId = source!.id;
  });

  afterEach(async () => {
    await close();
  });

  let jobCount = 0;
  async function seedMatch(title: string, job: { company?: string; workMode?: WorkMode } = {}) {
    jobCount++;
    const [raw] = await db
      .insert(rawJobRecords)
      .values({ sourceId, sourceUrl: `https://board.example/${jobCount}`, contentHash: `h${jobCount}`, payload: {} })
      .returning();
    const [group] = await db.insert(duplicateGroups).values({ dedupKey: `k${jobCount}` }).returning();
    const [row] = await db
      .insert(jobs)
      .values({
        sourceId,
        rawRecordId: raw!.id,
        sourceUrl: raw!.sourceUrl,
        title,
        company: job.company ?? "Acme",
        workMode: job.workMode ?? null,
        description: "Job description.",
        collectedAt: new Date(),
        duplicateGroupId: group!.id,
        dedupMethod: "deterministic_key",
      })
      .returning();
    const [match] = await db
      .insert(matches)
      .values({ userId, jobId: row!.id, duplicateGroupId: group!.id, status: "notified", notifiedAt: new Date(), recommendation: "good_fit" })
      .returning();
    return match!.id;
  }

  const pass = async (title: string, job: Parameters<typeof seedMatch>[1] = {}) =>
    (await service.record(userId, await seedMatch(title, job), "not_interested"))!.feedbackId;

  it("records feedback once per verdict and restores a match when the user changes their mind", async () => {
    const matchId = await seedMatch("Recruiter");
    const first = await service.record(userId, matchId, "not_interested");
    expect(await service.record(userId, matchId, "not_interested")).toEqual(first);
    expect(await db.select().from(feedback)).toHaveLength(1);
    expect((await db.select().from(matches).where(eq(matches.id, matchId)))[0]!.status).toBe("dismissed");

    await service.record(userId, matchId, "interested");
    expect((await db.select().from(matches).where(eq(matches.id, matchId)))[0]!.status).toBe("notified");
    expect(await service.record("00000000-0000-4000-8000-000000000000", matchId, "interested")).toBeNull();
  });

  it("stores reason tags and an optional free-text reason", async () => {
    const feedbackId = await pass("Recruiter");
    expect(await service.addReasonTag(userId, feedbackId, "role")).toBe(true);
    expect(await service.addReasonTag(userId, feedbackId, "role")).toBe(true);
    expect(await service.addReasonTag(userId, feedbackId, "pay")).toBe(true);

    expect(await service.takeReasonText(userId, "Too much travel")).toBe(false);
    expect(await service.awaitReasonText(userId, feedbackId)).toBe(true);
    expect(await service.takeReasonText(userId, "  Too much travel ")).toBe(true);
    expect(await service.takeReasonText(userId, "add that I speak French")).toBe(false);

    const [row] = await db.select().from(feedback).where(eq(feedback.id, feedbackId));
    expect(row!.reasonTags.sort()).toEqual(["pay", "role"]);
    expect(row!.reason).toBe("Too much travel");
  });

  it("stops waiting for a free-text reason after a while", async () => {
    const feedbackId = await pass("Recruiter");
    await service.awaitReasonText(userId, feedbackId);
    clock = new Date(clock.getTime() + REASON_TEXT_TTL_MS + 1);
    expect(await service.takeReasonText(userId, "late answer")).toBe(false);
  });

  it("proposes a preference once, keeps it out of matching until accepted, then activates it", async () => {
    await pass("Technical Recruiter");
    await pass("Recruiter II");
    expect(await service.learn(userId)).toEqual([]);
    await pass("Lead Recruiter");

    const [proposal] = await service.learn(userId);
    expect(proposal).toMatchObject({ kind: "dislike", label: "Recruiter roles" });
    expect(await service.learn(userId)).toEqual([]);
    expect(await db.select().from(preferenceEvidence).where(eq(preferenceEvidence.preferenceId, proposal!.preferenceId))).toHaveLength(3);
    expect((await loadSnapshot(db, userId)).preferences).toEqual([]);

    expect(await service.decideProposal(userId, proposal!.preferenceId, true)).toBe("accepted");
    expect(await service.decideProposal(userId, proposal!.preferenceId, true)).toBe("not_found");
    const [preference] = (await loadSnapshot(db, userId)).preferences;
    expect(preference).toMatchObject({ kind: "dislike", status: "active", value: { terms: ["recruiter"] } });
    const [profile] = await db.select().from(careerProfiles).where(eq(careerProfiles.userId, userId));
    expect(profile!.revision).toBe(2);
  });

  it("never proposes a rejected preference again", async () => {
    for (const title of ["Recruiter", "Recruiter II", "Lead Recruiter"]) await pass(title);
    const [proposal] = await service.learn(userId);
    expect(await service.decideProposal(userId, proposal!.preferenceId, false)).toBe("rejected");

    await pass("Senior Recruiter");
    expect(await service.learn(userId)).toEqual([]);
    expect((await loadSnapshot(db, userId)).preferences).toEqual([]);
  });

  it("replaces the work-mode must-have it narrows", async () => {
    const [current] = await db
      .insert(preferences)
      .values({
        userId,
        kind: "hard_constraint",
        dimension: "work_mode",
        label: "Any setup",
        value: { type: "work_mode", modes: ["onsite", "hybrid", "remote"] },
        status: "active",
        origin: "onboarding",
        decidedAt: new Date(),
      })
      .returning();
    for (const title of ["HR Partner", "People Partner", "HR Lead"]) {
      await service.addReasonTag(userId, await pass(title, { workMode: "onsite" }), "work_mode");
    }

    const [proposal] = await service.learn(userId);
    await service.decideProposal(userId, proposal!.preferenceId, true);

    const rows = await db.select().from(preferences).where(eq(preferences.userId, userId));
    expect(rows.find((r) => r.id === current!.id)!.status).toBe("superseded");
    expect(rows.find((r) => r.id === proposal!.preferenceId)).toMatchObject({
      status: "active",
      supersedesId: current!.id,
      value: { modes: ["hybrid", "remote"] },
    });
  });

  it("only lets the owner decide a proposal", async () => {
    for (const title of ["Recruiter", "Recruiter II", "Lead Recruiter"]) await pass(title);
    const [proposal] = await service.learn(userId);
    const [other] = await db.insert(users).values({ telegramUserId: 9, telegramChatId: 9 }).returning();
    expect(await service.decideProposal(other!.id, proposal!.preferenceId, true)).toBe("not_found");
    const [row] = await db.select().from(preferences).where(and(eq(preferences.id, proposal!.preferenceId)));
    expect(row!.status).toBe("proposed");
  });

  describe("in the bot", () => {
    let bot: ReturnType<typeof createBot>;
    let calls: ApiCall[];

    beforeEach(() => {
      bot = createBot("test-token", createPgServices(db, new FakeProfileAssistant()), { botInfo: BOT_INFO });
      calls = captureApiCalls(bot);
    });

    const send = async (update: ReturnType<typeof textUpdate>) => {
      calls.length = 0;
      await bot.handleUpdate(update);
    };
    const sent = () => calls.filter((c) => c.method === "sendMessage");
    const buttons = (call: ApiCall) => call.payload.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[];

    it("asks why after a pass, learns from it and applies an accepted proposal", async () => {
      for (const title of ["Recruiter", "Recruiter II"]) await pass(title);
      const matchId = await seedMatch("Lead Recruiter");

      await send(callbackUpdate(encodeCallback({ type: "feedback", matchId, verdict: "not_interested" })));
      const [prompt, proposal] = sent();
      expect(prompt!.payload.text).toBe(messages.feedbackReasonPrompt);
      const [feedbackRow] = await db.select().from(feedback).where(eq(feedback.matchId, matchId));
      expect(buttons(prompt!).map((b) => b.callback_data)).toContain(
        encodeCallback({ type: "feedback_reason", feedbackId: feedbackRow!.id, tag: "role" }),
      );
      expect(proposal!.payload.text).toContain("You passed on 3 jobs with “recruiter” in the title.");
      expect(proposal!.payload.text).toContain("Should I skip <b>Recruiter roles</b> from now on?");

      await send(callbackUpdate(buttons(proposal!)[0]!.callback_data));
      expect(sent().map((c) => c.payload.text)).toEqual([messages.proposalAccepted]);
      expect((await loadSnapshot(db, userId)).preferences).toMatchObject([{ label: "Recruiter roles", status: "active" }]);
    });

    it("records a tapped reason and a typed one", async () => {
      const feedbackId = await pass("HR Manager");

      await send(callbackUpdate(encodeCallback({ type: "feedback_reason", feedbackId, tag: "location" })));
      expect(calls.find((c) => c.method === "answerCallbackQuery")!.payload.text).toBe(messages.feedbackReasonNoted);

      await send(callbackUpdate(encodeCallback({ type: "feedback_reason_text", feedbackId })));
      expect(sent().map((c) => c.payload.text)).toEqual([messages.feedbackReasonTextPrompt]);
      await send(textUpdate("Two hours commute each way"));
      expect(sent().map((c) => c.payload.text)).toEqual([messages.feedbackReasonTextSaved]);

      const [row] = await db.select().from(feedback).where(eq(feedback.id, feedbackId));
      expect(row).toMatchObject({ reasonTags: ["location"], reason: "Two hours commute each way" });
    });
  });
});
