import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiCvTailorer } from "../src/ai/cv-tailorer.js";
import { renderProfile } from "../src/ai/deep-matcher.js";
import { gatewayOptions, tracked, type ModelCall, type ModelCallRecorder } from "../src/ai/tracking.js";
import { createPgServices } from "../src/app/postgres/index.js";
import { createBot } from "../src/bot/bot.js";
import { adminTelegramIds } from "../src/bot/telegram-env.js";
import { CV_EVAL_CASES, checkCv, runCvEval } from "../src/cv/cv-eval.js";
import { modelCalls, pipelineRuns } from "../src/db/schema.js";
import { compareToBaseline, evalSnapshot } from "../src/eval/compare.js";
import { EVAL_PROFILE } from "../src/matching/deep-match-eval.js";
import { PgModelCallRecorder } from "../src/observability/recorder.js";
import { buildStats, formatStats, summarizeRun } from "../src/observability/report.js";
import { runDailyPipeline } from "../src/pipeline/daily.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { BOT_INFO, DANA, NOA, captureApiCalls, textUpdate, type ApiCall } from "./support/telegram.js";

class MemoryRecorder implements ModelCallRecorder {
  calls: ModelCall[] = [];
  async record(call: ModelCall) {
    this.calls.push(call);
  }
}

describe("tracked model calls", () => {
  it("tags the call and records usage from either usage shape", async () => {
    const recorder = new MemoryRecorder();
    let options: unknown;
    const result = await tracked(recorder, "cv.tailor", "m", async (providerOptions) => {
      options = providerOptions;
      return { value: 1, usage: { inputTokens: { total: 120 }, outputTokens: 30 } };
    });

    expect(result.value).toBe(1);
    expect(options).toEqual({ gateway: { tags: ["purpose:cv.tailor", "env:local"] } });
    expect(recorder.calls).toEqual([
      { purpose: "cv.tailor", model: "m", inputTokens: 120, outputTokens: 30, durationMs: expect.any(Number), ok: true, error: null },
    ]);
  });

  it("prefers total usage across steps, records failures and never fails on a broken recorder", async () => {
    const recorder = new MemoryRecorder();
    await tracked(recorder, "discovery.search", "m", async () => ({ usage: { inputTokens: 5 }, totalUsage: { inputTokens: 50, outputTokens: 9 } }));
    await expect(
      tracked(recorder, "deep_match.decide", "m", async () => {
        throw new Error("gateway 503");
      }),
    ).rejects.toThrow("gateway 503");
    expect(recorder.calls.map((c) => [c.purpose, c.ok, c.inputTokens, c.error])).toEqual([
      ["discovery.search", true, 50, null],
      ["deep_match.decide", false, null, "gateway 503"],
    ]);

    const broken: ModelCallRecorder = { record: () => Promise.reject(new Error("db down")) };
    await expect(tracked(broken, "cv.tailor", "m", async () => ({ ok: true, usage: {} }))).resolves.toEqual({ ok: true, usage: {} });
  });

  it("is used by the AI services", async () => {
    const recorder = new MemoryRecorder();
    const { aliases } = renderProfile(EVAL_PROFILE);
    const alias = [...aliases.facts].find(([, id]) => id === "f-partner")![0];
    const seen: unknown[] = [];
    const model = new MockLanguageModelV4({
      modelId: "sonnet-mock",
      doGenerate: async (options) => {
        seen.push(options.providerOptions);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: [],
                highlights: [{ fact: alias, text: "HR business partner for an R&D organization of 250 employees" }],
                skills: [],
                applicationNote: { text: "", sources: [] },
              }),
            },
          ],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 80, text: 80, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });

    await new AiCvTailorer(model, recorder).tailor({
      profile: EVAL_PROFILE,
      job: CV_EVAL_CASES[0]!.job,
      language: "en",
      styleReference: null,
      keep: { highlights: [], skills: [] },
    });
    expect(seen[0]).toEqual(gatewayOptions("cv.tailor"));
    expect(recorder.calls).toMatchObject([{ purpose: "cv.tailor", model: "sonnet-mock", inputTokens: 900, outputTokens: 80, ok: true }]);
  });
});

