import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawJob } from "../src/ingestion/adapter.js";
import { SourceBlockedError, type SearchContext } from "../src/ingestion/search.js";
import { jobmasterSource, postedAt, type JobMasterPosting } from "../src/ingestion/sources/jobmaster.js";
import { linkedinSource, type LinkedInPosting } from "../src/ingestion/sources/linkedin.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url), "utf8");

type Route = string | Response | ((url: string) => Response);

function stubFetch(route: (url: string) => Route | undefined) {
  const requested: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const found = route(url);
    if (found === undefined) return new Response("not found", { status: 404 });
    if (typeof found === "function") return found(url);
    return typeof found === "string" ? new Response(found, { status: 200 }) : found;
  }) as typeof globalThis.fetch;
  return { fetch, requested };
}

const context = (fetch: typeof globalThis.fetch, limit = 25): SearchContext => ({ fetch, limit });
const query = (url: string) => Object.fromEntries(new URL(url).searchParams);

describe("linkedin source", () => {
  const searchPage = fixture("linkedin-search.html");
  const detailPage = fixture("linkedin-job-detail.html");

  it("lists the cards of a guest search with canonical links", async () => {
    const { fetch, requested } = stubFetch((url) => (query(url).start === "0" ? searchPage : ""));
    const listed = await linkedinSource.search({ keywords: "Backend Engineer", location: null }, context(fetch));

    expect(listed.map((r) => r.externalId)).toEqual(["4453965671", "4463889539", "4472535624"]);
    expect(listed[1]).toEqual({
      externalId: "4463889539",
      sourceUrl: "https://www.linkedin.com/jobs/view/4463889539",
      payload: {
        card: {
          id: "4463889539",
          title: "Senior Backend Engineer - Edge Services",
          company: "Viz.ai",
          location: "Tel Aviv-Yafo, Tel Aviv District, Israel",
          postedOn: "2026-10-01",
          remote: false,
        },
        detail: null,
      },
    });
    expect(listed[0]!.payload.card).toMatchObject({ title: "Backend Software Developer", company: "Apono", postedOn: "2026-10-07" });
    expect(requested).toHaveLength(2);
    expect(query(requested[0]!)).toEqual({
      keywords: "Backend Engineer",
      location: "Israel",
      geoId: "101620260",
      f_TPR: "r604800",
      sortBy: "DD",
      start: "0",
    });
    expect(query(requested[1]!).start).toBe("10");
  });

  it("searches a place or remote work and stops paginating at the limit", async () => {
    const { fetch, requested } = stubFetch(() => searchPage);
    await linkedinSource.search({ keywords: "Data Engineer", location: "Haifa" }, context(fetch));
    expect(query(requested[0]!)).toMatchObject({ location: "Haifa, Israel" });
    expect(query(requested[0]!).geoId).toBeUndefined();

    requested.length = 0;
    const remote = await linkedinSource.search({ keywords: "Data Engineer", location: "Remote" }, context(fetch, 2));
    expect(remote).toHaveLength(2);
    expect(remote[0]!.payload.card.remote).toBe(true);
    expect(requested).toHaveLength(1);
    expect(query(requested[0]!)).toMatchObject({ location: "Israel", geoId: "101620260", f_WT: "2" });
  });

  it("stops on a 400 past the last page and reports blocking", async () => {
    let page = 0;
    const { fetch } = stubFetch(() => (page++ === 0 ? searchPage : new Response("", { status: 400 })));
    expect(await linkedinSource.search({ keywords: "x", location: null }, context(fetch))).toHaveLength(3);

    for (const status of [403, 429, 999]) {
      const blocked = stubFetch(() => ({ status, ok: false, url: "", headers: new Headers(), text: async () => "" }) as unknown as Response);
      await expect(linkedinSource.search({ keywords: "x", location: null }, context(blocked.fetch))).rejects.toBeInstanceOf(SourceBlockedError);
    }
  });

  async function listedCard(): Promise<RawJob<LinkedInPosting>> {
    const { fetch } = stubFetch((url) => (query(url).start === "0" ? searchPage : ""));
    return (await linkedinSource.search({ keywords: "x", location: null }, context(fetch))).find((r) => r.externalId === "4463889539")!;
  }

  it("fills in the description and criteria from the posting and normalizes it", async () => {
    const listed = await listedCard();
    const { fetch, requested } = stubFetch((url) => (url.endsWith("/jobPosting/4463889539") ? detailPage : undefined));
    const full = await linkedinSource.details!(listed, context(fetch));

    expect(requested).toEqual(["https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4463889539"]);
    expect(full!.payload.detail!.criteria).toEqual({
      "Seniority level": "Not Applicable",
      "Employment type": "Full-time",
      Industries: "Hospitals and Health Care",
    });
    const fields = linkedinSource.normalize(full!);
    expect(fields).toMatchObject({
      title: "Senior Backend Engineer - Edge Services",
      company: "Viz.ai",
      location: "Tel Aviv-Yafo, Tel Aviv District, Israel",
      employmentType: "full_time",
      workMode: null,
      publishedAt: new Date("2026-10-01"),
    });
    expect(fields!.description).toMatch(/^About Viz\.ai\n/);
    expect(fields!.description).not.toContain("Show more");
    expect(linkedinSource.normalize(listed)).toBeNull();
  });

  it("treats a missing or closed posting as gone and a sign-in redirect as blocked", async () => {
    const listed = await listedCard();
    const gone = stubFetch(() => undefined);
    expect(await linkedinSource.details!(listed, context(gone.fetch))).toBeNull();

    const closed = stubFetch(() => detailPage.replace("Employment type", "No longer accepting applications"));
    expect(await linkedinSource.details!(listed, context(closed.fetch))).toBeNull();

    const authwall = stubFetch(() => () => {
      const response = new Response("<html>Sign in</html>", { status: 200 });
      Object.defineProperty(response, "url", { value: "https://www.linkedin.com/authwall?trk=x" });
      return response;
    });
    await expect(linkedinSource.details!(listed, context(authwall.fetch))).rejects.toBeInstanceOf(SourceBlockedError);
  });
});

