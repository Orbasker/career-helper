import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgApplicationService } from "../src/app/postgres/applications.js";
import { PgExploreService } from "../src/app/postgres/explore.js";
import { PgFeedbackService } from "../src/app/postgres/feedback.js";
import { createPgServices } from "../src/app/postgres/index.js";
import { PgMatchService } from "../src/app/postgres/matches.js";
import { createBot } from "../src/bot/bot.js";
import {
  careerProfiles,
  duplicateGroups,
  jobSources,
  jobs,
  matchEvaluations,
  matches,
  preferences,
  rawJobRecords,
  users,
} from "../src/db/schema.js";
import type { MatchStage, MatchStatus } from "../src/domain/enums.js";
import type { MatchEvidence } from "../src/domain/types.js";
import { strings } from "../src/i18n/index.js";
import { signInitData, verifyInitData } from "../src/miniapp/auth.js";
import { createMiniAppHandler } from "../src/miniapp/handler.js";
import { INIT_DATA_HEADER, type ExploreData, type ExploreDetails } from "../src/miniapp/types.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { BOT_INFO, TELEGRAM_USER_ID, captureApiCalls, textUpdate } from "./support/telegram.js";

const TOKEN = "123:test-token";
const NOW = new Date("2026-10-11T10:00:00Z");
const authDate = String(Math.floor(NOW.getTime() / 1000));
const launch = (telegramUserId: number, fields: Record<string, string> = {}) =>
  signInitData({ auth_date: authDate, query_id: "q1", user: JSON.stringify({ id: telegramUserId, first_name: "Mom" }), ...fields }, TOKEN);

describe("verifyInitData", () => {
  it("accepts data Telegram signed with the bot token", () => {
    expect(verifyInitData(launch(55), TOKEN, NOW)).toEqual({ telegramUserId: 55 });
  });

  it("rejects tampered, foreign, stale or anonymous launches", () => {
    const tampered = launch(55).replace("%22id%22%3A55", "%22id%22%3A56");
    expect(verifyInitData(tampered, TOKEN, NOW)).toBeNull();
    expect(verifyInitData(launch(55), "999:other-token", NOW)).toBeNull();
    expect(verifyInitData(launch(55), TOKEN, new Date(NOW.getTime() + 2 * 86_400_000))).toBeNull();
    expect(verifyInitData(signInitData({ auth_date: authDate }, TOKEN), TOKEN, NOW)).toBeNull();
    expect(verifyInitData("", TOKEN, NOW)).toBeNull();
  });
});

