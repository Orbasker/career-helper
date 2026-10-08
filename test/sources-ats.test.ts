import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { jobSources } from "../src/db/schema.js";
import { addBoards, atsBoardFromUrl, atsPostingFromUrl } from "../src/discovery/ats.js";
import { toCanonicalJob, type CollectContext, type JobSourceAdapter, type RawJob } from "../src/ingestion/adapter.js";
import { comeetAdapter } from "../src/ingestion/sources/comeet.js";
import { smartRecruitersAdapter } from "../src/ingestion/sources/smartrecruiters.js";
import { workableAdapter } from "../src/ingestion/sources/workable.js";
import { israelFacet, workdayAdapter } from "../src/ingestion/sources/workday.js";
import { createTestDb } from "./support/db.js";

const text = (name: string) => readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url), "utf8");
const fixture = (name: string): any => JSON.parse(text(name));

type Route = unknown | ((url: string, init?: RequestInit) => Response);

function stubFetch(routes: Record<string, Route>) {
  const requested: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(init?.method === "POST" ? `POST ${url} ${init.body}` : url);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    return typeof route === "function" ? route(url, init) : Response.json(route);
  }) as typeof globalThis.fetch;
  return { fetch, requested };
}

async function collectAll<T>(
  adapter: JobSourceAdapter<T>,
  config: Record<string, unknown>,
  fetch: typeof globalThis.fetch,
  since: Date | null = null,
) {
  const errors: { scope: string; error: string }[] = [];
  const ctx: CollectContext = {
    since,
    config: { requestIntervalMs: 0, ...config },
    fetch,
    reportError: (scope, error) => errors.push({ scope, error: (error as Error).message }),
  };
  const records: RawJob<T>[] = [];
  for await (const raw of adapter.collect(ctx)) records.push(raw);
  return { records, errors };
}

const collectedAt = new Date("2026-10-08T10:00:00Z");
const canonical = <T>(adapter: JobSourceAdapter<T>, records: RawJob<T>[]) =>
  records.map((raw) => {
    const result = toCanonicalJob(adapter, raw, collectedAt);
    if (result.ok === true) {
      const { rawRef, collectedAt: _, ...job } = result.job;
      return job;
    }
    return result;
  });