describe("jobmaster source", () => {
  const searchPage = fixture("jobmaster-search.html");
  const detailPage = fixture("jobmaster-detail.html");
  const NOW = new Date("2026-10-08T12:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists the result cards newest first", async () => {
    const { fetch, requested } = stubFetch(() => searchPage);
    const listed = await jobmasterSource.search({ keywords: "backend", location: null }, context(fetch));

    expect(requested).toEqual(["https://www.jobmaster.co.il/jobs/?q=backend"]);
    expect(listed.map((r) => r.externalId)).toEqual(["9845113", "9890344", "9804600"]);
    expect(listed[0]).toEqual({
      externalId: "9845113",
      sourceUrl: "https://www.jobmaster.co.il/jobs/checknum.asp?key=9845113",
      payload: {
        card: {
          id: "9845113",
          title: "Backend SW Engineer",
          company: "גוב פלייס",
          location: "יקנעם עילית",
          type: "משרה מלאה",
          posted: "פורסם לפני 3 שעות",
          postedAt: "2026-10-08T09:00:00.000Z",
        },
        detail: null,
      },
    });
    expect(listed[1]!.payload.card).toMatchObject({ title: "Senior NET Backend Developer", company: null, location: "תל אביב יפו" });
    expect(listed[2]!.payload.card).toMatchObject({ title: "מפתח/ת C++ Backend", company: "Experis", postedAt: "2026-09-30T12:00:00.000Z" });
  });

  it("searches a city or work from home and keeps to the limit", async () => {
    const { fetch, requested } = stubFetch(() => searchPage);
    expect(await jobmasterSource.search({ keywords: "backend", location: "חיפה" }, context(fetch, 2))).toHaveLength(2);
    await jobmasterSource.search({ keywords: "backend", location: "remote" }, context(fetch));
    expect(requested.map(query)).toEqual([{ q: "backend", l: "חיפה" }, { q: "backend עבודה מהבית" }]);
  });

  it("reports blocking and a sign-in redirect", async () => {
    const blocked = stubFetch(() => new Response("", { status: 403 }));
    await expect(jobmasterSource.search({ keywords: "x", location: null }, context(blocked.fetch))).rejects.toBeInstanceOf(SourceBlockedError);

    const login = stubFetch(() => () => {
      const response = new Response("<html></html>", { status: 200 });
      Object.defineProperty(response, "url", { value: "https://account.jobmaster.co.il/?r=x" });
      return response;
    });
    await expect(jobmasterSource.search({ keywords: "x", location: null }, context(login.fetch))).rejects.toBeInstanceOf(SourceBlockedError);
  });

  async function listedCard(): Promise<RawJob<JobMasterPosting>> {
    const { fetch } = stubFetch(() => searchPage);
    return (await jobmasterSource.search({ keywords: "x", location: null }, context(fetch)))[0]!;
  }

  it("fills in the description and requirements and normalizes them", async () => {
    const listed = await listedCard();
    const { fetch, requested } = stubFetch(() => detailPage);
    const full = await jobmasterSource.details!(listed, context(fetch));

    expect(requested).toEqual(["https://www.jobmaster.co.il/jobs/checknum.asp?key=9845113"]);
    expect(full!.payload.detail).toMatchObject({ location: "יקנעם עילית", type: "משרה מלאה" });
    const fields = jobmasterSource.normalize(full!);
    expect(fields).toMatchObject({
      title: "Backend SW Engineer",
      company: "גוב פלייס",
      location: "יקנעם עילית",
      employmentType: "full_time",
      workMode: null,
      publishedAt: new Date("2026-10-08T09:00:00Z"),
    });
    expect(fields!.description).toMatch(/^We are seeking a strong developer/);
    expect(fields!.description).toContain("\n\nB.Sc./B.A. in Computer Science");
    expect(jobmasterSource.normalize(listed)).toBeNull();
  });

  it("treats a removed posting as gone and maps Hebrew types", async () => {
    const listed = await listedCard();
    const gone = stubFetch(() => new Response(fixture("jobmaster-detail-gone-410.html"), { status: 410 }));
    expect(await jobmasterSource.details!(listed, context(gone.fetch))).toBeNull();

    const remotePart = stubFetch(() => detailPage.replace(">משרה מלאה</li>", ">משרה חלקית, עבודה מהבית</li>"));
    const full = await jobmasterSource.details!(listed, context(remotePart.fetch));
    expect(jobmasterSource.normalize(full!)).toMatchObject({ employmentType: "part_time", workMode: "remote" });
  });

  it("reads relative Hebrew posting times", () => {
    expect(postedAt("פורסם לפני 3 שעות", NOW)).toEqual(new Date("2026-10-08T09:00:00Z"));
    expect(postedAt("פורסם לפני 2 ימים", NOW)).toEqual(new Date("2026-10-06T12:00:00Z"));
    expect(postedAt("פורסם לפני שעה", NOW)).toEqual(new Date("2026-10-08T11:00:00Z"));
    expect(postedAt("פורסם אתמול", NOW)).toEqual(new Date("2026-10-07T12:00:00Z"));
    expect(postedAt("פורסם", NOW)).toBeNull();
  });
});
