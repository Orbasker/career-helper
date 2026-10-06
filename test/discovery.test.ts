import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiJobDiscoverer } from "../src/ai/job-discoverer.js";
import { createPgServices } from "../src/app/postgres/index.js";
import { parseSite } from "../src/app/postgres/sites.js";
import { createBot } from "../src/bot/bot.js";
import { careerProfiles, jobSources, jobs, preferences, userJobSites, users, workExperiences } from "../src/db/schema.js";
import type { ProfileSnapshot } from "../src/domain/profile.js";
import { atsBoardFromUrl } from "../src/discovery/ats.js";
import { RobotsCache, jobPostingFromJsonLd, parseRobots, type PostingCheck } from "../src/discovery/page.js";
import { searchPlan, type JobCandidate, type JobDiscoverer, type SearchPlan } from "../src/discovery/plan.js";
import { discoverySettingsFromEnv, runDiscovery } from "../src/discovery/run.js";
import { SOURCE_ADAPTERS } from "../src/ingestion/sources/index.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { BOT_INFO, callbackUpdate, captureApiCalls, textUpdate, type ApiCall } from "./support/telegram.js";

const NOW = new Date("2026-10-06T05:00:00Z");

const jsonLdPage = (posting: Record<string, unknown>) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(posting)}</script></head><body>Apply now</body></html>`;

const backendPosting = {
  "@context": "https://schema.org",
  "@type": "JobPosting",
  title: "Backend Engineer",
  description: "<p>Build <b>Python</b> services on AWS.</p><ul><li>Own APIs</li></ul>",
  datePosted: "2026-10-01",
  validThrough: "2026-12-01",
  employmentType: "FULL_TIME",
  hiringOrganization: { "@type": "Organization", name: "Startup Ltd" },
  jobLocation: { "@type": "Place", address: { addressLocality: "Tel Aviv", addressCountry: "IL" } },
};

describe("atsBoardFromUrl", () => {
  it("recognizes Greenhouse, Lever and Ashby posting links and ignores everything else", () => {
    expect(atsBoardFromUrl("https://job-boards.greenhouse.io/Wizinc/jobs/123")).toEqual({ source: "greenhouse", token: "wizinc" });
    expect(atsBoardFromUrl("https://boards.greenhouse.io/melio/jobs/9?gh_src=x")).toEqual({ source: "greenhouse", token: "melio" });
    expect(atsBoardFromUrl("https://jobs.lever.co/justt/abc-123")).toEqual({ source: "lever", token: "justt" });
    expect(atsBoardFromUrl("https://jobs.ashbyhq.com/port/5f2")).toEqual({ source: "ashby", token: "port" });
    expect(atsBoardFromUrl("https://boards.greenhouse.io/embed/job_app?token=1")).toBeNull();
    expect(atsBoardFromUrl("https://www.wix.com/jobs/123")).toBeNull();
    expect(atsBoardFromUrl("not a url")).toBeNull();
  });
});

describe("robots.txt", () => {
  it("applies the longest matching rule for * and our agent", () => {
    const rules = parseRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /search\nAllow: /search/jobs\nDisallow: /private*");
    expect(rules).toEqual({ allow: ["/search/jobs"], disallow: ["/search", "/private"] });
  });

  it("checks pages against the site's rules and allows everything without robots.txt", async () => {
    const fetcher = (async (url: string) =>
      url === "https://a.example/robots.txt"
        ? new Response("User-agent: *\nDisallow: /careers/internal")
        : new Response("missing", { status: 404 })) as typeof fetch;
    const robots = new RobotsCache(fetcher);
    expect(await robots.allows("https://a.example/careers/123")).toBe(true);
    expect(await robots.allows("https://a.example/careers/internal/1")).toBe(false);
    expect(await robots.allows("https://b.example/anything")).toBe(true);
  });
});

describe("jobPostingFromJsonLd", () => {
  it("reads a JobPosting, also inside @graph", () => {
    const expected: PostingCheck = {
      kind: "posting",
      fields: {
        title: "Backend Engineer",
        description: "Build Python services on AWS.\n\n- Own APIs",
        company: "Startup Ltd",
        location: "Tel Aviv, IL",
        workMode: null,
        employmentType: "full_time",
        publishedAt: new Date("2026-10-01"),
      },
    };
    expect(jobPostingFromJsonLd(jsonLdPage(backendPosting), NOW)).toEqual(expected);
    expect(jobPostingFromJsonLd(jsonLdPage({ "@graph": [{ "@type": "WebPage" }, backendPosting] }), NOW)).toEqual(expected);
  });

  it("reports closed postings and pages without job data", () => {
    expect(jobPostingFromJsonLd(jsonLdPage({ ...backendPosting, validThrough: "2026-09-01" }), NOW)).toEqual({ kind: "closed" });
    expect(jobPostingFromJsonLd(jsonLdPage({ "@type": "Organization" }), NOW)).toEqual({ kind: "none" });
    expect(jobPostingFromJsonLd("<html><body>no data</body></html>", NOW)).toEqual({ kind: "none" });
  });

  it("marks telecommute postings as remote", () => {
    const remote = jobPostingFromJsonLd(jsonLdPage({ ...backendPosting, jobLocationType: "TELECOMMUTE" }), NOW);
    expect(remote.kind === "posting" && remote.fields.workMode).toBe("remote");
  });
});

describe("searchPlan", () => {
  const profile = (preferencesList: ProfileSnapshot["preferences"]): ProfileSnapshot => ({
    profile: { headline: "Backend Engineer – Python, AWS", summary: null, currentSeniority: null, managementScope: null, openToAdjacentRoles: true, linkedinUrl: null },
    experiences: [
      { id: "e1", employer: "Via", title: "NOC", industry: null, location: null, seniority: null, managedHeadcount: null, startDate: null, endDate: null, isCurrent: true },
    ],
    facts: [],
    preferences: preferencesList,
  });

  it("searches target roles in the user's must-have location and passes dislikes as exclusions", () => {
    const plan = searchPlan(
      profile([
        { id: "1", kind: "target_role", dimension: "role", label: "Backend Engineer", value: { type: "terms", terms: ["Backend Engineer"] }, status: "active" },
        { id: "2", kind: "target_role", dimension: "role", label: "Full Stack Engineer", value: { type: "free_text", text: "x" }, status: "active" },
        { id: "3", kind: "hard_constraint", dimension: "location", label: "Tel Aviv area", value: { type: "location", places: ["Tel Aviv"] }, status: "active" },
        { id: "4", kind: "dislike", dimension: "role", label: "Support roles", value: { type: "terms", terms: ["support"] }, status: "active" },
        { id: "5", kind: "target_role", dimension: "role", label: "Proposed", value: { type: "terms", terms: ["QA"] }, status: "proposed" },
      ]),
      ["drushim.co.il"],
    );
    expect(plan).toEqual({
      queries: ["Backend Engineer jobs Tel Aviv", "Full Stack Engineer jobs Tel Aviv"],
      domains: ["drushim.co.il"],
      avoid: ["Support roles"],
      country: "IL",
    });
  });

  it("falls back to the headline and titles in Israel, capped", () => {
    expect(searchPlan(profile([]), [], 1).queries).toEqual(["Backend Engineer – Python, AWS jobs Israel"]);
  });
});

describe("parseSite", () => {
  it("accepts bare domains and URLs and normalizes them", () => {
    expect(parseSite("drushim.co.il")).toEqual({ domain: "drushim.co.il", url: "https://drushim.co.il" });
    expect(parseSite("https://www.Example.com/careers/")).toEqual({ domain: "example.com", url: "https://www.example.com/careers/" });
    expect(parseSite("jobs.example.com.")).toEqual({ domain: "jobs.example.com", url: "https://jobs.example.com" });
    expect(parseSite("not a site")).toBeNull();
    expect(parseSite("localhost")).toBeNull();
  });
});

describe("discoverySettingsFromEnv", () => {
  it("reads budgets and the kill switch", () => {
    expect(discoverySettingsFromEnv({})).toEqual({ enabled: true, queriesPerUser: undefined, maxPages: undefined });
    expect(discoverySettingsFromEnv({ DISCOVERY_ENABLED: "false", DISCOVERY_QUERIES_PER_USER: "2", DISCOVERY_MAX_PAGES: "10" })).toEqual({
      enabled: false,
      queriesPerUser: 2,
      maxPages: 10,
    });
    expect(() => discoverySettingsFromEnv({ DISCOVERY_MAX_PAGES: "-1" })).toThrow(/DISCOVERY_MAX_PAGES/);
  });
});

class FakeDiscoverer implements JobDiscoverer {
  readonly model = "fake-discoverer";
  plans: SearchPlan[] = [];
  extracted: string[] = [];
  results: (plan: SearchPlan) => JobCandidate[] = () => [];

  async search(plan: SearchPlan) {
    this.plans.push(plan);
    return this.results(plan);
  }

  async extract({ url }: { url: string; text: string }): Promise<PostingCheck> {
    this.extracted.push(url);
    if (url.includes("closed")) return { kind: "closed" };
    if (url.includes("blog")) return { kind: "none" };
    return { kind: "posting", fields: { title: "Platform Engineer", description: "Run Kubernetes and Terraform.", company: "Hidden Gem", location: "Tel Aviv" } };
  }
}

const candidate = (url: string, company: string | null = null): JobCandidate => ({ url, title: "Job", company });

function pagesFetch(pages: Record<string, string>, robots: Record<string, string> = {}) {
  const requested: string[] = [];
  const fetcher = (async (url: string) => {
    requested.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === "/robots.txt") return robots[parsed.origin] ? new Response(robots[parsed.origin]) : new Response("", { status: 404 });
    const html = pages[url];
    return html ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("gone", { status: 404 });
  }) as typeof fetch;
  return { fetcher, requested };
}

describe("runDiscovery", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let discoverer: FakeDiscoverer;
  let userId: string;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    discoverer = new FakeDiscoverer();
    const [user] = await db.insert(users).values({ telegramUserId: 1, telegramChatId: 1 }).returning();
    userId = user!.id;
    await db.insert(careerProfiles).values({ userId, status: "confirmed", headline: "Backend Engineer" });
    await db.insert(workExperiences).values({ userId, employer: "Via", title: "NOC", origin: "cv_upload", verificationStatus: "verified", verifiedAt: new Date() });
    await db.insert(preferences).values({
      userId,
      kind: "target_role",
      dimension: "role",
      label: "Backend Engineer",
      value: { type: "terms", terms: ["Backend Engineer"] },
      status: "active",
      origin: "onboarding",
      decidedAt: new Date(),
    });
  });

  afterEach(async () => {
    await close();
  });

  it("searches the web and the user's sites, adds ATS boards and ingests readable postings with provenance", async () => {
    await db.insert(userJobSites).values({ userId, domain: "drushim.co.il", url: "https://drushim.co.il" });
    discoverer.results = (plan) =>
      plan.domains.length
        ? [candidate("https://drushim.co.il/job/1"), candidate("https://drushim.co.il/job/closed")]
        : [
            candidate("https://startup.example/careers/backend"),
            candidate("https://job-boards.greenhouse.io/newco/jobs/1"),
            candidate("https://blog.example/post"),
            candidate("https://secret.example/careers/1"),
          ];
    const { fetcher, requested } = pagesFetch(
      {
        "https://startup.example/careers/backend": jsonLdPage(backendPosting),
        "https://drushim.co.il/job/1": "<html><body>Platform Engineer at Hidden Gem</body></html>",
        "https://drushim.co.il/job/closed": "<html><body>closed</body></html>",
        "https://blog.example/post": "<html><body>blog</body></html>",
      },
      { "https://secret.example": "User-agent: *\nDisallow: /careers" },
    );

    const report = await runDiscovery(db, discoverer, SOURCE_ADAPTERS, { now: () => NOW, fetch: fetcher });

    expect(discoverer.plans.map((p) => p.domains)).toEqual([[], ["drushim.co.il"]]);
    expect(discoverer.plans[0]!.queries).toEqual(["Backend Engineer jobs Israel"]);
    expect(report).toMatchObject({
      users: 1,
      searches: 2,
      candidates: 6,
      boardsAdded: ["greenhouse:newco"],
      pagesFetched: 4,
      postings: 2,
      companies: 2,
      skipped: { known: 0, robots: 1, notPosting: 1, closed: 1, overBudget: 0 },
      ingest: { source: "web_search", inserted: 2 },
      errors: [],
    });
    expect(requested).not.toContain("https://secret.example/careers/1");
    expect(discoverer.extracted).not.toContain("https://startup.example/careers/backend");

    const [greenhouse] = await db.select().from(jobSources).where(eq(jobSources.key, "greenhouse"));
    expect(greenhouse!.config).toEqual({ boards: ["newco"] });
    const found = await db.select({ title: jobs.title, company: jobs.company, url: jobs.sourceUrl }).from(jobs).orderBy(jobs.title);
    expect(found).toEqual([
      { title: "Backend Engineer", company: "Startup Ltd", url: "https://startup.example/careers/backend" },
      { title: "Platform Engineer", company: "Hidden Gem", url: "https://drushim.co.il/job/1" },
    ]);
    const [webSource] = await db.select().from(jobSources).where(eq(jobSources.key, "web_search"));
    expect(webSource!.kind).toBe("web_search");

    const again = await runDiscovery(db, discoverer, SOURCE_ADAPTERS, { now: () => NOW, fetch: fetcher });
    expect(again).toMatchObject({ boardsAdded: [], postings: 0, skipped: { known: 2 } });
  });

  it("respects the page budget and the deadline", async () => {
    discoverer.results = () => [1, 2, 3].map((i) => candidate(`https://a.example/job/${i}`));
    const { fetcher } = pagesFetch(Object.fromEntries([1, 2, 3].map((i) => [`https://a.example/job/${i}`, "<html>job</html>"])));

    expect(await runDiscovery(db, discoverer, SOURCE_ADAPTERS, { now: () => NOW, fetch: fetcher, maxPages: 2 })).toMatchObject({
      pagesFetched: 2,
      skipped: { overBudget: 1 },
    });
    discoverer.plans = [];
    const past = await runDiscovery(db, discoverer, SOURCE_ADAPTERS, { now: () => NOW, fetch: fetcher, deadline: NOW });
    expect(past).toMatchObject({ users: 0, searches: 0 });
  });

  it("isolates a failing search and stops when the web_search source is disabled", async () => {
    discoverer.results = () => {
      throw new Error("search quota exceeded");
    };
    expect(await runDiscovery(db, discoverer, SOURCE_ADAPTERS, { now: () => NOW })).toMatchObject({
      errors: [{ scope: `user:${userId}`, error: "search quota exceeded" }],
    });

    await db.insert(jobSources).values({ key: "web_search", name: "Agent web search", kind: "web_search", isEnabled: false });
    discoverer.plans = [];
    expect(await runDiscovery(db, discoverer, SOURCE_ADAPTERS, { now: () => NOW })).toMatchObject({ disabled: true, searches: 0 });
    expect(discoverer.plans).toEqual([]);
  });
});

