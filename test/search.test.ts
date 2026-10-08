import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgServices } from "../src/app/postgres/index.js";
import { createBot } from "../src/bot/bot.js";
import { careerProfiles, jobSearches, jobSources, matches, pipelineRuns, preferences, users, workExperiences } from "../src/db/schema.js";
import type { ProfileSnapshot } from "../src/domain/profile.js";
import { parseSearchRequest } from "../src/domain/search.js";
import type { RawJob } from "../src/ingestion/adapter.js";
import { runSiteSearch, SourceBlockedError, type JobQuery, type JobSearchSource } from "../src/ingestion/search.js";
import { normalizeLocation } from "../src/ingestion/normalize.js";
import { boardSince, politeFetch } from "../src/ingestion/sources/shared.js";
import { summarizeRun } from "../src/observability/report.js";
import { runDailyPipeline } from "../src/pipeline/daily.js";
import { strings } from "../src/i18n/index.js";
import type { DeepMatchJob, DeepMatchVerdict, DeepMatcher } from "../src/matching/deep-match.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { BOT_INFO, DANA, captureApiCalls, textUpdate, type ApiCall } from "./support/telegram.js";

const NOW = new Date("2026-10-08T07:00:00Z");
const en = strings("en");

interface FakePosting {
  id: string;
  title: string;
  company: string;
  description?: string;
}

class FakeSite implements JobSearchSource<FakePosting> {
  readonly source;
  readonly requestIntervalMs = 0;
  queries: JobQuery[] = [];
  detailed: string[] = [];
  results: (query: JobQuery) => FakePosting[] = () => [];
  blockDetails = false;

  constructor(key = "fakesite", name = "Fake Jobs") {
    this.source = { key, name, kind: "scraper" as const, baseUrl: `https://${key}.example` };
  }

  async search(query: JobQuery): Promise<RawJob<FakePosting>[]> {
    this.queries.push(query);
    return this.results(query).map((posting) => ({
      externalId: posting.id,
      sourceUrl: `https://${this.source.key}.example/jobs/${posting.id}`,
      payload: posting,
    }));
  }

  async details(listed: RawJob<FakePosting>): Promise<RawJob<FakePosting> | null> {
    if (this.blockDetails) throw new SourceBlockedError("captcha");
    this.detailed.push(listed.externalId!);
    if (listed.payload.title.includes("Closed")) return null;
    return { ...listed, payload: { ...listed.payload, description: `Full description of ${listed.payload.title}.` } };
  }

  normalize({ payload }: RawJob<FakePosting>) {
    return payload.description ? { title: payload.title, company: payload.company, description: payload.description, location: "Tel Aviv" } : null;
  }
}

const posting = (id: string, title = "Backend Engineer", company = `Company ${id}`): FakePosting => ({ id, title, company });

async function addConfirmedUser(db: TestDb, telegramId = 1) {
  const [user] = await db.insert(users).values({ telegramUserId: telegramId, telegramChatId: telegramId, preferredLanguage: "en" }).returning();
  const userId = user!.id;
  await db.insert(careerProfiles).values({ userId, status: "confirmed", headline: "Backend Engineer" });
  await db.insert(workExperiences).values({ userId, employer: "Via", title: "Backend Engineer", origin: "cv_upload", verificationStatus: "verified", verifiedAt: NOW });
  await db.insert(preferences).values({
    userId,
    kind: "target_role",
    dimension: "role",
    label: "Backend Engineer",
    value: { type: "terms", terms: ["Backend Engineer"] },
    status: "active",
    origin: "onboarding",
    decidedAt: NOW,
  });
  return userId;
}

