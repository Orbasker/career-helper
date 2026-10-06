import { Api } from "grammy";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgMatchService } from "../src/app/postgres/matches.js";
import type { MatchSummary } from "../src/app/services.js";
import { TelegramNotifier } from "../src/bot/notifier.js";
import { createCronHandler } from "../src/cron.js";
import { careerFacts, careerProfiles, jobs, matches, users, workExperiences } from "../src/db/schema.js";
import type { MatchRecommendation } from "../src/domain/enums.js";
import type { JobSourceAdapter } from "../src/ingestion/adapter.js";
import type { DeepMatcher, DeepMatchJob, DeepMatchVerdict } from "../src/matching/deep-match.js";
import { runDailyPipeline } from "../src/pipeline/daily.js";
import {
  RecipientUnavailableError,
  parseNotificationThreshold,
  qualifyingConfidences,
  qualifyingRecommendations,
  runNotifications,
  type Notifier,
} from "../src/pipeline/notify.js";
import { createTestDb, type TestDb } from "./support/db.js";

const DESCRIPTION =
  "Own hiring, onboarding and performance reviews for a team of 150, design compensation planning and partner with leadership on culture.";

interface Posting {
  id: string;
  title: string;
}

function boardAdapter(postings: () => Posting[]): JobSourceAdapter<Posting> {
  return {
    source: { key: "board", name: "Board", kind: "api" },
    *collect() {
      for (const p of postings()) yield { externalId: p.id, sourceUrl: `https://board.example/${p.id}`, payload: p };
    },
    normalize: ({ payload }) => ({ title: payload.title, description: DESCRIPTION, company: "Acme", location: "Tel Aviv" }),
  };
}

const failingAdapter: JobSourceAdapter<Posting> = {
  source: { key: "broken", name: "Broken", kind: "api" },
  *collect() {
    throw new Error("board offline");
  },
  normalize: () => null,
};

class TitleMatcher implements DeepMatcher {
  readonly model = "fake-model";
  readonly promptVersion = "fake-v1";
  constructor(private readonly verdicts: Record<string, MatchRecommendation>) {}

  async evaluate({ job }: { job: DeepMatchJob }): Promise<DeepMatchVerdict> {
    const recommendation = this.verdicts[job.title] ?? "not_recommended";
    return {
      recommendation,
      confidence: "medium",
      explanation: `${job.title} fits`,
      evidence: { fitEvidence: [], gaps: [], risks: [], transferableSkills: [] },
    };
  }
}

class FakeNotifier implements Notifier {
  digests: { chatId: number; titles: string[]; remaining: number }[] = [];
  fail: Error | null = null;

  async sendDigest(chatId: number, matches: MatchSummary[], remaining: number) {
    if (this.fail) throw this.fail;
    this.digests.push({ chatId, titles: matches.map((m) => m.title), remaining });
  }
}

const VERDICTS: Record<string, MatchRecommendation> = {
  "People Operations Lead": "strong_fit",
  "HR Business Partner": "good_fit",
  "Talent and Culture Manager": "stretch",
};

const POSTINGS: Posting[] = [
  { id: "ops", title: "People Operations Lead" },
  { id: "hrbp", title: "HR Business Partner" },
  { id: "culture", title: "Talent and Culture Manager" },
  { id: "coord", title: "HR Coordinator" },
];