describe("AiJobDiscoverer.extract", () => {
  const model = (output: Record<string, unknown>) =>
    new MockLanguageModelV4({
      modelId: "mock",
      doGenerate: async () => ({
        content: [{ type: "text", text: JSON.stringify(output) }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }),
    });
  const base = {
    isJobPosting: true,
    isOpen: true,
    title: "Platform Engineer",
    company: "Hidden Gem",
    location: "Tel Aviv",
    workMode: "hybrid",
    employmentType: "full_time",
    description: "Run Kubernetes.",
  };

  it("returns the posting, or reports closed and non-posting pages", async () => {
    const read = (output: Record<string, unknown>) => new AiJobDiscoverer(model(output)).extract({ url: "https://x.example/1", text: "page" });
    expect(await read(base)).toEqual({
      kind: "posting",
      fields: { title: "Platform Engineer", description: "Run Kubernetes.", company: "Hidden Gem", location: "Tel Aviv", workMode: "hybrid", employmentType: "full_time" },
    });
    expect(await read({ ...base, isOpen: false })).toEqual({ kind: "closed" });
    expect(await read({ ...base, isJobPosting: false })).toEqual({ kind: "none" });
    expect(await read({ ...base, description: null })).toEqual({ kind: "none" });
  });
});

describe("job sites in the bot", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let bot: ReturnType<typeof createBot>;
  let calls: ApiCall[];

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    bot = createBot("test-token", createPgServices(db, new FakeProfileAssistant(), new FakeCvTailorer()), { botInfo: BOT_INFO });
    calls = captureApiCalls(bot);
  });

  afterEach(async () => {
    await close();
  });

  const send = async (update: ReturnType<typeof textUpdate>) => {
    calls.length = 0;
    await bot.handleUpdate(update);
  };
  const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload);

  it("adds, lists and removes sites, and adds ATS boards as board sources", async () => {
    await send(textUpdate("/sites"));
    expect(sent()[0]!.text).toContain("/addsite");

    await send(textUpdate("/addsite https://www.drushim.co.il/jobs"));
    expect(sent()[0]!.text).toContain("Added <b>drushim.co.il</b>");
    await send(textUpdate("/addsite drushim.co.il"));
    expect(sent()[0]!.text).toContain("already searching <b>drushim.co.il</b>");
    await send(textUpdate("/addsite job-boards.greenhouse.io/newco"));
    expect(sent()[0]!.text).toContain("company job board");
    const [greenhouse] = await db.select().from(jobSources).where(eq(jobSources.key, "greenhouse"));
    expect(greenhouse!.config).toEqual({ boards: ["newco"] });

    await send(textUpdate("/sites"));
    const list = sent()[0]!;
    expect(list.text).toContain("• drushim.co.il");
    const remove = list.reply_markup.inline_keyboard[0][0].callback_data as string;
    await send(callbackUpdate(remove));
    expect(await db.select().from(userJobSites)).toHaveLength(0);
  });

  it("understands a request to search a site once the profile is confirmed", async () => {
    await send(textUpdate("/help"));
    const [user] = await db.select().from(users);
    await db.insert(careerProfiles).values({ userId: user!.id, status: "confirmed" });

    await send(textUpdate("Please also search on alljobs.co.il for me"));
    expect(sent()[0]!.text).toContain("Added <b>alljobs.co.il</b>");
    await send(textUpdate("/addsite"));
    expect(sent()[0]!.text).toContain("/addsite</b> followed by the site");
  });
});