describe("Mini App API", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let handle: (request: Request) => Promise<Response>;
  let userId: string;
  let sourceId: string;
  let locationId: string;
  let seeded = 0;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    handle = createMiniAppHandler({
      db,
      botToken: TOKEN,
      explore: new PgExploreService(db),
      matches: new PgMatchService(db),
      feedback: new PgFeedbackService(db, () => NOW),
      applications: new PgApplicationService(db, () => NOW),
      now: () => NOW,
    });
    const [user] = await db.insert(users).values({ telegramUserId: 55, telegramChatId: 55, preferredLanguage: "he" }).returning();
    userId = user!.id;
    await db.insert(careerProfiles).values({ userId, status: "confirmed", headline: "HR Director" });
    const [location] = await db
      .insert(preferences)
      .values({
        userId,
        kind: "hard_constraint",
        dimension: "location",
        label: "Rehovot to Caesarea",
        value: { type: "location", places: ["Rehovot", "Caesarea"], between: true },
        status: "active",
        origin: "user_stated",
      })
      .returning();
    locationId = location!.id;
    const [source] = await db.insert(jobSources).values({ key: "drushim", name: "Drushim", kind: "api" }).returning();
    sourceId = source!.id;
  });

  afterEach(async () => {
    await close();
  });

  async function seed(
    title: string,
    match: { status: MatchStatus; stage: MatchStage | null; score?: number; explanation?: string; evidence?: Partial<MatchEvidence> },
    owner = userId,
  ) {
    seeded++;
    const url = `https://drushim.example/${seeded}`;
    const [raw] = await db.insert(rawJobRecords).values({ sourceId, sourceUrl: url, contentHash: `h${seeded}`, payload: {} }).returning();
    const [group] = await db.insert(duplicateGroups).values({ dedupKey: `k${seeded}` }).returning();
    const [job] = await db
      .insert(jobs)
      .values({
        sourceId,
        rawRecordId: raw!.id,
        sourceUrl: url,
        title,
        company: "Acme",
        location: "Tel Aviv",
        description: "Lead HR for 300 people.",
        collectedAt: NOW,
        duplicateGroupId: group!.id,
        dedupMethod: "deterministic_key",
      })
      .returning();
    const [row] = await db
      .insert(matches)
      .values({
        userId: owner,
        jobId: job!.id,
        duplicateGroupId: group!.id,
        status: match.status,
        stageReached: match.stage,
        relevanceScore: match.score ?? null,
        notifiedAt: match.status === "notified" ? NOW : null,
        recommendation: match.stage === "deep_match" ? (match.status === "filtered_out" ? "not_recommended" : "good_fit") : null,
        explanation: match.explanation ?? null,
      })
      .returning();
    if (match.stage) {
      await db.insert(matchEvaluations).values({
        matchId: row!.id,
        stage: match.stage,
        outcome: match.status === "filtered_out" ? "rejected" : "passed",
        profileRevision: 1,
        evidence: { fitEvidence: [], gaps: [], risks: [], transferableSkills: [], ...match.evidence },
      });
    }
    return row!.id;
  }

  const get = (path = "/api/app", initData = launch(55)) =>
    handle(new Request(`https://career.example${path}`, { headers: { [INIT_DATA_HEADER]: initData } }));
  const post = (body: unknown) =>
    handle(
      new Request("https://career.example/api/app", {
        method: "POST",
        headers: { [INIT_DATA_HEADER]: launch(55), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const list = async () => (await (await get()).json()) as ExploreData;

  it("needs a signed launch from a known user", async () => {
    expect((await get("/api/app", "")).status).toBe(401);
    expect((await get("/api/app", launch(56))).status).toBe(401);
  });

  it("lists every job with its tab and the reason it was held back", async () => {
    const approved = await seed("VP HR", { status: "notified", stage: "deep_match", score: 0.9, explanation: "מתאים לך" });
    const recruiting = await seed("Talent Acquisition Lead", {
      status: "filtered_out",
      stage: "deep_match",
      score: 0.7,
      evidence: { risks: ["Matches something to avoid: “No recruiting roles”"] },
    });
    const notFit = await seed("HR Data Lead", { status: "filtered_out", stage: "deep_match", score: 0.8 });
    const unrelated = await seed("Backend Engineer", { status: "filtered_out", stage: "cheap_relevance", score: 0.1 });
    const blocked = await seed("HR Manager Haifa", {
      status: "filtered_out",
      stage: "hard_filter",
      score: 0.6,
      evidence: { failedConstraintIds: [locationId] },
    });
    const waiting = await seed("People Partner", { status: "pending", stage: "cheap_relevance", score: 0.75 });
    await seed("Someone else's job", { status: "notified", stage: "deep_match" }, (await db.insert(users).values({ telegramUserId: 9, telegramChatId: 9 }).returning())[0]!.id);

    const data = await list();
    expect(data.language).toBe("he");
    expect(data.items.map((i) => [i.matchId, i.tab, i.reasons])).toEqual([
      [blocked, "blocked", [{ kind: "must_have", label: "Rehovot to Caesarea" }]],
      [notFit, "close", [{ kind: "not_a_fit" }]],
      [recruiting, "close", [{ kind: "dislike", label: "No recruiting roles" }]],
      [unrelated, "close", [{ kind: "low_relevance" }]],
      [approved, "matches", []],
      [waiting, "waiting", []],
    ]);
    expect(data.items[4]).toMatchObject({ title: "VP HR", explanation: "מתאים לך", sourceName: "Drushim", applied: false, feedback: null });
  });

  it("returns one job's details", async () => {
    const matchId = await seed("VP HR", {
      status: "notified",
      stage: "deep_match",
      evidence: { fitEvidence: [{ claim: "Led HR at Strauss", careerFactIds: [] }], gaps: ["No tech industry"] },
    });
    const details = (await (await get(`/api/app?match=${matchId}`)).json()) as ExploreDetails;
    expect(details).toMatchObject({ matchId, description: "Lead HR for 300 people.", fitEvidence: ["Led HR at Strauss"], gaps: ["No tech industry"] });
    expect((await get("/api/app?match=not-a-uuid")).status).toBe(404);
  });

  it("lists the strongest matches first", async () => {
    const stretch = await seed("HRBP", { status: "notified", stage: "deep_match", score: 1 });
    await db.update(matches).set({ recommendation: "stretch" }).where(eq(matches.id, stretch));
    const strong = await seed("VP HR", { status: "notified", stage: "deep_match", score: 0.5 });
    await db.update(matches).set({ recommendation: "strong_fit" }).where(eq(matches.id, strong));
    const good = await seed("HR Director", { status: "notified", stage: "deep_match", score: 0.9 });

    expect((await list()).items.map((i) => i.matchId)).toEqual([strong, good, stretch]);
  });

  it("brings a held-back job into the matches, hides one and records an application", async () => {
    const blocked = await seed("HR Manager", { status: "filtered_out", stage: "hard_filter", evidence: { failedConstraintIds: [locationId] } });
    const waiting = await seed("People Partner", { status: "pending", stage: "cheap_relevance" });
    const approved = await seed("VP HR", { status: "notified", stage: "deep_match" });

    expect((await post({ matchId: blocked, action: "interested" })).status).toBe(200);
    expect((await post({ matchId: waiting, action: "not_interested" })).status).toBe(200);
    expect((await post({ matchId: approved, action: "applied" })).status).toBe(200);

    const [rescued] = await db.select().from(matches).where(eq(matches.id, blocked));
    expect(rescued).toMatchObject({ status: "notified", notifiedAt: NOW });
    const tabs = Object.fromEntries((await list()).items.map((i) => [i.matchId, [i.tab, i.feedback, i.applied]]));
    expect(tabs).toEqual({
      [blocked]: ["matches", "interested", false],
      [waiting]: ["hidden", "not_interested", false],
      [approved]: ["matches", null, true],
    });
  });

  it("rejects bad actions and other users' matches", async () => {
    const [other] = await db.insert(users).values({ telegramUserId: 9, telegramChatId: 9 }).returning();
    const theirs = await seed("VP HR", { status: "notified", stage: "deep_match" }, other!.id);
    expect((await post({ matchId: theirs, action: "interested" })).status).toBe(404);
    expect((await post({ matchId: theirs, action: "delete" })).status).toBe(400);
    expect((await post({ action: "interested" })).status).toBe(400);
  });
});

describe("browse button", () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });

  afterEach(async () => {
    await close();
  });

  const botWith = (appUrl?: string) => {
    const bot = createBot("test-token", createPgServices(db, new FakeProfileAssistant(), new FakeCvTailorer()), { botInfo: BOT_INFO }, undefined, {
      appUrl,
    });
    return { bot, calls: captureApiCalls(bot) };
  };
  const webAppButtons = (calls: ReturnType<typeof captureApiCalls>) =>
    calls.flatMap((c) => c.payload.reply_markup?.inline_keyboard?.flat() ?? []).filter((b: { web_app?: unknown }) => b.web_app);

  it("offers the full list with what's new and on /browse", async () => {
    const { bot, calls } = botWith("https://career.example/app/");
    await bot.handleUpdate(textUpdate("/new"));
    expect(calls.map((c) => c.payload.text)).toContain(strings("en").messages.browse);
    expect(webAppButtons(calls)).toEqual([{ text: strings("en").buttons.browse, web_app: { url: "https://career.example/app/" } }]);

    calls.length = 0;
    await bot.handleUpdate(textUpdate("/browse"));
    expect(webAppButtons(calls)).toHaveLength(1);
    expect(await db.select().from(users).where(eq(users.telegramUserId, TELEGRAM_USER_ID))).toHaveLength(1);
  });

  it("says the list is unavailable when there is no app url", async () => {
    const { bot, calls } = botWith();
    await bot.handleUpdate(textUpdate("/browse"));
    expect(calls.find((c) => c.method === "sendMessage")!.payload.text).toBe(strings("en").messages.browseUnavailable);
    expect(webAppButtons(calls)).toEqual([]);
  });
});