describe("runDailyPipeline", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let notifier: FakeNotifier;
  const now = () => new Date("2026-10-06T05:00:00Z");
  const log = () => undefined;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    notifier = new FakeNotifier();
  });

  afterEach(async () => {
    await close();
  });

  async function createUser(telegramUserId = 1) {
    const verifiedAt = new Date();
    const [user] = await db.insert(users).values({ telegramUserId, telegramChatId: telegramUserId * 10 }).returning();
    const userId = user!.id;
    await db.insert(careerProfiles).values({ userId, status: "confirmed", headline: "HR Business Partner" });
    const [experience] = await db
      .insert(workExperiences)
      .values({ userId, employer: "Acme", title: "HR Business Partner", origin: "cv_upload", verificationStatus: "verified", verifiedAt })
      .returning();
    await db.insert(careerFacts).values({
      userId,
      workExperienceId: experience!.id,
      kind: "responsibility",
      statement: "Led hiring, onboarding, performance reviews and compensation planning",
      origin: "cv_upload",
      verificationStatus: "verified",
      verifiedAt,
    });
    return userId;
  }

  const run = (adapters: JobSourceAdapter<any>[], options: Parameters<typeof runDailyPipeline>[2] = {}) =>
    runDailyPipeline(db, { adapters, matcher: new TitleMatcher(VERDICTS), notifier }, { now, log, ...options });

  const statusOf = async (externalId: string) => {
    const [row] = await db
      .select({ status: matches.status, notifiedAt: matches.notifiedAt })
      .from(matches)
      .innerJoin(jobs, eq(jobs.id, matches.jobId))
      .where(eq(jobs.externalId, externalId));
    return row;
  };

  it("runs every stage, notifies matches above the threshold once and never repeats them", async () => {
    await createUser();
    const adapter = boardAdapter(() => POSTINGS);

    const report = await run([adapter]);

    expect(report.failed).toBe(false);
    expect(report.ingestion).toMatchObject({ ok: true, report: { sources: [{ source: "board", inserted: 4 }] } });
    expect(report.cheapMatching).toMatchObject({ ok: true, report: { evaluated: 4 } });
    expect(report.deepMatching).toMatchObject({ ok: true, report: { recommended: 3 } });
    expect(report.notifications).toMatchObject({ ok: true, report: { digestsSent: 1, matchesNotified: 2 } });
    expect(notifier.digests).toEqual([
      { chatId: 10, titles: ["People Operations Lead", "HR Business Partner"], remaining: 0 },
    ]);
    expect(await statusOf("ops")).toEqual({ status: "notified", notifiedAt: now() });
    expect(await statusOf("culture")).toMatchObject({ status: "ready", notifiedAt: null });

    const again = await run([adapter]);
    expect(again.failed).toBe(false);
    expect(again.notifications).toMatchObject({ ok: true, report: { digestsSent: 0 } });
    expect(notifier.digests).toHaveLength(1);
  });

  it("applies a stricter threshold and caps the digest size", async () => {
    await createUser();
    await run([boardAdapter(() => POSTINGS)], {
      threshold: { minRecommendation: "stretch", minConfidence: "low" },
      digestSize: 2,
    });
    expect(notifier.digests).toEqual([
      { chatId: 10, titles: ["People Operations Lead", "HR Business Partner"], remaining: 1 },
    ]);

    notifier.digests = [];
    await runNotifications(db, notifier, { now, threshold: { minRecommendation: "strong_fit", minConfidence: "low" } });
    expect(notifier.digests).toEqual([]);
    await runNotifications(db, notifier, { now, threshold: { minRecommendation: "stretch", minConfidence: "high" } });
    expect(notifier.digests).toEqual([]);
  });

  it("keeps going when a source fails and reports the run as failed", async () => {
    await createUser();
    const report = await run([failingAdapter, boardAdapter(() => POSTINGS)]);

    expect(report.failed).toBe(true);
    expect(report.ingestion).toMatchObject({ ok: true, report: { failed: true } });
    expect(report.notifications).toMatchObject({ ok: true, report: { matchesNotified: 2 } });
  });

  it("isolates a crashing stage and still runs the later ones", async () => {
    await createUser();
    await run([boardAdapter(() => POSTINGS)], { threshold: { minRecommendation: "strong_fit", minConfidence: "low" } });
    notifier.digests = [];

    const report = await run(null as unknown as JobSourceAdapter<any>[]);

    expect(report.ingestion).toMatchObject({ ok: false });
    expect(report.failed).toBe(true);
    expect(report.notifications).toMatchObject({ ok: true, report: { matchesNotified: 1 } });
    expect(notifier.digests[0]!.titles).toEqual(["HR Business Partner"]);
  });

  it("releases matches when sending fails so the next run retries them", async () => {
    await createUser();
    notifier.fail = new Error("telegram down");

    const report = await run([boardAdapter(() => POSTINGS)]);

    expect(report.failed).toBe(true);
    expect(report.notifications).toMatchObject({ ok: true, report: { digestsSent: 0, errors: [{ error: "telegram down" }] } });
    expect(await statusOf("ops")).toMatchObject({ status: "ready", notifiedAt: null });

    notifier.fail = null;
    await runNotifications(db, notifier, { now });
    expect(notifier.digests[0]!.titles).toEqual(["People Operations Lead", "HR Business Partner"]);
  });

  it("stops notifying users who blocked the bot", async () => {
    const userId = await createUser();
    notifier.fail = new RecipientUnavailableError("Forbidden: bot was blocked by the user");

    const report = await run([boardAdapter(() => POSTINGS)]);

    expect(report.notifications).toMatchObject({ ok: true, report: { recipientsDisabled: 1, errors: [] } });
    expect(report.failed).toBe(false);
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user!.notificationsEnabled).toBe(false);
    expect(await statusOf("ops")).toMatchObject({ status: "ready" });

    notifier.fail = null;
    await runNotifications(db, notifier, { now });
    expect(notifier.digests).toEqual([]);
  });

  it("sends each user their own digest", async () => {
    await createUser(1);
    await createUser(2);
    await run([boardAdapter(() => POSTINGS)]);
    expect(notifier.digests.map((d) => d.chatId).sort()).toEqual([10, 20]);
  });

  it("skips deep matching once the run is past its cutoff, but still notifies", async () => {
    await createUser();
    await run([boardAdapter(() => POSTINGS)], { threshold: { minRecommendation: "strong_fit", minConfidence: "low" } });
    notifier.digests = [];
    await db.update(matches).set({ status: "pending", stageReached: "cheap_relevance" }).where(eq(matches.status, "filtered_out"));

    let clock = now().getTime();
    const slowAdapter: JobSourceAdapter<Posting> = {
      ...boardAdapter(() => POSTINGS),
      *collect() {
        clock += 240_000;
      },
    };
    const report = await runDailyPipeline(
      db,
      { adapters: [slowAdapter], matcher: new TitleMatcher(VERDICTS), notifier },
      { now: () => new Date(clock), log },
    );

    expect(report.deepMatching).toMatchObject({ ok: true, report: { evaluated: 0 } });
    expect(report.notifications).toMatchObject({ ok: true, report: { matchesNotified: 1 } });
  });

  it("counts matches shown by What's new? as delivered", async () => {
    const userId = await createUser();
    await run([boardAdapter(() => POSTINGS)], { threshold: { minRecommendation: "strong_fit", minConfidence: "low" } });

    const shown = await new PgMatchService(db).whatsNew(userId, 5);
    expect(shown.map((m) => m.title)).toEqual(["HR Business Partner", "Talent and Culture Manager", "People Operations Lead"]);
    expect(await statusOf("hrbp")).toMatchObject({ status: "notified" });

    notifier.digests = [];
    await runNotifications(db, notifier, { now, threshold: { minRecommendation: "stretch", minConfidence: "low" } });
    expect(notifier.digests).toEqual([]);
  });
});

