import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawJob } from "../src/ingestion/adapter.js";
import { SourceBlockedError, type SearchContext } from "../src/ingestion/search.js";
import {
  alljobsSearchUrl,
  alljobsSource,
  locationFilter,
  parseAlljobsPage,
  type AlljobsJob,
} from "../src/ingestion/sources/alljobs.js";

const page = readFileSync(new URL("./fixtures/sources/alljobs-search.html", import.meta.url), "utf8");
const now = new Date("2026-10-08T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

const searchUrl = (keywords: string, n: number, filter = {}) => alljobsSearchUrl(keywords, filter, n);

function box(id: number, posted = "לפני 1 שעות"): string {
  return `<div class="job-box job-border-regular"><div id="job-box${id}"><div class="job-content-top-date">${posted}</div>
<div class="job-content-top-title "><div><a title="t" target="_blank" href="/Search/UploadSingle.aspx?JobID=${id}" class="N"><h2>Job ${id}</h2></a></div><div class="T14"></div></div>
<div class="job-content-top-location"><b>מיקום המשרה: </b><a href="/SearchResultsGuest.aspx?page=1&amp;position=&amp;type=&amp;city=779&amp;region=">תל אביב יפו</a></div>
<div class=" job-content-top-type"><b>סוג משרה: </b>משרה חלקית</div><div id="job-content-top-acord${id}"><div><div class="job-content-top-desc AR RTL"><div>Description ${id}</div><div></div></div></div></div></div>`;
}

function stubFetch(routes: Record<string, Response | (() => Response)>) {
  const requested: { url: string; cookie: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push({ url, cookie: new Headers(init?.headers).get("cookie") });
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    return typeof route === "function" ? route() : route;
  }) as typeof globalThis.fetch;
  return { fetch, requested };
}

const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html" } });
const context = (fetch: typeof globalThis.fetch, limit = 25): SearchContext => ({ fetch, limit });

describe("alljobs page parsing", () => {
  const jobs = parseAlljobsPage(page, now);

  it("reads every job box, including highlighted ones", () => {
    expect(jobs.map((j) => j.id)).toEqual(["8777982", "8843761", "8658009", "8822511", "8831056", "8799920"]);
  });

  it("collapses the whitespace search highlighting inserts into titles", () => {
    expect(jobs[0]!.title).toBe("לחברה פיננסית גדולה דרוש /ה backend & data Developer!");
    expect(jobs[3]!.title).toBe("Full Stack Developer");
  });

  it("reads the company and leaves it null for confidential postings", () => {
    expect(jobs.map((j) => j.company)).toEqual([
      "Nishapro",
      "ALLSTARSIT",
      "Special Job – חברת השמה בהייטק",
      "Alljobs Match",
      "Mertens – Malam Team",
      null,
    ]);
  });

  it("reads single, joined and hidden multi-city locations", () => {
    expect(jobs[0]!.cities).toEqual(["מודיעין מכבים רעות", "רחובות", "באר יעקב", "לוד", "יהוד מונוסון"]);
    expect(jobs[1]!.cities).toEqual(["בני ברק"]);
    expect(jobs[5]!.cities).toEqual(["Jerusalem", "Tel Aviv-Yafo"]);
  });

  it("reads single and listed job types", () => {
    expect(jobs[0]!.types).toEqual(["משרה מלאה"]);
    expect(jobs[1]!.types).toEqual(["משרה מלאה ועבודה היברידית"]);
    expect(jobs[3]!.types).toEqual(["Full Time and Hybrid work"]);
    expect(jobs[4]!.types[0]).toBe("משרה מלאה");
    expect(jobs[4]!.types).toHaveLength(5);
  });

  it("keeps the description with its requirements", () => {
    expect(jobs[0]!.description).toContain("ממוקמים בלוד");
    expect(jobs[0]!.description).toContain("דרישות:");
    expect(jobs[2]!.description).toContain("Requirements:");
  });

  it("resolves relative and absolute post dates", () => {
    expect(jobs.map((j) => j.postedAt)).toEqual([
      hoursAgo(21),
      hoursAgo(48),
      hoursAgo(21),
      hoursAgo(3),
      hoursAgo(24),
      "2026-08-27T00:00:00.000Z",
    ]);
  });

  it("returns nothing for a page without job boxes", () => {
    expect(parseAlljobsPage("<html><body>אין תוצאות</body></html>", now)).toEqual([]);
  });
});