describe("parseSearchRequest", () => {
  it("recognizes requests to search now, with optional keywords, in English and Hebrew", () => {
    expect(parseSearchRequest("find me jobs")).toEqual({ keywords: null });
    expect(parseSearchRequest("Search for new jobs now!")).toEqual({ keywords: null });
    expect(parseSearchRequest("search for product manager jobs")).toEqual({ keywords: "product manager" });
    expect(parseSearchRequest("חפש לי משרות")).toEqual({ keywords: null });
    expect(parseSearchRequest("תחפש משרות של מנהל מוצר")).toEqual({ keywords: "מנהל מוצר" });
    expect(parseSearchRequest("חפש לי משרות בתחום שיווק")).toEqual({ keywords: "שיווק" });
    expect(parseSearchRequest("חפש משרות בודק תוכנה")).toEqual({ keywords: "בודק תוכנה" });
    expect(parseSearchRequest("חפש לי משרות כלכלן")).toEqual({ keywords: "כלכלן" });
    expect(parseSearchRequest("I want jobs in Haifa")).toBeNull();
    expect(parseSearchRequest("search on drushim.co.il")).toBeNull();
  });
});

describe("boardSince", () => {
  it("collects a board in full on its first run after discovery added it", () => {
    const since = new Date("2026-10-07T05:00:00Z");
    expect(boardSince({ token: "a", company: null, addedAt: null }, since)).toBe(since);
    expect(boardSince({ token: "a", company: null, addedAt: new Date("2026-10-07T12:00:00Z") }, since)).toBeNull();
    expect(boardSince({ token: "a", company: null, addedAt: new Date("2026-10-01T12:00:00Z") }, since)).toBe(since);
  });
});

describe("Hebrew places", () => {
  it("normalizes Hebrew city names from Israeli job sites to the English names profiles use", () => {
    expect(normalizeLocation("תל אביב-יפו")).toBe("tel aviv");
    expect(normalizeLocation("בני ברק, רמת גן")).toBe("bnei brak");
    expect(normalizeLocation("עבודה מהבית")).toBe("remote");
  });
});

describe("politeFetch", () => {
  it("spaces requests out and retries throttled ones with backoff", async () => {
    const slept: number[] = [];
    let calls = 0;
    const fetcher = (async () => new Response(null, { status: ++calls === 1 ? 429 : 200 })) as unknown as typeof fetch;
    const polite = politeFetch(fetcher, { minIntervalMs: 0, backoffMs: 100, sleep: async (ms) => void slept.push(ms) });
    expect((await polite("https://a.example")).status).toBe(200);
    expect(calls).toBe(2);
    expect(slept).toEqual([100]);
  });

  it("returns the last response when retries run out", async () => {
    const fetcher = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const polite = politeFetch(fetcher, { minIntervalMs: 0, retries: 2, backoffMs: 1, sleep: async () => undefined });
    expect((await polite("https://a.example")).status).toBe(503);
  });
});