describe("comeet adapter", () => {
  const page = "https://www.comeet.com/jobs/silverfort/54.007";
  const api =
    "https://www.comeet.co/careers-api/2.0/company/54.007/positions?token=ABC123&details=true";

  it("reads the API token from the careers page and normalizes every position", async () => {
    const { fetch, requested } = stubFetch({
      [page]: () => new Response(text("comeet-careers-page.html")),
      [api]: fixture("comeet-positions.json"),
    });
    const { records, errors } = await collectAll(comeetAdapter, { boards: ["silverfort/54.007"] }, fetch);

    expect(requested).toEqual([page, api]);
    expect(errors).toEqual([]);
    expect(records[0]).toMatchObject({
      externalId: "silverfort/54.007:72.E6C",
      payload: { board: "silverfort/54.007", company: null, posting: { uid: "72.E6C" } },
    });
    expect(canonical(comeetAdapter, records)).toEqual([
      {
        source: "comeet",
        externalId: "silverfort/54.007:72.E6C",
        sourceUrl: "https://www.comeet.com/jobs/silverfort/54.007/devops-platform-engineer/72.E6C",
        title: "DevOps Platform Engineer",
        company: "Silverfort",
        description: "Description\nJoin our R&D team.\n\nRequirements\n- 5+ years as a DevOps Engineer\n- Kubernetes & Terraform",
        location: "Tel Aviv, Israel",
        workMode: "hybrid",
        employmentType: null,
        publishedAt: new Date("2026-09-08T11:04:25Z"),
      },
      {
        source: "comeet",
        externalId: "silverfort/54.007:CB.F60",
        sourceUrl: "https://www.comeet.com/jobs/silverfort/54.007/channel-account-manager---south-east/CB.F60",
        title: "Channel Account Manager - South East",
        company: "Silverfort",
        description: "Description\nGrow channel sales in the South East.",
        location: "United States",
        workMode: "remote",
        employmentType: null,
        publishedAt: new Date("2026-09-18T05:42:22Z"),
      },
    ]);
  });

  it("uses a configured API token and company without loading the careers page", async () => {
    const { fetch, requested } = stubFetch({ [api]: fixture("comeet-positions.json") });
    const { records } = await collectAll(
      comeetAdapter,
      { boards: [{ token: "silverfort/54.007", company: "Silverfort Ltd", apiToken: "ABC123" }] },
      fetch,
    );
    expect(requested).toEqual([api]);
    expect(comeetAdapter.normalize(records[0]!)?.company).toBe("Silverfort Ltd");
  });

  it("reports boards whose page has no token or whose company is gone and keeps collecting", async () => {
    const { fetch } = stubFetch({
      "https://www.comeet.com/jobs/acme/AA.111": () => new Response("<html>no data</html>"),
      "https://www.comeet.com/jobs/gone/BB.222": () => new Response(text("comeet-careers-page.html").replace("54.007\"", "BB.222\"")),
      "https://www.comeet.co/careers-api/2.0/company/BB.222/positions?token=ABC123&details=true":
        () => Response.json(fixture("comeet-position-gone-404.json"), { status: 404 }),
      [page]: () => new Response(text("comeet-careers-page.html")),
      [api]: fixture("comeet-positions.json"),
    });
    const { records, errors } = await collectAll(
      comeetAdapter,
      { boards: ["acme/AA.111", "gone/BB.222", "not-a-board", "silverfort/54.007"] },
      fetch,
    );

    expect(records).toHaveLength(2);
    expect(errors.map((e) => e.scope)).toEqual(["board:acme/AA.111", "board:gone/BB.222", "board:not-a-board"]);
    expect(errors[0]!.error).toBe("No Comeet API token on https://www.comeet.com/jobs/acme/AA.111");
    expect(errors[1]!.error).toMatch(/failed with 404$/);
  });
});

describe("workable adapter", () => {
  const url = "https://apply.workable.com/api/v1/widget/accounts/rayzone-group?details=true";

  it("collects the account's jobs and normalizes them", async () => {
    const { fetch, requested } = stubFetch({ [url]: fixture("workable-widget.json") });
    const { records, errors } = await collectAll(workableAdapter, { boards: ["rayzone-group"] }, fetch);

    expect(requested).toEqual([url]);
    expect(errors).toEqual([]);
    expect(records[0]).toMatchObject({
      externalId: "rayzone-group:3CF7F81189",
      payload: { board: "rayzone-group", company: "Rayzone Group", posting: { shortcode: "3CF7F81189" } },
    });
    expect(canonical(workableAdapter, records)).toEqual([
      {
        source: "workable",
        externalId: "rayzone-group:3CF7F81189",
        sourceUrl: "https://apply.workable.com/rayzone-group/j/3CF7F81189/",
        title: "Field Systems & Integration Engineer - DDRF (Rayzone Group Subsidiary )",
        company: "Rayzone Group",
        description: "Integrate field systems.\n\n- RF experience",
        location: "Tel Aviv-Yafo, Israel",
        workMode: null,
        employmentType: "full_time",
        publishedAt: new Date("2026-09-16"),
      },
      {
        source: "workable",
        externalId: "rayzone-group:C8C39F90A1",
        sourceUrl: "https://apply.workable.com/rayzone-group/j/C8C39F90A1/",
        title: "Asset Management Specialist",
        company: "Rayzone Group",
        description: "Own our asset lifecycle.",
        location: "Tel Aviv-Yafo, Israel",
        workMode: "remote",
        employmentType: null,
        publishedAt: new Date("2026-05-17"),
      },
    ]);
  });

  it("prefers the configured company and isolates a failing account", async () => {
    const { fetch } = stubFetch({ [url]: fixture("workable-widget.json") });
    const { records, errors } = await collectAll(
      workableAdapter,
      { boards: ["missing", { token: "rayzone-group", company: "Rayzone" }] },
      fetch,
    );
    expect(records.map((r) => workableAdapter.normalize(r)?.company)).toEqual(["Rayzone", "Rayzone"]);
    expect(errors).toEqual([
      {
        scope: "board:missing",
        error: "GET https://apply.workable.com/api/v1/widget/accounts/missing?details=true failed with 404",
      },
    ]);
  });
});