describe("alljobs query", () => {
  it("builds the guest search url", () => {
    expect(searchUrl("מנהל מוצר", 2)).toBe(
      "https://www.alljobs.co.il/SearchResultsGuest.aspx?page=2&position=&type=&freetxt=%D7%9E%D7%A0%D7%94%D7%9C+%D7%9E%D7%95%D7%A6%D7%A8&city=&region=",
    );
    expect(searchUrl("backend", 1, { city: "779" })).toBe(
      "https://www.alljobs.co.il/SearchResultsGuest.aspx?page=1&position=&type=&freetxt=backend&city=779&region=",
    );
  });

  it("maps common places to cities and regions", () => {
    expect(locationFilter("Tel Aviv")).toEqual({ city: "779" });
    expect(locationFilter("Tel Aviv-Yafo, Israel")).toEqual({ city: "779" });
    expect(locationFilter("תל אביב יפו")).toEqual({ city: "779" });
    expect(locationFilter("Jerusalem")).toEqual({ city: "1056" });
    expect(locationFilter("ירושלים")).toEqual({ city: "1056" });
    expect(locationFilter("Haifa")).toEqual({ region: "1" });
    expect(locationFilter("Remote")).toEqual({ region: "11" });
    expect(locationFilter("work from home")).toEqual({ region: "11" });
    expect(locationFilter("עבודה מהבית")).toEqual({ region: "11" });
  });

  it("leaves unknown places and Israel-wide searches unfiltered", () => {
    expect(locationFilter(null)).toEqual({});
    expect(locationFilter("Israel")).toEqual({});
    expect(locationFilter("Eilat")).toEqual({});
  });
});

describe("alljobs search", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("lists postings newest first with the site's newest-first sort cookie", async () => {
    const { fetch, requested } = stubFetch({ [searchUrl("backend", 1)]: html(page.replace(/page=2&/g, "page=9&")) });
    const found = await alljobsSource.search({ keywords: "backend", location: null }, context(fetch));

    expect(requested).toHaveLength(1);
    expect(requested[0]!.cookie).toBe("sort=%7B%22ID%22%3A1%2C%22longitude%22%3A0%2C%22latitude%22%3A0%7D");
    expect(found.map((r) => r.externalId)).toEqual(["8822511", "8777982", "8658009", "8831056", "8843761", "8799920"]);
    expect(found[0]!.sourceUrl).toBe("https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID=8822511");
    expect(found.every((r) => r.payload.remote === false)).toBe(true);
  });

  it("filters by the mapped city", async () => {
    const { fetch, requested } = stubFetch({ [searchUrl("backend", 1, { city: "779" })]: html(box(1)) });
    const found = await alljobsSource.search({ keywords: "backend", location: "Tel Aviv" }, context(fetch));
    expect(requested.map((r) => r.url)).toEqual([searchUrl("backend", 1, { city: "779" })]);
    expect(found.map((r) => r.externalId)).toEqual(["1"]);
  });

  it("marks postings found in the work-from-home region as remote", async () => {
    const { fetch } = stubFetch({ [searchUrl("backend", 1, { region: "11" })]: html(box(1)) });
    const [raw] = await alljobsSource.search({ keywords: "backend", location: "remote" }, context(fetch));
    expect(raw!.payload.remote).toBe(true);
    expect(alljobsSource.normalize(raw!)?.workMode).toBe("remote");
  });

  it("pages until the limit, skipping postings already listed", async () => {
    const second = [box(1), box(2), box(8777982), box(3)].join("\n");
    const { fetch, requested } = stubFetch({ [searchUrl("backend", 1)]: html(page), [searchUrl("backend", 2)]: html(second) });
    const found = await alljobsSource.search({ keywords: "backend", location: null }, context(fetch, 8));

    expect(requested.map((r) => r.url)).toEqual([searchUrl("backend", 1), searchUrl("backend", 2)]);
    expect(found).toHaveLength(8);
    expect(new Set(found.map((r) => r.externalId)).size).toBe(8);
    expect(found.map((r) => r.externalId)).toContain("2");
    expect(found.map((r) => r.externalId)).not.toContain("3");
  });

  it("stops at the limit without fetching the next page", async () => {
    const { fetch, requested } = stubFetch({ [searchUrl("backend", 1)]: html(page) });
    const found = await alljobsSource.search({ keywords: "backend", location: null }, context(fetch, 2));
    expect(requested).toHaveLength(1);
    expect(found.map((r) => r.externalId)).toEqual(["8777982", "8843761"]);
  });

  it("stops when a page adds nothing new", async () => {
    const { fetch, requested } = stubFetch({ [searchUrl("backend", 1)]: html(page), [searchUrl("backend", 2)]: html(page) });
    const found = await alljobsSource.search({ keywords: "backend", location: null }, context(fetch));
    expect(requested).toHaveLength(2);
    expect(found).toHaveLength(6);
  });

  it("returns nothing when the search has no results", async () => {
    const { fetch } = stubFetch({ [searchUrl("nothing", 1)]: html("<html><body>לא נמצאו משרות</body></html>") });
    await expect(alljobsSource.search({ keywords: "nothing", location: null }, context(fetch))).resolves.toEqual([]);
  });

  it("reports blocking statuses and security pages as blocked", async () => {
    for (const response of [html("denied", 403), html("slow down", 429), html("<html>Please complete the captcha</html>")]) {
      const { fetch } = stubFetch({ [searchUrl("backend", 1)]: response });
      await expect(alljobsSource.search({ keywords: "backend", location: null }, context(fetch))).rejects.toBeInstanceOf(SourceBlockedError);
    }
  });

  it("fails other errors without marking the site blocked", async () => {
    const { fetch } = stubFetch({ [searchUrl("backend", 1)]: html("oops", 500) });
    const search = alljobsSource.search({ keywords: "backend", location: null }, context(fetch));
    await expect(search).rejects.toThrow("AllJobs search failed with 500");
    await expect(search).rejects.not.toBeInstanceOf(SourceBlockedError);
  });
});

