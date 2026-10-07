import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgServices } from "../src/app/postgres/index.js";
import { createBot, jobLinksFromText, siteRequestFrom } from "../src/bot/bot.js";
import { encodeCallback } from "../src/bot/callbacks.js";
import {
  careerProfiles,
  duplicateGroups,
  jobSources,
  jobs,
  matchEvaluations,
  matches,
  preferences,
  rawJobRecords,
  userJobSites,
  users,
  workExperiences,
} from "../src/db/schema.js";
import type { ProfileSnapshot } from "../src/domain/profile.js";
import { atsPostingFromUrl } from "../src/discovery/ats.js";
import type { PostingCheck } from "../src/discovery/page.js";
import { assertPublicUrl, isPublicAddress, publicFetch } from "../src/discovery/safe-fetch.js";
import { USER_SUBMITTED_SOURCE_KEY, submittedUrl, type SubmittedPostingPayload } from "../src/discovery/submitted.js";
import { strings } from "../src/i18n/index.js";
import type { DeepMatchJob, DeepMatchVerdict, DeepMatcher } from "../src/matching/deep-match.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { BOT_INFO, captureApiCalls, textUpdate, type ApiCall } from "./support/telegram.js";

const { jobLinks } = strings("en");

const NOW = new Date("2026-10-07T10:00:00Z");
const PUBLIC_IP = "93.184.216.34";
const resolvePublic = async () => [PUBLIC_IP];

const jsonLdPage = (posting: Record<string, unknown>) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", ...posting })}</script></head><body>Apply</body></html>`;

const hrbpPosting = {
  title: "HR Business Partner",
  description: "<p>Partner with engineering leaders on people strategy, performance and org design.</p>",
  hiringOrganization: { name: "Acme Ltd" },
  jobLocation: { address: { addressLocality: "Tel Aviv", addressCountry: "IL" } },
  validThrough: "2026-12-31",
};

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });

describe("public fetch", () => {
  it("accepts public addresses only", () => {
    expect(isPublicAddress(PUBLIC_IP)).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("rejects non-web schemes, custom ports, credentials and private hosts", async () => {
    for (const url of ["ftp://example.com/a", "https://example.com:8443/a", "https://user:pw@example.com/", "http://localhost/a", "http://127.0.0.1/a", "http://[::1]/a", "http://metadata.internal/"]) {
      await expect(assertPublicUrl(new URL(url), resolvePublic), url).rejects.toThrow(/not a public web address/);
    }
    await expect(assertPublicUrl(new URL("https://intranet.example"), async () => ["10.0.0.5"])).rejects.toThrow();
    await expect(assertPublicUrl(new URL("https://example.com/job"), resolvePublic)).resolves.toBeUndefined();
  });

  it("checks every redirect hop", async () => {
    const requested: string[] = [];
    const fetcher = (async (url: string) => {
      requested.push(url);
      if (url === "https://short.example/j") return new Response(null, { status: 302, headers: { location: "https://jobs.example/1" } });
      if (url === "https://jobs.example/1") return new Response(null, { status: 301, headers: { location: "http://127.0.0.1/admin" } });
      return new Response("ok");
    }) as typeof fetch;
    await expect(publicFetch(fetcher, resolvePublic)("https://short.example/j")).rejects.toThrow(/not a public web address/);
    expect(requested).toEqual(["https://short.example/j", "https://jobs.example/1"]);
  });

  it("reports the final URL after redirects", async () => {
    const fetcher = (async (url: string) =>
      url === "https://a.example/x" ? new Response(null, { status: 302, headers: { location: "/y" } }) : new Response("ok")) as typeof fetch;
    const response = await publicFetch(fetcher, resolvePublic)("https://a.example/x");
    expect(response.url).toBe("https://a.example/y");
  });
});

describe("job links", () => {
  it("finds links in a message, without LinkedIn profiles or trailing punctuation", () => {
    expect(jobLinksFromText("What about https://acme.com/careers/42?utm_source=x. And https://www.linkedin.com/in/dana")).toEqual([
      "https://acme.com/careers/42?utm_source=x",
    ]);
    expect(jobLinksFromText("a https://a.example/1 b https://b.example/2 c https://c.example/3 d https://d.example/4")).toHaveLength(3);
    expect(jobLinksFromText("no links here, just acme.com")).toEqual([]);
  });

  it("strips fragments and tracking parameters", () => {
    expect(submittedUrl("https://acme.com/jobs/42?utm_source=li&gh_jid=42#apply")).toBe("https://acme.com/jobs/42?gh_jid=42");
    expect(submittedUrl("javascript:alert(1)")).toBeNull();
    expect(submittedUrl("not a link")).toBeNull();
  });

  it("treats 'look at <page>' as a job and 'search on <site>' as a site", () => {
    expect(siteRequestFrom("please search on alljobs.co.il")).toBe("alljobs.co.il");
    expect(siteRequestFrom("also look at https://jobs.example.com")).toBe("https://jobs.example.com");
    expect(siteRequestFrom("can you look at https://acme.com/careers/42")).toBeNull();
  });

  it("reads the posting id from ATS links", () => {
    expect(atsPostingFromUrl("https://job-boards.greenhouse.io/acme/jobs/4012345?gh_src=x")).toEqual({
      source: "greenhouse",
      token: "acme",
      postingId: "4012345",
      eu: false,
    });
    expect(atsPostingFromUrl("https://jobs.eu.lever.co/justt/6f1c2a9e-1b2c-4d5e-8f90-123456789abc/apply")).toMatchObject({
      source: "lever",
      postingId: "6f1c2a9e-1b2c-4d5e-8f90-123456789abc",
      eu: true,
    });
    expect(atsPostingFromUrl("https://jobs.ashbyhq.com/port/5f2a9e1b-0000-4000-8000-000000000001")).toMatchObject({ source: "ashby", token: "port" });
    expect(atsPostingFromUrl("https://jobs.lever.co/justt")).toBeNull();
    expect(atsPostingFromUrl("https://acme.com/jobs/1")).toBeNull();
  });
});

class FakeMatcher implements DeepMatcher {
  readonly model = "fake-model";
  readonly promptVersion = "fake-v1";
  calls: DeepMatchJob[] = [];
  fail = false;

  async evaluate({ job }: { profile: ProfileSnapshot; job: DeepMatchJob }): Promise<DeepMatchVerdict> {
    this.calls.push(job);
    if (this.fail) throw new Error("gateway down");
    return {
      recommendation: "good_fit",
      confidence: "high",
      explanation: `Your HR partnering background fits ${job.title}.`,
      evidence: { fitEvidence: [{ claim: "Partnered with R&D leaders", careerFactIds: [] }], gaps: ["No org design"], risks: [], transferableSkills: ["Coaching"] },
    };
  }
}

class FakeReader {
  extracted: string[] = [];
  result: PostingCheck = { kind: "none" };

  async extract({ url }: { url: string; text: string }): Promise<PostingCheck> {
    this.extracted.push(url);
    return this.result;
  }
}

describe("analyzing a job link in the bot", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let bot: ReturnType<typeof createBot>;
  let calls: ApiCall[];
  let matcher: FakeMatcher;
  let reader: FakeReader;
  let pages: Record<string, () => Response>;
  let requested: string[];
  let userId: string;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    matcher = new FakeMatcher();
    reader = new FakeReader();
    pages = {};
    requested = [];
    const fetcher = (async (url: string) => {
      requested.push(url);
      if (new URL(url).pathname === "/robots.txt") return new Response("", { status: 404 });
      return pages[url]?.() ?? new Response("missing", { status: 404 });
    }) as typeof fetch;
    const services = createPgServices(db, new FakeProfileAssistant(), new FakeCvTailorer(), {
      jobLinks: { reader, matcher, fetch: fetcher, resolveHost: resolvePublic, now: () => NOW },
    });
    bot = createBot("test-token", services, { botInfo: BOT_INFO });
    calls = captureApiCalls(bot);

    await send(textUpdate("/help"));
    const [user] = await db.select().from(users);
    userId = user!.id;
    await db.update(users).set({ preferredLanguage: "en" });
    await db.insert(careerProfiles).values({ userId, status: "confirmed", headline: "HR Business Partner" });
    await db.insert(workExperiences).values({
      userId,
      employer: "Via",
      title: "HR Business Partner",
      origin: "cv_upload",
      verificationStatus: "verified",
      verifiedAt: new Date(),
    });
  });

  afterEach(async () => {
    await close();
  });

  async function send(update: ReturnType<typeof textUpdate>) {
    calls.length = 0;
    await bot.handleUpdate(update);
  }
  const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload);
  const buttons = (payload: Record<string, any>) => (payload.reply_markup.inline_keyboard as any[][]).flat();

  it("reads a posting, records it as user-submitted and replies with the match and next actions", async () => {
    pages["https://careers.acme.com/jobs/hrbp"] = () => html(jsonLdPage(hrbpPosting));

    await send(textUpdate("What do you think of https://careers.acme.com/jobs/hrbp?utm_source=linkedin"));

    const replies = sent();
    expect(replies[0]!.text).toContain("Reading the job posting");
    const result = replies.at(-1)!;
    expect(result.text).toContain(jobLinks.fits);
    expect(result.text).toContain("Good fit");
    expect(result.text).toContain("Partnered with R&amp;D leaders");
    expect(result.text).toContain("No org design");
    expect(result.text).toContain("/connections");

    const [match] = await db.select().from(matches);
    expect(match).toMatchObject({ userId, status: "notified", stageReached: "deep_match", recommendation: "good_fit" });
    expect(buttons(result).map((b) => b.callback_data ?? b.url)).toEqual([
      encodeCallback({ type: "feedback", matchId: match!.id, verdict: "interested" }),
      encodeCallback({ type: "feedback", matchId: match!.id, verdict: "not_interested" }),
      encodeCallback({ type: "tailor_cv", matchId: match!.id }),
      "https://careers.acme.com/jobs/hrbp",
    ]);

    const [job] = await db.select().from(jobs).innerJoin(jobSources, eq(jobSources.id, jobs.sourceId));
    expect(job!.job_sources).toMatchObject({ key: USER_SUBMITTED_SOURCE_KEY, kind: "manual" });
    expect(job!.jobs).toMatchObject({ title: "HR Business Partner", company: "Acme Ltd", sourceUrl: "https://careers.acme.com/jobs/hrbp" });
    const [raw] = await db.select().from(rawJobRecords);
    expect(raw!.payload as SubmittedPostingPayload).toMatchObject({ submittedBy: userId, method: "json_ld", url: "https://careers.acme.com/jobs/hrbp" });
    const stages = (await db.select().from(matchEvaluations)).map((e) => e.stage).sort();
    expect(stages).toEqual(["cheap_relevance", "deep_match", "hard_filter"]);
    expect(await db.select().from(userJobSites)).toHaveLength(0);
  });

  it("reuses the job and match when the same link is sent again", async () => {
    pages["https://careers.acme.com/jobs/hrbp"] = () => html(jsonLdPage(hrbpPosting));
    await send(textUpdate("https://careers.acme.com/jobs/hrbp"));
    await send(textUpdate("https://careers.acme.com/jobs/hrbp#apply"));

    expect(sent().at(-1)!.text).toContain(jobLinks.known);
    expect(await db.select().from(jobs)).toHaveLength(1);
    expect(await db.select().from(matches)).toHaveLength(1);
    expect(matcher.calls).toHaveLength(1);
  });

  it("joins a posting already known from another source and reuses the user's match", async () => {
    const [source] = await db.insert(jobSources).values({ key: "web_search", name: "Web", kind: "web_search" }).returning();
    const [raw] = await db
      .insert(rawJobRecords)
      .values({ sourceId: source!.id, sourceUrl: "https://www.linkedin.example/jobs/1", contentHash: "h", payload: {} })
      .returning();
    const [group] = await db.insert(duplicateGroups).values({ dedupKey: "human resources business partner|acme|tel aviv" }).returning();
    const [job] = await db
      .insert(jobs)
      .values({
        sourceId: source!.id,
        rawRecordId: raw!.id,
        sourceUrl: raw!.sourceUrl,
        title: "HR Business Partner",
        company: "Acme",
        location: "Tel Aviv",
        description: "Partner with engineering leaders.",
        collectedAt: NOW,
        normalizedTitle: "human resources business partner",
        normalizedCompany: "acme",
        normalizedLocation: "tel aviv",
        duplicateGroupId: group!.id,
        dedupMethod: "deterministic_key",
      })
      .returning();
    await db.update(duplicateGroups).set({ canonicalJobId: job!.id });
    await db.insert(matches).values({
      userId,
      duplicateGroupId: group!.id,
      jobId: job!.id,
      status: "ready",
      stageReached: "deep_match",
      recommendation: "strong_fit",
      explanation: "Already evaluated.",
    });
    pages["https://careers.acme.com/jobs/hrbp"] = () => html(jsonLdPage(hrbpPosting));

    await send(textUpdate("https://careers.acme.com/jobs/hrbp"));

    expect(sent().at(-1)!.text).toContain("Already evaluated.");
    const allMatches = await db.select().from(matches);
    expect(allMatches).toHaveLength(1);
    expect(allMatches[0]!.status).toBe("notified");
    const grouped = await db.select({ group: jobs.duplicateGroupId }).from(jobs);
    expect(grouped.map((g) => g.group)).toEqual([group!.id, group!.id]);
    expect(matcher.calls).toHaveLength(0);
  });

  it("reuses a board job for an ATS link without fetching anything", async () => {
    const [source] = await db.insert(jobSources).values({ key: "greenhouse", name: "Greenhouse", kind: "api" }).returning();
    const [raw] = await db
      .insert(rawJobRecords)
      .values({ sourceId: source!.id, sourceUrl: "https://boards.greenhouse.io/acme/jobs/123", contentHash: "h", payload: {} })
      .returning();
    const [group] = await db.insert(duplicateGroups).values({ dedupKey: "k" }).returning();
    const [job] = await db
      .insert(jobs)
      .values({
        sourceId: source!.id,
        rawRecordId: raw!.id,
        externalId: "acme:123",
        sourceUrl: raw!.sourceUrl,
        title: "HR Business Partner",
        company: "Acme",
        description: "People partner for R&D.",
        collectedAt: NOW,
        duplicateGroupId: group!.id,
        dedupMethod: "deterministic_key",
      })
      .returning();
    await db.update(duplicateGroups).set({ canonicalJobId: job!.id });

    await send(textUpdate("https://job-boards.greenhouse.io/acme/jobs/123"));

    expect(requested).toEqual([]);
    expect(sent().at(-1)!.text).toContain(jobLinks.known);
    expect(matcher.calls.map((j) => j.title)).toEqual(["HR Business Partner"]);
  });

  it("reads an unknown ATS posting through the board's API", async () => {
    const id = "6f1c2a9e-1b2c-4d5e-8f90-123456789abc";
    pages[`https://api.lever.co/v0/postings/justt/${id}?mode=json`] = () =>
      Response.json({
        id,
        text: "People Partner",
        hostedUrl: `https://jobs.lever.co/justt/${id}`,
        categories: { location: "Tel Aviv", commitment: "Full-time" },
        descriptionPlain: "Support managers on people topics.",
      });

    await send(textUpdate(`https://jobs.lever.co/justt/${id}/apply`));

    expect(sent().at(-1)!.text).toContain(jobLinks.fits);
    const [job] = await db.select().from(jobs);
    expect(job).toMatchObject({ title: "People Partner", externalId: `lever:justt:${id}`, employmentType: "full_time" });
    const [raw] = await db.select().from(rawJobRecords);
    expect((raw!.payload as SubmittedPostingPayload).method).toBe("ats_api");
    const [lever] = await db.select().from(jobSources).where(eq(jobSources.key, "lever"));
    expect(lever).toBeUndefined();
  });

  it("falls back to the model for pages without job data", async () => {
    pages["https://smallco.example/careers/ops"] = () => html("<html><body><h1>Ops lead</h1><p>Run operations.</p></body></html>");
    reader.result = { kind: "posting", fields: { title: "Operations Lead", description: "Run operations.", company: "SmallCo" } };

    await send(textUpdate("https://smallco.example/careers/ops"));

    expect(reader.extracted).toEqual(["https://smallco.example/careers/ops"]);
    expect(sent().at(-1)!.text).toContain("Operations Lead");
    const [raw] = await db.select().from(rawJobRecords);
    expect((raw!.payload as SubmittedPostingPayload).method).toBe("llm");
  });

  it("explains closed, missing, gated, private and non-job links without storing anything", async () => {
    pages["https://a.example/closed"] = () => html(jsonLdPage({ ...hrbpPosting, validThrough: "2026-01-01" }));
    pages["https://a.example/login-wall"] = () => new Response(null, { status: 302, headers: { location: "https://a.example/login?next=/job" } });
    pages["https://a.example/login?next=/job"] = () => html("<form>Sign in</form>");
    pages["https://a.example/forbidden"] = () => new Response("no", { status: 401 });
    pages["https://a.example/blog"] = () => html("<p>Our culture</p>");
    pages["https://a.example/pdf"] = () => new Response("%PDF", { headers: { "content-type": "application/pdf" } });

    const cases: [string, string][] = [
      ["https://a.example/closed", "closed or expired"],
      ["https://a.example/gone", "no longer exists"],
      ["https://a.example/login-wall", "needs a login"],
      ["https://a.example/forbidden", "needs a login"],
      ["https://a.example/blog", "couldn't find a single open job posting"],
      ["https://a.example/pdf", "couldn't find a single open job posting"],
      ["http://169.254.169.254/latest/meta-data", "public web page"],
    ];
    for (const [link, reply] of cases) {
      await send(textUpdate(link));
      expect(sent().at(-1)!.text, link).toContain(reply);
    }
    expect(requested).not.toContain("http://169.254.169.254/latest/meta-data");
    expect(await db.select().from(jobs)).toHaveLength(0);
    expect(await db.select().from(matches)).toHaveLength(0);
  });

  it("names each link when several are sent", async () => {
    pages["https://careers.acme.com/jobs/hrbp"] = () => html(jsonLdPage(hrbpPosting));
    pages["https://news.example/story"] = () => html("<p>news</p>");

    await send(textUpdate("https://careers.acme.com/jobs/hrbp and https://news.example/story"));

    const texts = sent().map((p) => p.text as string);
    expect(texts.some((t) => t.includes(jobLinks.fits))).toBe(true);
    expect(texts.at(-1)).toContain("<b>news.example</b>: I couldn't find a single open job posting");
    expect(await db.select().from(jobs)).toHaveLength(1);
  });

  it("stops at a broken must-have without a deep match", async () => {
    await db.insert(preferences).values({
      userId,
      kind: "hard_constraint",
      dimension: "location",
      label: "Haifa only",
      value: { type: "location", places: ["Haifa"] },
      status: "active",
      origin: "onboarding",
      decidedAt: new Date(),
    });
    pages["https://careers.acme.com/jobs/hrbp"] = () => html(jsonLdPage(hrbpPosting));

    await send(textUpdate("https://careers.acme.com/jobs/hrbp"));

    const result = sent().at(-1)!.text as string;
    expect(result).toContain(jobLinks.failsMustHave.slice(0, 30));
    expect(result).toContain("Haifa only");
    expect(matcher.calls).toHaveLength(0);
    const [match] = await db.select().from(matches);
    expect(match).toMatchObject({ status: "filtered_out", stageReached: "hard_filter" });
  });

  it("deep-matches a requested job even below the relevance threshold", async () => {
    pages["https://bakery.example/jobs/baker"] = () =>
      html(jsonLdPage({ title: "Night Baker", description: "Bake sourdough bread overnight.", hiringOrganization: { name: "Bakery" } }));

    await send(textUpdate("https://bakery.example/jobs/baker"));

    expect(matcher.calls.map((j) => j.title)).toEqual(["Night Baker"]);
    const [relevance] = await db.select().from(matchEvaluations).where(eq(matchEvaluations.stage, "cheap_relevance"));
    expect(relevance!.outcome).toBe("rejected");
  });

  it("leaves the match pending for the daily run when evaluation fails", async () => {
    matcher.fail = true;
    pages["https://careers.acme.com/jobs/hrbp"] = () => html(jsonLdPage(hrbpPosting));

    await send(textUpdate("https://careers.acme.com/jobs/hrbp"));

    expect(sent().at(-1)!.text).toContain("couldn't evaluate it right now");
    const [match] = await db.select().from(matches);
    expect(match).toMatchObject({ status: "pending", stageReached: "cheap_relevance" });
  });

  it("leaves links to onboarding before the profile is confirmed", async () => {
    await db.update(careerProfiles).set({ status: "draft" });
    await send(textUpdate("https://careers.acme.com/jobs/hrbp"));
    expect(requested).toEqual([]);
    expect(sent().some((p) => String(p.text).includes("Reading"))).toBe(false);
  });
});
