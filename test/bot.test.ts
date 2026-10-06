import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgServices } from "../src/app/postgres/index.js";
import { createBot } from "../src/bot/bot.js";
import { encodeCallback } from "../src/bot/callbacks.js";
import { WHATS_NEW_LABEL, messages } from "../src/bot/views.js";
import {
  careerProfiles,
  cvVersions,
  duplicateGroups,
  feedback,
  jobSources,
  jobs,
  matchEvaluations,
  matches,
  masterCvs,
  preferences,
  rawJobRecords,
  users,
} from "../src/db/schema.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { BOT_INFO, TELEGRAM_USER_ID, callbackUpdate, captureApiCalls, textUpdate, type ApiCall } from "./support/telegram.js";

let db: TestDb;
let close: () => Promise<void>;
let bot: ReturnType<typeof createBot>;
let calls: ApiCall[];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  bot = createBot("test-token", createPgServices(db), { botInfo: BOT_INFO });
  calls = captureApiCalls(bot);
});

afterEach(async () => {
  await close();
});

const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);

async function send(update: ReturnType<typeof textUpdate>) {
  calls.length = 0;
  await bot.handleUpdate(update);
}

async function currentUserId() {
  const [user] = await db.select().from(users).where(eq(users.telegramUserId, TELEGRAM_USER_ID));
  return user!.id;
}

async function seedMatch(userId: string, title = "People Operations Manager") {
  const [source] = await db
    .insert(jobSources)
    .values({ key: `src-${title}`, name: "Source", kind: "api" })
    .returning();
  const [raw] = await db
    .insert(rawJobRecords)
    .values({ sourceId: source!.id, sourceUrl: `https://jobs.example/${title}`, contentHash: title, payload: {} })
    .returning();
  const [group] = await db.insert(duplicateGroups).values({ dedupKey: title }).returning();
  const [job] = await db
    .insert(jobs)
    .values({
      sourceId: source!.id,
      rawRecordId: raw!.id,
      sourceUrl: raw!.sourceUrl,
      title,
      company: "Acme <Ltd>",
      location: "Tel Aviv",
      description: "Lead people operations.",
      collectedAt: new Date(),
      duplicateGroupId: group!.id,
      dedupMethod: "deterministic_key",
    })
    .returning();
  const [match] = await db
    .insert(matches)
    .values({
      userId,
      jobId: job!.id,
      duplicateGroupId: group!.id,
      status: "ready",
      recommendation: "good_fit",
      explanation: "Your HR leadership transfers well.",
    })
    .returning();
  await db.insert(matchEvaluations).values({
    matchId: match!.id,
    stage: "deep_match",
    outcome: "passed",
    profileRevision: 1,
    evidence: {
      fitEvidence: [{ claim: "Managed a 6-person HR team", careerFactIds: [] }],
      gaps: ["No payroll systems"],
      risks: [],
      transferableSkills: ["Stakeholder management"],
    },
  });
  return match!.id;
}

describe("telegram bot", () => {
  it("runs onboarding from /start and stores the answers", async () => {
    await send(textUpdate("/start"));
    expect(sent()).toEqual([messages.welcomeNew, expect.stringContaining("CV")]);

    await send(textUpdate("HR manager at Acme, 2018-2024"));
    expect(sent()[0]).toContain("roles");
    await send(textUpdate("HR business partner, operations manager"));
    expect(sent()[0]).toContain("constraints");
    await send(textUpdate("Remote or Tel Aviv only"));
    expect(sent()).toEqual([messages.onboardingDone]);

    const userId = await currentUserId();
    const [cv] = await db.select().from(masterCvs).where(eq(masterCvs.userId, userId));
    expect(cv!.originalText).toBe("HR manager at Acme, 2018-2024");
    const prefs = await db.select().from(preferences).where(eq(preferences.userId, userId));
    expect(prefs.map((p) => [p.kind, p.status, p.label])).toEqual([
      ["target_role", "proposed", "HR business partner, operations manager"],
      ["hard_constraint", "proposed", "Remote or Tel Aviv only"],
    ]);
    expect(await db.select().from(careerProfiles)).toHaveLength(1);

    await send(textUpdate("/start"));
    expect(sent()).toEqual([messages.welcomeBack]);
  });

  it("lists latest matches and opens details with evidence", async () => {
    await send(textUpdate("/help"));
    const matchId = await seedMatch(await currentUserId());

    await send(textUpdate(WHATS_NEW_LABEL));
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("Acme &lt;Ltd&gt;");
    const listMsg = calls[0]!.payload;
    expect(listMsg.reply_markup.inline_keyboard[0][0].callback_data).toBe(
      encodeCallback({ type: "job_details", matchId }),
    );

    await send(callbackUpdate(encodeCallback({ type: "job_details", matchId })));
    const details = sent()[0]!;
    expect(details).toContain("Managed a 6-person HR team");
    expect(details).toContain("Stakeholder management");
    expect(details).toContain("No payroll systems");
    expect(calls.some((c) => c.method === "answerCallbackQuery")).toBe(true);
  });

  it("says when there are no matches", async () => {
    await send(textUpdate("/new"));
    expect(sent()).toEqual([messages.noMatches]);
  });

  it("records feedback and hides dismissed matches", async () => {
    await send(textUpdate("/help"));
    const userId = await currentUserId();
    const matchId = await seedMatch(userId);

    await send(callbackUpdate(encodeCallback({ type: "feedback", matchId, verdict: "not_interested" })));
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.payload.text).toBe(messages.feedbackNotInterested);
    expect(calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(true);

    const [row] = await db.select().from(feedback).orderBy(desc(feedback.createdAt));
    expect(row!.verdict).toBe("not_interested");
    await send(textUpdate("/new"));
    expect(sent()).toEqual([messages.noMatches]);
  });

  it("ignores feedback on another user's match", async () => {
    const [other] = await db.insert(users).values({ telegramUserId: 7, telegramChatId: 7 }).returning();
    const matchId = await seedMatch(other!.id);

    await send(callbackUpdate(encodeCallback({ type: "feedback", matchId, verdict: "interested" })));
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.payload.text).toBe(messages.matchNotFound);
    expect(await db.select().from(feedback)).toHaveLength(0);
  });

  it("requests a tailored CV once per match", async () => {
    await send(textUpdate("/help"));
    const matchId = await seedMatch(await currentUserId());

    await send(callbackUpdate(encodeCallback({ type: "tailor_cv", matchId })));
    expect(sent()).toEqual([messages.cvRequested]);
    await send(callbackUpdate(encodeCallback({ type: "tailor_cv", matchId })));
    expect(sent()).toEqual([messages.cvAlreadyRequested]);
    expect(await db.select().from(cvVersions)).toHaveLength(1);
  });

  it("stores free text outside onboarding as a proposed preference", async () => {
    await send(textUpdate("No more than 40 minutes commute"));
    expect(sent()).toEqual([messages.preferenceNoted]);
    const [pref] = await db.select().from(preferences);
    expect(pref).toMatchObject({ origin: "user_stated", status: "proposed", label: "No more than 40 minutes commute" });
  });

  it("ignores group chats", async () => {
    const update = textUpdate("/start");
    update.message!.chat = { id: -5, type: "group", title: "g" };
    await send(update);
    expect(calls).toHaveLength(0);
    expect(await db.select().from(users)).toHaveLength(0);
  });
});