describe("runSiteSearch", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let site: FakeSite;
  const queries: JobQuery[] = [
    { keywords: "Backend Engineer", location: null },
    { keywords: "Platform Engineer", location: "Haifa" },
  ];

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    site = new FakeSite();
  });

  afterEach(async () => {
    await close();
  });

  it("fetches details only for new postings and ingests them under the site's own source", async () => {
    site.results = (q) => (q.keywords === "Backend Engineer" ? [posting("1"), posting("2", "Closed role")] : [posting("1"), posting("3")]);

    const report = await runSiteSearch(db, [site], queries, { now: () => NOW });

    expect(site.queries).toEqual(queries);
    expect(site.detailed).toEqual(["1", "3", "2"]);
    expect(report.sources).toEqual([
      expect.objectContaining({ source: "fakesite", queries: 2, listed: 3, known: 0, detailed: 3, deferred: 0, blocked: false }),
    ]);
    expect(report.sources[0]!.ingest).toMatchObject({ inserted: 2, ok: true });
    const [source] = await db.select().from(jobSources).where(eq(jobSources.key, "fakesite"));
    expect(source).toMatchObject({ kind: "scraper", name: "Fake Jobs", lastCollectedAt: NOW });

    site.detailed = [];
    const again = await runSiteSearch(db, [site], queries, { now: () => NOW });
    expect(site.detailed).toEqual(["2"]);
    expect(again.sources[0]).toMatchObject({ listed: 3, known: 2, detailed: 1 });
  });

  it("defers new postings past the details budget and stops a blocked site", async () => {
    site.results = () => [posting("1"), posting("2"), posting("3")];
    const budget = await runSiteSearch(db, [site], queries.slice(0, 1), { now: () => NOW, detailsPerSource: 2 });
    expect(budget.sources[0]).toMatchObject({ detailed: 2, deferred: 1 });

    const other = new FakeSite("blockedsite", "Blocked Jobs");
    other.results = () => [posting("9")];
    other.blockDetails = true;
    const report = await runSiteSearch(db, [other], queries, { now: () => NOW });
    expect(other.queries).toHaveLength(2);
    expect(report.sources[0]).toMatchObject({ blocked: true, ingest: { ok: false, errorScopes: ["blocked"] } });
    const [source] = await db.select().from(jobSources).where(eq(jobSources.key, "blockedsite"));
    expect(source!.lastCollectedAt).toBeNull();
  });

  it("isolates a failing query and skips disabled sites without requests", async () => {
    site.results = (q) => {
      if (q.location === "Haifa") throw new Error("timeout");
      return [posting("1")];
    };
    const report = await runSiteSearch(db, [site], queries, { now: () => NOW });
    expect(report.sources[0]).toMatchObject({ queries: 2, ingest: { inserted: 1, errorScopes: ["query:Platform Engineer"] } });

    await db.update(jobSources).set({ isEnabled: false }).where(eq(jobSources.key, "fakesite"));
    site.queries = [];
    const disabled = await runSiteSearch(db, [site], queries, { now: () => NOW });
    expect(site.queries).toEqual([]);
    expect(disabled.sources[0]!.ingest.disabled).toBe(true);
  });

  it("starts no request past the deadline", async () => {
    site.results = () => [posting("1")];
    await runSiteSearch(db, [site], queries, { now: () => NOW, deadline: NOW });
    expect(site.queries).toEqual([]);
  });
});

describe("job sites in the daily pipeline", () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });

  afterEach(async () => {
    await close();
  });

  it("searches every profile's roles once, ingests and matches the postings and summarizes the sites", async () => {
    await addConfirmedUser(db, 1);
    await addConfirmedUser(db, 2);
    const site = new FakeSite("linkedin", "LinkedIn");
    site.results = () => [posting("1", "Backend Engineer", "Acme")];
    const notified: string[] = [];
    const report = await runDailyPipeline(
      db,
      {
        adapters: [],
        searchSources: [site],
        matcher: new FakeMatcher(),
        notifier: { sendDigest: async (_chat, digest) => void notified.push(...digest.map((m) => m.title)) },
      },
      { now: () => NOW, log: () => undefined },
    );

    expect(site.queries).toEqual([{ keywords: "Backend Engineer", location: null }]);
    expect(report.siteSearch).toMatchObject({ ok: true, report: { sources: [{ source: "linkedin", listed: 1, ingest: { inserted: 1 } }] } });
    expect(notified).toEqual(["Backend Engineer", "Backend Engineer"]);
    const [run] = await db.select().from(pipelineRuns);
    expect(summarizeRun(run!.report)).toContain("Job sites: linkedin 1/1 new");
  });
});

class FakeMatcher implements DeepMatcher {
  readonly model = "fake-matcher";
  readonly promptVersion = "test";
  calls: DeepMatchJob[] = [];

  async evaluate({ job }: { profile: ProfileSnapshot; job: DeepMatchJob }): Promise<DeepMatchVerdict> {
    this.calls.push(job);
    return {
      recommendation: "good_fit",
      confidence: "high",
      explanation: `Your backend work fits ${job.title}.`,
      evidence: { fitEvidence: [], gaps: [], risks: [], transferableSkills: [] },
    };
  }
}

