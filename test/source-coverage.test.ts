import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgServices } from "../src/app/postgres/index.js";
import type { AppServices } from "../src/app/services.js";
import { createBot } from "../src/bot/bot.js";
import { encodeCallback } from "../src/bot/callbacks.js";
import { timeAgo } from "../src/bot/views.js";
import { duplicateGroups, jobSources, jobs, matches, pipelineRuns, rawJobRecords, userJobSites, users } from "../src/db/schema.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { BOT_INFO, DANA, callbackUpdate, captureApiCalls, textUpdate, type ApiCall } from "./support/telegram.js";

const DAY = 86_400_000;

let db: TestDb;
let close: () => Promise<void>;
let services: AppServices;
let userId: string;
let otherUserId: string;
const sourceIds: Record<string, string> = {};

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  services = createPgServices(db, new FakeProfileAssistant(), new FakeCvTailorer());
  ({ userId } = await services.users.ensureUser({ telegramUserId: DANA.id, chatId: DANA.id }));
  const [other] = await db.insert(users).values({ telegramUserId: 9, telegramChatId: 9 }).returning();
  otherUserId = other!.id;
  const rows = await db
    .insert(jobSources)
    .values([
      { key: "greenhouse", name: "Greenhouse job boards", kind: "api", config: { boards: ["acme", { token: "wiz", company: "Wiz" }] }, lastCollectedAt: new Date(Date.now() - 3 * 3_600_000) },
      { key: "lever", name: "Lever job boards", kind: "api", config: { boards: ["justt", "gone"] } },
      { key: "ashby", name: "Ashby job boards", kind: "api", isEnabled: false, config: { boards: ["port"] } },
      { key: "web_search", name: "Agent web search", kind: "web_search" },
    ])
    .returning();
  for (const row of rows) sourceIds[row.key] = row.id;
});

afterEach(async () => {
  await close();
});

let seq = 0;
async function seedJob(
  source: string,
  { company, createdAt = new Date(), foundBy, group }: { company: string; createdAt?: Date; foundBy?: { userId: string; site: boolean }; group?: string },
) {
  const url = `https://${source}.example/job/${++seq}`;
  const [raw] = await db
    .insert(rawJobRecords)
    .values({ sourceId: sourceIds[source]!, sourceUrl: url, contentHash: `h${seq}`, payload: foundBy ? { url, foundBy } : {} })
    .returning();
  const groupId = group ?? (await db.insert(duplicateGroups).values({ dedupKey: `g${seq}` }).returning())[0]!.id;
  const [job] = await db
    .insert(jobs)
    .values({
      sourceId: sourceIds[source]!,
      rawRecordId: raw!.id,
      sourceUrl: url,
      title: "People Partner",
      company,
      normalizedCompany: company.toLowerCase(),
      description: "Partner with managers.",
      collectedAt: createdAt,
      createdAt,
      duplicateGroupId: groupId,
      dedupMethod: "deterministic_key",
    })
    .returning();
  return { jobId: job!.id, groupId, url };
}

async function recordRun(report: Record<string, unknown>, startedAt = new Date(Date.now() - 2 * 3_600_000)) {
  await db.insert(pipelineRuns).values({ startedAt, finishedAt: startedAt, failed: false, report });
}

describe("source overview", () => {
  it("summarizes each source category from ingestion and run audit data", async () => {
    await seedJob("greenhouse", { company: "Acme", createdAt: new Date(Date.now() - 30 * DAY) });
    await seedJob("greenhouse", { company: "Acme" });
    await seedJob("greenhouse", { company: "Wiz" });
    await seedJob("web_search", { company: "Hidden Gem", foundBy: { userId, site: false } });
    await seedJob("web_search", { company: "Other Site Co", foundBy: { userId: otherUserId, site: true } });
    await seedJob("web_search", { company: "Drushim Co", foundBy: { userId, site: true } });
    await db.insert(userJobSites).values({ userId, domain: "drushim.co.il", url: "https://drushim.co.il" });

    await recordRun({ discovery: { ok: true, report: { searchedUsers: [userId], errors: [] } } }, new Date(Date.now() - 26 * 3_600_000));
    await recordRun({
      discovery: { ok: true, report: { searchedUsers: [], errors: [{ scope: `user:${userId}`, error: "quota" }] } },
      ingestion: {
        ok: true,
        report: {
          sources: [
            { source: "greenhouse", errors: 0, errorScopes: [] },
            { source: "lever", errors: 1, errorScopes: ["board:gone"] },
          ],
        },
      },
    });

    const overview = await services.sources.overview(userId);

    expect(overview.boardSources).toEqual([
      { name: "Ashby job boards", enabled: false, boards: ["port"], lastCollectedAt: null },
      { name: "Greenhouse job boards", enabled: true, boards: ["acme", "Wiz"], lastCollectedAt: expect.any(Date) },
      { name: "Lever job boards", enabled: true, boards: ["justt", "gone"], lastCollectedAt: null },
    ]);
    expect(overview.boardCoverage).toEqual({ jobs: 2, newCompanies: 1 });
    expect(overview.webSearch).toMatchObject({ enabled: true, coverage: { jobs: 2, newCompanies: 2 } });
    expect(overview.webSearch.lastSearchedAt!.getTime()).toBeLessThan(Date.now() - 25 * 3_600_000);
    expect(overview.sites.map((s) => s.domain)).toEqual(["drushim.co.il"]);
    expect(overview.siteCoverage).toEqual({ jobs: 1, newCompanies: 1 });
    expect(overview.issues).toEqual([
      { kind: "turned_off", source: "Ashby job boards" },
      { kind: "unreachable_boards", source: "Lever job boards", boards: ["gone"] },
      { kind: "user_search_failed" },
    ]);
  });

  it("reports web search as off when the last run skipped discovery, and never searched before any run", async () => {
    expect((await services.sources.overview(userId)).webSearch).toEqual({
      enabled: true,
      lastSearchedAt: null,
      coverage: { jobs: 0, newCompanies: 0 },
    });
    await recordRun({ discovery: null, ingestion: { ok: false, error: "db down" } });
    const overview = await services.sources.overview(userId);
    expect(overview.webSearch.enabled).toBe(false);
    expect(overview.issues).toContainEqual({ kind: "turned_off", source: "Agent web search" });
    expect(overview.issues).toContainEqual({ kind: "collection_failed", source: "Company job boards" });
  });
});