describe("notification threshold", () => {
  it("defaults to good fits at any confidence", () => {
    const threshold = parseNotificationThreshold({});
    expect(qualifyingRecommendations(threshold)).toEqual(["strong_fit", "good_fit"]);
    expect(qualifyingConfidences(threshold)).toEqual(["low", "medium", "high"]);
  });

  it("reads and validates the environment", () => {
    const threshold = parseNotificationThreshold({ NOTIFY_MIN_RECOMMENDATION: "stretch", NOTIFY_MIN_CONFIDENCE: "medium" });
    expect(qualifyingRecommendations(threshold)).toEqual(["strong_fit", "good_fit", "stretch"]);
    expect(qualifyingConfidences(threshold)).toEqual(["medium", "high"]);
    expect(() => parseNotificationThreshold({ NOTIFY_MIN_RECOMMENDATION: "not_recommended" })).toThrow(/NOTIFY_MIN_RECOMMENDATION/);
    expect(() => parseNotificationThreshold({ NOTIFY_MIN_CONFIDENCE: "certain" })).toThrow(/NOTIFY_MIN_CONFIDENCE/);
  });
});

describe("TelegramNotifier", () => {
  const digest: MatchSummary[] = [
    { matchId: "11111111-1111-1111-1111-111111111111", title: "People <Ops> Lead", company: "Acme", location: null, recommendation: "strong_fit", explanation: "Great fit." },
  ];

  function apiReturning(responses: Record<string, unknown>[]) {
    const api = new Api("test-token");
    const calls: Record<string, any>[] = [];
    api.config.use(async (_prev, _method, payload) => {
      calls.push(payload as Record<string, any>);
      return (responses.shift() ?? { ok: true, result: { message_id: 1 } }) as any;
    });
    return { api, calls };
  }

  it("sends one HTML digest with a details button per match", async () => {
    const { api, calls } = apiReturning([]);
    await new TelegramNotifier(api).sendDigest(10, digest, 3);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.chat_id).toBe(10);
    expect(calls[0]!.text).toContain("People &lt;Ops&gt; Lead");
    expect(calls[0]!.text).toContain("+3 more");
    expect(calls[0]!.reply_markup.inline_keyboard[0][0].callback_data).toBe(`job:${digest[0]!.matchId}`);
  });

  it("retries rate limits and server errors", async () => {
    const delays: number[] = [];
    const { api, calls } = apiReturning([
      { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } },
      { ok: false, error_code: 502, description: "Bad Gateway" },
    ]);
    await new TelegramNotifier(api, { sleep: async (ms) => void delays.push(ms) }).sendDigest(10, digest, 0);

    expect(calls).toHaveLength(3);
    expect(delays).toEqual([2000, 2000]);
  });

  it("gives up after the last attempt and does not retry client errors", async () => {
    const sleep = async () => undefined;
    const busy = apiReturning(Array(3).fill({ ok: false, error_code: 500, description: "Internal" }));
    await expect(new TelegramNotifier(busy.api, { sleep }).sendDigest(10, digest, 0)).rejects.toThrow(/Internal/);
    expect(busy.calls).toHaveLength(3);

    const bad = apiReturning([{ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }]);
    await expect(new TelegramNotifier(bad.api, { sleep }).sendDigest(10, digest, 0)).rejects.toThrow(/parse entities/);
    expect(bad.calls).toHaveLength(1);
  });

  it("reports chats that can no longer receive messages", async () => {
    const { api } = apiReturning([{ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }]);
    await expect(new TelegramNotifier(api).sendDigest(10, digest, 0)).rejects.toBeInstanceOf(RecipientUnavailableError);
  });
});

describe("cron handler", () => {
  const request = (authorization?: string) =>
    new Request("https://example.test/api/cron/daily", { headers: authorization ? { authorization } : {} });

  it("rejects requests without the cron secret", async () => {
    let ran = false;
    const run = async () => ((ran = true), {});
    expect((await createCronHandler("s3cret", run)(request("Bearer nope"))).status).toBe(401);
    expect((await createCronHandler("s3cret", run)(request())).status).toBe(401);
    expect((await createCronHandler(undefined, run)(request("Bearer undefined"))).status).toBe(401);
    expect(ran).toBe(false);
  });

  it("runs the job and returns its report", async () => {
    const response = await createCronHandler("s3cret", async () => ({ failed: false }))(request("Bearer s3cret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ failed: false });
  });
});