describe("/search in the bot", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let bot: ReturnType<typeof createBot>;
  let calls: ApiCall[];
  let site: FakeSite;
  let clock: Date;
  let userId: string;
  let services: ReturnType<typeof createPgServices>;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    site = new FakeSite("linkedin", "LinkedIn");
    clock = NOW;
    userId = await addConfirmedUser(db, DANA.id);
    services = createPgServices(db, new FakeProfileAssistant(), new FakeCvTailorer(), {
      search: {
        deps: { boardAdapters: [], searchSources: [site], matcher: new FakeMatcher() },
        options: { now: () => clock },
      },
    });
    bot = createBot("test-token", services, { botInfo: BOT_INFO });
    calls = captureApiCalls(bot);
  });

  afterEach(async () => {
    await close();
  });

  async function send(text: string) {
    calls.length = 0;
    await bot.handleUpdate(textUpdate(text));
  }
  const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text as string);

  it("searches the job sites for the profile, matches what it found and sends the best matches", async () => {
    site.results = () => [posting("1", "Backend Engineer", "Acme"), posting("2", "Senior Backend Engineer", "Globex")];

    await send("/search");

    const replies = sent();
    expect(replies[0]).toBe(en.search.started(null));
    expect(site.queries).toEqual([{ keywords: "Backend Engineer", location: null }]);
    expect(replies[1]).toContain(en.search.doneHeading);
    expect(replies[1]).toContain(en.search.source("LinkedIn", 2, 2));
    expect(replies[1]).toContain(en.search.matches(2));
    expect(replies.slice(2).join("\n")).toContain("Backend Engineer");
    const statuses = (await db.select({ status: matches.status }).from(matches)).map((m) => m.status);
    expect(statuses).toEqual(["notified", "notified"]);
    const [search] = await db.select().from(jobSearches);
    expect(search).toMatchObject({ userId, query: null, status: "completed" });
  });

  it("searches for the keywords the user gives and lets the user search as often as they like", async () => {
    site.results = () => [];

    await send("/search product manager");
    expect(site.queries).toEqual([{ keywords: "product manager", location: null }]);
    expect(sent()[0]).toContain("<b>product manager</b>");
    expect(sent()[1]).toContain(en.search.noMatches);

    for (const text of ["find me jobs", "/search", "/search"]) await send(text);
    expect(site.queries).toHaveLength(4);
    expect((await db.select().from(jobSearches)).map((s) => s.status)).toEqual(["completed", "completed", "completed", "completed"]);
  });

  it("runs one search at a time per user", async () => {
    await db.insert(jobSearches).values({ userId, startedAt: new Date(NOW.getTime() - 60_000) });
    await send("/search");
    expect(sent()).toEqual([en.search.running]);

    await db.update(jobSearches).set({ status: "failed" });
    site.search = async () => {
      throw new Error("unexpected");
    };
    await send("/search");
    expect(sent()[1]).toContain(en.search.sourceFailed("LinkedIn"));
    expect((await db.select().from(jobSearches)).map((s) => s.status).sort()).toEqual(["completed", "failed"]);
  });

  it("treats a search still running after 10 minutes as failed so it no longer blocks a new one", async () => {
    await db.insert(jobSearches).values({ userId, startedAt: new Date(NOW.getTime() - 60 * 60_000) });
    await send("/search");
    expect(sent()[0]).toBe(en.search.started(null));
    expect((await db.select().from(jobSearches)).map((s) => s.status).sort()).toEqual(["completed", "failed"]);
  });

  it("asks users without a profile to set one up", async () => {
    await db.update(careerProfiles).set({ status: "draft" });
    await send("/search");
    expect(sent()).toEqual([en.messages.notOnboarded]);
  });

  it("lists job sites and a blocked site in /sources, and names the site in a job's provenance", async () => {
    site.results = () => [posting("1", "Backend Engineer", "Acme")];
    await send("/search");
    await db.insert(pipelineRuns).values({
      startedAt: NOW,
      finishedAt: NOW,
      report: { siteSearch: { ok: true, report: { sources: [{ source: "linkedin", blocked: true, ingest: { errors: 1 } }] } } },
    });

    await send("/sources");
    const text = sent()[0]!;
    expect(text).toContain(en.jobSources.jobSitesHeading);
    expect(text).toContain("LinkedIn: searched with your roles");
    expect(text).toContain(en.jobSources.blocked("LinkedIn"));

    const [match] = await db.select({ id: matches.id }).from(matches);
    const details = await services.matches.details(userId, match!.id);
    expect(details!.provenance).toMatchObject({ origin: "job_site", sourceName: "LinkedIn" });
  });
});