describe("operator report", () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });

  afterEach(async () => {
    await close();
  });

  it("records every pipeline run and summarizes it with model usage and spend", async () => {
    const notifier = { sendDigest: async () => undefined };
    const matcher = { model: "m", promptVersion: "v", evaluate: () => Promise.reject(new Error("unused")) };
    await runDailyPipeline(db, { adapters: [], matcher, notifier }, { log: () => undefined });
    const [run] = await db.select().from(pipelineRuns);
    expect(run).toMatchObject({ failed: false, finishedAt: expect.any(Date) });
    expect(summarizeRun(run!.report)).toEqual([
      "Collection: 0 new jobs from 0 sources",
      "Cheap matching: 0 evaluated, 0 passed",
      "Deep matching: 0 evaluated, 0 recommended",
      "Notifications: 0 digests, 0 matches",
    ]);
    await db.insert(pipelineRuns).values({ startedAt: new Date(Date.now() - 60_000) });

    const recorder = new PgModelCallRecorder(db);
    await recorder.record({ purpose: "deep_match.explain", model: "m", inputTokens: 1000, outputTokens: 200, durationMs: 4000, ok: true, error: null });
    await recorder.record({ purpose: "deep_match.explain", model: "m", inputTokens: null, outputTokens: null, durationMs: 2000, ok: false, error: "timeout" });

    const stats = await buildStats(db, {
      days: 7,
      spend: async () => [
        { tag: "purpose:deep_match.explain", cost: 0.42 },
        { tag: "env:production", cost: 0.42 },
      ],
    });
    expect(stats.runs).toEqual({ total: 2, failed: 0, unfinished: 1 });
    expect(stats.modelCalls).toEqual([{ purpose: "deep_match.explain", calls: 2, errors: 1, inputTokens: 1000, outputTokens: 200, avgMs: 3000 }]);
    expect(stats.spend).toEqual({ rows: [{ tag: "purpose:deep_match.explain", cost: 0.42 }], total: 0.42 });

    const text = formatStats(stats, { html: true });
    expect(text).toContain("2 runs, 0 failed, 1 cut off before finishing");
    expect(text).toContain("Last run");
    expect(text).toContain("deep_match.explain: 2 calls (1 failed), 1200 tokens, ~3.0s");
    expect(text).toContain("Total $0.420");

    const failedSpend = await buildStats(db, { spend: () => Promise.reject(new Error("no gateway credentials")) });
    expect(formatStats(failedSpend)).toContain("unavailable (no gateway credentials)");
  });

  it("is only available to admins in the bot", async () => {
    const services = createPgServices(db, new FakeProfileAssistant(), new FakeCvTailorer());
    const bot = createBot("test-token", services, { botInfo: BOT_INFO }, undefined, { adminTelegramIds: [DANA.id] });
    const calls: ApiCall[] = captureApiCalls(bot);

    await bot.handleUpdate(textUpdate("/stats 3", DANA));
    expect(calls.find((c) => c.method === "sendMessage")!.payload.text).toContain("Career agent — last 3 days");

    calls.length = 0;
    await bot.handleUpdate(textUpdate("/stats", NOA));
    expect(calls.find((c) => c.method === "sendMessage")!.payload.text).not.toContain("Career agent — last");
  });

  it("reads admin ids from the environment", () => {
    expect(adminTelegramIds({ ADMIN_TELEGRAM_IDS: " 1001, 2002 ,x,-3" })).toEqual([1001, 2002]);
    expect(adminTelegramIds({})).toEqual([]);
  });

  it("keeps a model call record", async () => {
    await new PgModelCallRecorder(db).record({ purpose: "cv.tailor", model: "m", inputTokens: 1, outputTokens: 2, durationMs: 3, ok: false, error: "x".repeat(2000) });
    const [row] = await db.select().from(modelCalls);
    expect(row!.error).toHaveLength(1000);
  });
});

describe("evaluation harness", () => {
  it("checks CV factuality, grounding, key facts and sections", async () => {
    const evalCase = CV_EVAL_CASES[0]!;
    const good = {
      items: [
        { careerFactId: "f-partner", section: "summary" as const, position: 0, text: "s" },
        ...evalCase.mustHighlight.map((id, position) => ({ careerFactId: id, section: "experience" as const, position, text: "b" })),
      ],
      applicationNote: "note",
      violations: [],
    };
    expect(checkCv(evalCase, good)).toEqual([]);
    expect(
      checkCv(evalCase, {
        items: [{ careerFactId: "f-made-up", section: "experience", position: 0, text: "x" }],
        applicationNote: null,
        violations: ["bullet “Led 300 people”: number 300"],
      }),
    ).toEqual([
      "unsupported claim: bullet “Led 300 people”: number 300",
      "line cites unknown fact f-made-up",
      "missing key fact f-partner",
      "missing key fact f-reviews",
      "missing key fact f-attrition",
      "no summary",
      "no application note",
    ]);

    const hebrewCase = CV_EVAL_CASES.find((c) => c.language === "he")!;
    expect(checkCv(hebrewCase, { ...good, items: good.items.map((i) => ({ ...i, text: i.section === "summary" ? "שותפה עסקית" : "Led reviews" })) })).toEqual(
      hebrewCase.mustHighlight.map(() => "not in he: “Led reviews”"),
    );

    const results = await runCvEval(new FakeCvTailorer());
    expect(results).toHaveLength(CV_EVAL_CASES.length);
    expect(results.every((r) => r.cv !== null)).toBe(true);
  });

  it("compares a run with the baseline and lists regressions, fixes and model changes", () => {
    const baseline = evalSnapshot(
      { matching: [{ id: "a", problems: [] }, { id: "b", problems: ["wrong"] }], cv: [{ id: "c", problems: [] }] },
      { cvModel: "sonnet-5.5" },
    );
    const current = evalSnapshot(
      { matching: [{ id: "a", problems: ["wrong"] }, { id: "b", problems: [] }], cv: [{ id: "c", problems: [] }], extra: [] },
      { cvModel: "opus-5.5" },
    );

    expect(compareToBaseline(current, baseline)).toEqual({
      regressions: ["matching/a"],
      fixed: ["matching/b"],
      lines: ["matching: 1/2 (baseline 1/2)", "cv: 1/1 (baseline 1/1)", "extra: 0/0 (no baseline)", "cvModel: sonnet-5.5 → opus-5.5"],
    });
    expect(compareToBaseline(current, null).regressions).toEqual([]);
  });
});
