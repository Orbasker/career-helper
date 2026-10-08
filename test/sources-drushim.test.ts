import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SourceBlockedError } from "../src/ingestion/search.js";
import { drushimSource } from "../src/ingestion/sources/drushim.js";

const page = JSON.parse(readFileSync(new URL("./fixtures/sources/drushim-search.json", import.meta.url), "utf8"));

function stubFetch(respond: (url: URL) => Response) {
  const requested: URL[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requested.push(url);
    return respond(url);
  }) as typeof globalThis.fetch;
  return { fetch, requested };
}

describe("drushim source", () => {
  it("searches the API by keywords and lists postings with full descriptions", async () => {
    const { fetch, requested } = stubFetch(() => Response.json({ ...page, TotalPagesNumber: 1 }));
    const found = await drushimSource.search({ keywords: "backend", location: "Tel Aviv" }, { fetch, limit: 25 });

    expect(requested.map((u) => `${u.origin}${u.pathname}`)).toEqual(["https://webapi.drushim.co.il/api/jobs/search"]);
    expect(Object.fromEntries(requested[0]!.searchParams)).toEqual({ SearchTerm: "backend", ssaen: "1", isAA: "true" });
    expect(found.map((r) => [r.externalId, r.sourceUrl])).toEqual([
      ["38385437", "https://www.drushim.co.il/job/38385437/ddf818d5/"],
      ["38605799", "https://www.drushim.co.il/job/38605799/5c97e4d5/"],
    ]);

    const job = drushimSource.normalize(found[0]!)!;
    expect(job).toMatchObject({
      title: "דרוש/ה מפתח/ת Backend עם ניסיון בדיגיטל",
      company: "matrix (בנקאות)",
      location: "Holon, Bat Yam, Ramat Gan",
      workMode: "hybrid",
      employmentType: "full_time",
    });
    expect(job.description).toContain("כתיבת קוד עבור מגוון רכיבי צד שרת");
    expect(job.description).toContain("6 שנות ניסיון לפחות בפיתוח JAVA");
    expect(job.publishedAt).toBeInstanceOf(Date);
  });

  it("filters to work from home for remote queries and pages until the limit", async () => {
    const second = { ...page, ResultList: page.ResultList.map((job: any) => ({ ...job, Code: job.Code + 1 })) };
    const { fetch, requested } = stubFetch((url) => Response.json(url.searchParams.get("page") ? second : page));
    const found = await drushimSource.search({ keywords: "data analyst", location: "Remote" }, { fetch, limit: 3 });

    expect(found.map((r) => r.externalId)).toEqual(["38385437", "38605799", "38385438"]);
    expect(requested.map((u) => [u.searchParams.get("scope"), u.searchParams.get("page")])).toEqual([
      ["5", null],
      ["5", "1"],
    ]);
  });

  it("stops at the last page, skips expired postings and reports blocks", async () => {
    const expired = { ...page, TotalPagesNumber: 1, ResultList: [{ ...page.ResultList[0], JobInfo: { ...page.ResultList[0].JobInfo, IsExpired: true } }] };
    const { fetch, requested } = stubFetch(() => Response.json(expired));
    expect(await drushimSource.search({ keywords: "x", location: null }, { fetch, limit: 25 })).toEqual([]);
    expect(requested).toHaveLength(1);

    const blocked = stubFetch(() => new Response("denied", { status: 403 }));
    await expect(drushimSource.search({ keywords: "x", location: null }, { fetch: blocked.fetch, limit: 25 })).rejects.toThrow(SourceBlockedError);
    const failing = stubFetch(() => new Response("oops", { status: 500 }));
    await expect(drushimSource.search({ keywords: "x", location: null }, { fetch: failing.fetch, limit: 25 })).rejects.toThrow(/500/);
  });
});