describe("alljobs normalize", () => {
  const jobs = parseAlljobsPage(page, now);
  const raw = (job: Omit<AlljobsJob, "remote">, remote = false): RawJob<AlljobsJob> => ({
    externalId: job.id,
    sourceUrl: `https://www.alljobs.co.il/Search/UploadSingle.aspx?JobID=${job.id}`,
    payload: { ...job, remote },
  });

  it("normalizes a Hebrew posting", () => {
    const fields = alljobsSource.normalize(raw(jobs[0]!))!;
    expect(fields).toMatchObject({
      title: "לחברה פיננסית גדולה דרוש /ה backend & data Developer!",
      company: "Nishapro",
      location: "מודיעין מכבים רעות, רחובות, באר יעקב",
      workMode: null,
      employmentType: "full_time",
      publishedAt: new Date(hoursAgo(21)),
    });
    expect(fields.description).toMatch(/^ממוקמים בלוד, יום עבודה מהבית\.\n\nפיתוח ותכנון data Services/);
    expect(fields.description).toContain("דרישות:\nלפחות 3 שנות ניסיון בפיתוח backend");
    expect(fields.description).not.toMatch(/ {2}|<|&nbsp;/);
  });

  it("maps Hebrew and English hybrid job types", () => {
    expect(alljobsSource.normalize(raw(jobs[1]!))).toMatchObject({ workMode: "hybrid", employmentType: "full_time" });
    expect(alljobsSource.normalize(raw(jobs[3]!))).toMatchObject({ workMode: "hybrid", employmentType: "full_time" });
  });

  it("normalizes a confidential English posting", () => {
    expect(alljobsSource.normalize(raw(jobs[5]!))).toMatchObject({
      title: "Mid-Level backend Engineer",
      company: null,
      location: "Jerusalem, Tel Aviv-Yafo",
      workMode: null,
      employmentType: "full_time",
      publishedAt: new Date("2026-08-27T00:00:00Z"),
    });
  });

  it("maps other Hebrew employment types", () => {
    const base = jobs[0]!;
    const typed = (types: string[]) => alljobsSource.normalize(raw({ ...base, types }))?.employmentType;
    expect(typed(["משרה חלקית"])).toBe("part_time");
    expect(typed(["פרילנס"])).toBe("freelance");
    expect(typed(["משרה זמנית"])).toBe("temporary");
    expect(typed(["Part Time"])).toBe("part_time");
    expect(typed([])).toBeNull();
    expect(alljobsSource.normalize(raw({ ...base, types: ["עבודה מהבית"] }))?.workMode).toBe("remote");
  });
});