describe("smartrecruiters adapter", () => {
  const api = "https://api.smartrecruiters.com/v1/companies/wix2/postings";
  const list = `${api}?limit=100&offset=0&country=il`;
  const detail = fixture("smartrecruiters-posting-detail.json");
  const [newest, middle, oldest] = (fixture("smartrecruiters-postings.json").content as { id: string }[]).map((p) => p.id);

  it("lists Israeli postings, reads each detail and skips gone or inactive ones", async () => {
    const { fetch, requested } = stubFetch({
      [list]: fixture("smartrecruiters-postings.json"),
      [`${api}/${newest}`]: detail,
      [`${api}/${middle}`]: () => Response.json({ message: "not found" }, { status: 404 }),
      [`${api}/${oldest}`]: { ...detail, id: oldest, active: false },
    });
    const { records, errors } = await collectAll(smartRecruitersAdapter, { boards: ["wix2"] }, fetch);

    expect(requested).toEqual([list, `${api}/${newest}`, `${api}/${middle}`, `${api}/${oldest}`]);
    expect(errors).toEqual([]);
    expect(records[0]).toMatchObject({ payload: { board: "wix2", company: null, posting: { id: newest } } });
    expect(canonical(smartRecruitersAdapter, records)).toEqual([
      {
        source: "smartrecruiters",
        externalId: `wix2:${newest}`,
        sourceUrl: "https://jobs.smartrecruiters.com/Wix2/744000152028049-xengineer-backend-oriented-premium-billing-platform",
        title: "xEngineer (Backend oriented), Premium Billing Platform",
        company: "Wix",
        description:
          "Job Description\nDesign scalable billing services.\n\nQualifications\n• 4+ years of backend experience\n• Strong fundamentals",
        location: "Tel Aviv-Yafo, Israel",
        workMode: "onsite",
        employmentType: "full_time",
        publishedAt: new Date("2026-09-27T13:59:55.750Z"),
      },
    ]);
  });

  it("caps detail reads per board, newest first, and only reads postings released since the last run", async () => {
    const routes = {
      [list]: fixture("smartrecruiters-postings.json"),
      [`${api}/${newest}`]: detail,
      [`${api}/${middle}`]: { ...detail, id: middle },
      [`${api}/${oldest}`]: { ...detail, id: oldest },
    };
    const capped = stubFetch(routes);
    await collectAll(smartRecruitersAdapter, { boards: ["wix2"], maxDetailsPerBoard: 2 }, capped.fetch);
    expect(capped.requested).toEqual([list, `${api}/${newest}`, `${api}/${middle}`]);

    const recent = stubFetch(routes);
    const { records } = await collectAll(smartRecruitersAdapter, { boards: ["wix2"] }, recent.fetch, new Date("2026-09-15T12:00:00Z"));
    expect(recent.requested).toEqual([list, `${api}/${newest}`, `${api}/${middle}`]);
    expect(records.map((r) => r.externalId)).toEqual([`wix2:${newest}`, `wix2:${middle}`]);
  });

  it("pages through every country when the board opts out of the Israel filter", async () => {
    const postings = Array.from({ length: 100 }, (_, i) => ({ id: `p${i}`, name: "Role", releasedDate: "2026-09-01T00:00:00Z" }));
    const { fetch, requested } = stubFetch({
      [`${api}?limit=100&offset=0`]: { totalFound: 101, content: postings },
      [`${api}?limit=100&offset=100`]: { totalFound: 101, content: [{ ...postings[0], id: "p100" }] },
      [`${api}/p0`]: { ...detail, id: "p0" },
    });
    const { records, errors } = await collectAll(
      smartRecruitersAdapter,
      { boards: [{ token: "wix2", country: null }], maxDetailsPerBoard: 1 },
      fetch,
    );
    expect(requested).toEqual([`${api}?limit=100&offset=0`, `${api}?limit=100&offset=100`, `${api}/p0`]);
    expect(records).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("reports a failing detail without dropping the board, and a failing board without stopping the run", async () => {
    const { fetch } = stubFetch({
      [list]: fixture("smartrecruiters-postings.json"),
      [`${api}/${newest}`]: () => new Response("forbidden", { status: 403 }),
      [`${api}/${middle}`]: detail,
    });
    const { records, errors } = await collectAll(smartRecruitersAdapter, { boards: ["gone", "wix2"], maxDetailsPerBoard: 2 }, fetch);
    expect(records).toHaveLength(1);
    expect(errors.map((e) => e.scope)).toEqual(["board:gone", `posting:wix2:${newest}`]);
  });

  it("normalizes remote and hybrid locations", () => {
    const base = { board: "wix2", company: "Wix", posting: { ...detail } };
    const normalize = (location: unknown) =>
      smartRecruitersAdapter.normalize({ sourceUrl: "x", payload: { ...base, posting: { ...detail, location } } });
    expect(normalize({ country: "us", remote: true, hybrid: false })).toMatchObject({ location: "United States", workMode: "remote" });
    expect(normalize({ city: "Haifa", country: "il", hybrid: true })).toMatchObject({ location: "Haifa, Israel", workMode: "hybrid" });
  });
});

describe("workday adapter", () => {
  const board = "nvidia.wd5/NVIDIAExternalCareerSite";
  const api = "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite";
  const israel = { locationHierarchy1: ["2fcb99c455831013ea52bbe14cf9326c"] };
  const detail = fixture("workday-job-detail.json");
  const search = (appliedFacets: object, offset: number) =>
    `POST ${api}/jobs ${JSON.stringify({ appliedFacets, limit: 20, offset, searchText: "" })}`;
  const item = (i: number, postedOn = "Posted Today") => ({
    title: `Role ${i}`,
    externalPath: `/job/Israel-Yokneam/Role_JR${i}`,
    locationsText: "Israel, Yokneam",
    postedOn,
    bulletFields: [`JR${i}`],
  });

  function workdayRoutes(items: ReturnType<typeof item>[]) {
    const routes: Record<string, Route> = {
      [`${api}/jobs`]: (_url: string, init?: RequestInit) => {
        const { appliedFacets, offset } = JSON.parse(String(init!.body));
        if (Object.keys(appliedFacets).length === 0) return Response.json(fixture("workday-jobs.json"));
        expect(appliedFacets).toEqual(israel);
        const page = items.slice(offset, offset + 20);
        return Response.json(offset === 0 ? { total: items.length, jobPostings: page, facets: [] } : { jobPostings: page });
      },
    };
    for (const [i, it] of items.entries()) {
      routes[`${api}${it.externalPath}`] =
        i === 1
          ? () => Response.json(fixture("workday-job-gone-404.json"), { status: 404 })
          : { ...detail, jobPostingInfo: { ...detail.jobPostingInfo, id: `id${i}` } };
    }
    return routes;
  }

  it("filters to the Israel location facet, pages through results and skips gone postings", async () => {
    const items = Array.from({ length: 25 }, (_, i) => item(i));
    const { fetch, requested } = stubFetch(workdayRoutes(items));
    const { records, errors } = await collectAll(workdayAdapter, { boards: [board] }, fetch);

    expect(errors).toEqual([]);
    expect(requested.filter((r) => r.startsWith("POST"))).toEqual([search({}, 0), search(israel, 0), search(israel, 20)]);
    expect(requested.filter((r) => !r.startsWith("POST"))).toHaveLength(25);
    expect(records).toHaveLength(24);
    expect(records[0]).toMatchObject({ externalId: `${board}:id0`, payload: { board, company: "Nvidia" } });
    expect(canonical(workdayAdapter, records.slice(0, 1))).toEqual([
      {
        source: "workday",
        externalId: `${board}:id0`,
        sourceUrl: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Israel-Raanana/Senior-Software-Developer_JR2015559",
        title: "Senior Software Developer",
        company: "Nvidia",
        description: "Join our AI networking acceleration team.\n\n- C++\n- RDMA",
        location: "Raanana, Israel",
        workMode: null,
        employmentType: "full_time",
        publishedAt: new Date("2026-10-08"),
      },
    ]);
  });

  it("caps detail reads per board and skips postings older than the last run", async () => {
    const items = [item(0, "Posted 30+ Days Ago"), item(1), item(2, "Posted Yesterday"), item(3), item(4), ...Array.from({ length: 20 }, (_, i) => item(i + 5))];
    const { fetch, requested } = stubFetch(workdayRoutes(items));
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const { records } = await collectAll(workdayAdapter, { boards: [{ token: board, company: "NVIDIA" }], maxDetailsPerBoard: 3 }, fetch, since);

    expect(requested).toEqual([search({}, 0), search(israel, 0), `${api}/job/Israel-Yokneam/Role_JR1`, `${api}/job/Israel-Yokneam/Role_JR2`, `${api}/job/Israel-Yokneam/Role_JR3`]);
    expect(records.map((r) => [r.externalId, r.payload.company])).toEqual([
      [`${board}:id2`, "NVIDIA"],
      [`${board}:id3`, "NVIDIA"],
    ]);
  });

  it("reports a board without an Israel location facet and keeps collecting", async () => {
    const { fetch } = stubFetch({
      "https://acme.wd1.myworkdayjobs.com/wday/cxs/acme/Careers/jobs": { total: 1, jobPostings: [], facets: [] },
      ...workdayRoutes([item(0)]),
    });
    const { records, errors } = await collectAll(workdayAdapter, { boards: ["acme.wd1/Careers", "bad-token", board] }, fetch);
    expect(records).toHaveLength(1);
    expect(errors).toEqual([
      { scope: "board:acme.wd1/Careers", error: "No Israel location facet on Workday board acme.wd1/Careers" },
      { scope: "board:bad-token", error: 'Workday board "bad-token" is not {tenant}.{wdN}/{site}' },
    ]);
  });

  it("prefers a country facet, then a location hierarchy, then sites", () => {
    const facets = fixture("workday-jobs.json").facets;
    expect(israelFacet(facets)).toEqual(israel);
    expect(
      israelFacet([
        ...facets,
        { facetParameter: "Location_Country", values: [{ descriptor: "Israel", id: "il" }, { descriptor: "India", id: "in" }] },
      ]),
    ).toEqual({ Location_Country: ["il"] });
    expect(
      israelFacet([
        {
          facetParameter: "locations",
          values: [
            { descriptor: "Israel, Haifa", id: "a" },
            { descriptor: "Israel, Tel Aviv", id: "b" },
            { descriptor: "US, Austin", id: "c" },
          ],
        },
      ]),
    ).toEqual({ locations: ["a", "b"] });
    expect(israelFacet([{ facetParameter: "jobFamilyGroup", values: [{ descriptor: "Israel ops", id: "x" }] }])).toBeNull();
  });
});

describe("atsBoardFromUrl for company boards", () => {
  it("recognizes Comeet, Workable, SmartRecruiters and Workday links", () => {
    const cases: [string, { source: string; token: string } | null][] = [
      ["https://www.comeet.com/jobs/silverfort/54.007", { source: "comeet", token: "silverfort/54.007" }],
      ["https://www.comeet.com/jobs/Team8/61.003/backend-engineer/72.E6C?ref=x", { source: "comeet", token: "team8/61.003" }],
      ["https://comeet.co/jobs/drivenets/72.006", { source: "comeet", token: "drivenets/72.006" }],
      ["https://www.comeet.com/jobs/silverfort", null],
      ["https://apply.workable.com/rayzone-group/j/3CF7F81189/", { source: "workable", token: "rayzone-group" }],
      ["https://apply.workable.com/Rayzone-Group/", { source: "workable", token: "rayzone-group" }],
      ["https://rayzone-group.workable.com/jobs/123", { source: "workable", token: "rayzone-group" }],
      ["https://apply.workable.com/j/3CF7F81189", null],
      ["https://apply.workable.com/api/v1/widget/accounts/rayzone-group", null],
      ["https://www.workable.com/pricing", null],
      ["https://jobs.smartrecruiters.com/Wix2/744000152028049-xengineer", { source: "smartrecruiters", token: "wix2" }],
      ["https://careers.smartrecruiters.com/Wix2", { source: "smartrecruiters", token: "wix2" }],
      ["https://jobs.smartrecruiters.com/oneclick-ui/company/Wix2", null],
      [
        "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Israel-Raanana/Dev_JR1",
        { source: "workday", token: "nvidia.wd5/NVIDIAExternalCareerSite" },
      ],
      ["https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite", { source: "workday", token: "nvidia.wd5/NVIDIAExternalCareerSite" }],
      ["https://wd3.myworkdaysite.com/recruiting/intel/External/job/Haifa/x", { source: "workday", token: "intel.wd3/External" }],
      ["https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs", null],
      ["https://nvidia.wd5.myworkdayjobs.com/", null],
    ];
    for (const [url, expected] of cases) expect(atsBoardFromUrl(url), url).toEqual(expected);
  });

  it("leaves single-posting reads to Greenhouse, Lever and Ashby", () => {
    expect(atsPostingFromUrl("https://www.comeet.com/jobs/silverfort/54.007/devops/72.E6C")).toBeNull();
    expect(atsPostingFromUrl("https://apply.workable.com/rayzone-group/j/3CF7F81189/")).toBeNull();
    expect(atsPostingFromUrl("https://jobs.smartrecruiters.com/Wix2/744000152028049-xengineer")).toBeNull();
    expect(atsPostingFromUrl("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/Israel/Dev_JR1")).toBeNull();
    expect(atsPostingFromUrl("https://jobs.lever.co/justt/5f2b7c9e-1a2b")).toMatchObject({ source: "lever", postingId: "5f2b7c9e-1a2b" });
  });

  it("adds mixed-case board tokens once, comparing case-insensitively", async () => {
    const { db, close } = await createTestDb();
    try {
      await db.insert(jobSources).values({ key: "comeet", name: "Comeet", kind: "api", config: { boards: ["Silverfort/54.007"] } });
      const added = await addBoards(db, [comeetAdapter], [
        { source: "comeet", token: "silverfort/54.007" },
        { source: "comeet", token: "team8/61.003" },
        { source: "comeet", token: "TEAM8/61.003" },
        { source: "workday", token: "nvidia.wd5/NVIDIAExternalCareerSite" },
      ]);
      expect(added).toEqual([{ source: "comeet", token: "team8/61.003" }]);
      const [source] = await db.select().from(jobSources);
      expect(source!.config).toEqual({ boards: ["Silverfort/54.007", { token: "team8/61.003", addedAt: expect.any(String) }] });
    } finally {
      await close();
    }
  });
});