describe("job provenance", () => {
  it("explains where a matched job was found, with other copies of the same job", async () => {
    const site = await seedJob("web_search", { company: "Acme", foundBy: { userId, site: true }, createdAt: new Date("2026-10-03T08:00:00Z") });
    const board = await seedJob("greenhouse", { company: "Acme", group: site.groupId, createdAt: new Date("2026-10-01T08:00:00Z") });
    const [match] = await db
      .insert(matches)
      .values({ userId, jobId: site.jobId, duplicateGroupId: site.groupId, status: "ready" })
      .returning();
    const [otherMatch] = await db
      .insert(matches)
      .values({ userId: otherUserId, jobId: site.jobId, duplicateGroupId: site.groupId, status: "ready" })
      .returning();

    expect((await services.matches.details(userId, match!.id))!.provenance).toEqual({
      origin: "user_site",
      sourceName: "Agent web search",
      firstCollectedAt: new Date("2026-10-01T08:00:00Z"),
      otherUrls: [board.url],
    });
    expect((await services.matches.details(otherUserId, otherMatch!.id))!.provenance.origin).toBe("web_search");
  });
});

describe("sources in the bot", () => {
  let bot: ReturnType<typeof createBot>;
  let calls: ApiCall[];
  const send = async (update: ReturnType<typeof textUpdate>) => {
    calls.length = 0;
    await bot.handleUpdate(update);
  };
  const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload);

  beforeEach(() => {
    bot = createBot("test-token", services, { botInfo: BOT_INFO });
    calls = captureApiCalls(bot);
  });

  it("answers /sources and natural-language questions with a summary and drill-downs", async () => {
    await recordRun({ discovery: { ok: true, report: { searchedUsers: [userId], errors: [] } } });
    for (const text of ["/sources", "Where are you searching?", "which sites do you check", "איפה אתה מחפש משרות?"]) {
      await send(textUpdate(text));
      const [reply] = sent();
      expect(reply?.text, text).toContain("Where I search for jobs");
    }
    const [reply] = sent();
    expect(reply!.text).toContain("4 official boards (Greenhouse 2, Lever 2)");
    expect(reply!.text).toContain("Last searched for you 2h ago");
    expect(reply!.text).toContain("Ashby job boards is turned off");
    expect(reply!.text).toContain("Add one with <i>/addsite");
    const buttons = reply!.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data);
    expect(buttons).toEqual([encodeCallback({ type: "sources_boards" }), encodeCallback({ type: "sources_sites" })]);

    await send(callbackUpdate(buttons[0]));
    expect(sent()[0]!.text).toContain("<b>Greenhouse job boards</b> (2)\nacme, Wiz");
    expect(sent()[0]!.text).toContain("<b>Ashby job boards</b> (1 — turned off)");

    await db.insert(userJobSites).values({ userId, domain: "drushim.co.il", url: "https://drushim.co.il" });
    await send(callbackUpdate(buttons[1]));
    expect(sent()[0]!.text).toContain("• drushim.co.il");
  });

  it("shows provenance in the job details", async () => {
    const { jobId, groupId } = await seedJob("greenhouse", { company: "Acme", createdAt: new Date("2026-10-01T08:00:00Z") });
    const [match] = await db.insert(matches).values({ userId, jobId, duplicateGroupId: groupId, status: "ready" }).returning();
    await send(callbackUpdate(encodeCallback({ type: "job_details", matchId: match!.id })));
    expect(sent()[0]!.text).toContain("<b>Where I found it</b>\n🏢 Official company job board (Greenhouse) · first seen 2026-10-01");
    expect(sent()[0]!.text).toContain("Open original posting");
  });
});

describe("timeAgo", () => {
  it("describes how long ago something happened", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const ago = (ms: number) => timeAgo(new Date(now.getTime() - ms), now);
    expect(ago(30_000)).toBe("just now");
    expect(ago(15 * 60_000)).toBe("15 min ago");
    expect(ago(5 * 3_600_000)).toBe("5h ago");
    expect(ago(DAY + 1)).toBe("yesterday");
    expect(ago(3 * DAY)).toBe("3 days ago");
  });
});
