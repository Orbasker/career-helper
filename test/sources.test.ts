import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobSources, jobs } from "../src/db/schema.js";
import { toCanonicalJob, type CollectContext, type JobSourceAdapter, type RawJob } from "../src/ingestion/adapter.js";
import { createIngestCronHandler } from "../src/ingestion/cron.js";
import { emptyDedupReport } from "../src/ingestion/dedup.js";
import { runIngestion } from "../src/ingestion/run.js";
import { ashbyAdapter } from "../src/ingestion/sources/ashby.js";
import { greenhouseAdapter } from "../src/ingestion/sources/greenhouse.js";
import { leverAdapter } from "../src/ingestion/sources/lever.js";
import { htmlToText } from "../src/ingestion/sources/shared.js";
import { createTestDb, type TestDb } from "./support/db.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url), "utf8"));

type Route = unknown | ((url: string) => Response);

function stubFetch(routes: Record<string, Route>) {
  const requested: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    return typeof route === "function" ? route(url) : Response.json(route);
  }) as typeof globalThis.fetch;
  return { fetch, requested };
}

async function collectAll<T>(adapter: JobSourceAdapter<T>, config: Record<string, unknown>, fetch: typeof globalThis.fetch) {
  const errors: { scope: string; error: string }[] = [];
  const ctx: CollectContext = {
    since: null,
    config,
    fetch,
    reportError: (scope, error) => errors.push({ scope, error: (error as Error).message }),
  };
  const records: RawJob<T>[] = [];
  for await (const raw of adapter.collect(ctx)) records.push(raw);
  return { records, errors };
}

const collectedAt = new Date("2026-10-06T10:00:00Z");
const canonical = <T>(adapter: JobSourceAdapter<T>, records: RawJob<T>[]) =>
  records.map((raw) => {
    const result = toCanonicalJob(adapter, raw, collectedAt);
    if (result.ok === true) {
      const { rawRef, collectedAt: _, ...job } = result.job;
      return job;
    }
    return result;
  });

describe("greenhouse adapter", () => {
  const url = "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true";

  it("collects board postings with provenance and normalizes them", async () => {
    const { fetch, requested } = stubFetch({ [url]: fixture("greenhouse-jobs.json") });
    const { records, errors } = await collectAll(greenhouseAdapter, { boards: ["acme"] }, fetch);

    expect(requested).toEqual([url]);
    expect(errors).toEqual([]);
    expect(records[0]).toMatchObject({
      externalId: "acme:4012345",
      sourceUrl: "https://job-boards.greenhouse.io/acme/jobs/4012345",
      payload: { board: "acme", company: null, posting: { id: 4012345, requisition_id: "HR-104" } },
    });
    expect(canonical(greenhouseAdapter, records)).toEqual([
      {
        source: "greenhouse",
        externalId: "acme:4012345",
        sourceUrl: "https://job-boards.greenhouse.io/acme/jobs/4012345",
        title: "HR Business Partner",
        company: "Acme Robotics",
        description:
          "About the role\nPartner with R&D leaders on org design & talent.\n\n- Run quarterly talent reviews\n- Coach managers on feedback",
        location: "Tel Aviv, Israel (Hybrid)",
        workMode: "hybrid",
        employmentType: null,
        publishedAt: new Date("2026-09-28T13:00:00Z"),
      },
      {
        source: "greenhouse",
        externalId: "acme:4012399",
        sourceUrl: "https://job-boards.greenhouse.io/acme/jobs/4012399",
        title: "Technical Recruiter",
        company: "Acme Robotics",
        description: "Own full-cycle hiring for engineering.",
        location: "Remote - EMEA",
        workMode: "remote",
        employmentType: null,
        publishedAt: new Date("2026-10-02T12:00:00Z"),
      },
    ]);
  });

  it("prefers the configured company name", async () => {
    const { fetch } = stubFetch({ [url]: fixture("greenhouse-jobs.json") });
    const { records } = await collectAll(greenhouseAdapter, { boards: [{ token: "acme", company: "Acme" }] }, fetch);
    expect(greenhouseAdapter.normalize(records[0]!)?.company).toBe("Acme");
  });
});

describe("lever adapter", () => {
  it("collects and normalizes postings including list sections", async () => {
    const url = "https://api.lever.co/v0/postings/globex?mode=json";
    const { fetch } = stubFetch({ [url]: fixture("lever-postings.json") });
    const { records } = await collectAll(leverAdapter, { boards: [{ token: "globex", company: "Globex" }] }, fetch);

    expect(canonical(leverAdapter, records)).toEqual([
      {
        source: "lever",
        externalId: "globex:5f2b7c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
        sourceUrl: "https://jobs.lever.co/globex/5f2b7c9e-1a2b-4c3d-9e8f-0a1b2c3d4e5f",
        title: "Talent Acquisition Partner",
        company: "Globex",
        description: [
          "Join our people team to scale hiring.",
          "What you'll do\n- Partner with hiring managers\n- Build sourcing strategies",
          "What you bring\n- 3+ years in recruiting",
          "We offer a learning budget.",
        ].join("\n\n"),
        location: "Haifa, Israel",
        workMode: "onsite",
        employmentType: "full_time",
        publishedAt: new Date(1727600000000),
      },
      {
        source: "lever",
        externalId: "globex:0d9e8f7a-6b5c-4d3e-2f1a-0b9c8d7e6f5a",
        sourceUrl: "https://jobs.lever.co/globex/0d9e8f7a-6b5c-4d3e-2f1a-0b9c8d7e6f5a",
        title: "HRIS Consultant",
        company: "Globex",
        description: "Six-month HRIS migration project.",
        location: "Remote",
        workMode: "remote",
        employmentType: "contract",
        publishedAt: new Date(1727700000000),
      },
    ]);
  });
});

describe("ashby adapter", () => {
  it("collects and normalizes listed postings and skips unlisted ones", async () => {
    const url = "https://api.ashbyhq.com/posting-api/job-board/initech?includeCompensation=true";
    const { fetch } = stubFetch({ [url]: fixture("ashby-job-board.json") });
    const { records } = await collectAll(ashbyAdapter, { boards: [{ token: "initech", company: "Initech" }] }, fetch);

    expect(canonical(ashbyAdapter, records)).toEqual([
      {
        source: "ashby",
        externalId: "initech:b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
        sourceUrl: "https://jobs.ashbyhq.com/initech/b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e",
        title: "People Operations Manager",
        company: "Initech",
        description: "Build our people operations from the ground up.",
        location: "Jerusalem, Israel",
        workMode: "hybrid",
        employmentType: "full_time",
        publishedAt: new Date("2026-09-25T07:30:00Z"),
      },
      {
        source: "ashby",
        externalId: "initech:c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f",
        sourceUrl: "https://jobs.ashbyhq.com/initech/c2d3e4f5-a6b7-4c8d-9e0f-1a2b3c4d5e6f",
        title: "HR Intern",
        company: "Initech",
        description: "Support recruiting coordination.\n\n- Schedule interviews",
        location: "Remote",
        workMode: "remote",
        employmentType: "internship",
        publishedAt: new Date("2026-10-01T07:30:00Z"),
      },
      { ok: "skipped" },
    ]);
  });
});

describe("board collection", () => {
  it("collects nothing without configured boards", async () => {
    const { fetch, requested } = stubFetch({});
    const { records } = await collectAll(greenhouseAdapter, {}, fetch);
    expect(records).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("reports a failing board and keeps collecting the others", async () => {
    const { fetch, requested } = stubFetch({
      "https://api.lever.co/v0/postings/globex?mode=json": fixture("lever-postings.json"),
    });
    const { records, errors } = await collectAll(leverAdapter, { boards: ["gone", "globex", "", 42] }, fetch);

    expect(requested).toEqual([
      "https://api.lever.co/v0/postings/gone?mode=json",
      "https://api.lever.co/v0/postings/globex?mode=json",
    ]);
    expect(records).toHaveLength(2);
    expect(errors).toEqual([
      { scope: "board:gone", error: "GET https://api.lever.co/v0/postings/gone?mode=json failed with 404" },
    ]);
  });
});

describe("htmlToText", () => {
  it("keeps paragraph and list structure and decodes entities", () => {
    expect(htmlToText("<h2>Perks</h2><p>Gym&nbsp;&amp; meals&#33;</p><ul><li>One</li><li>Two</li></ul>")).toBe(
      "Perks\nGym & meals!\n\n- One\n- Two",
    );
  });
});

describe("runIngestion", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  const now = () => collectedAt;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
  });

  afterEach(async () => {
    await close();
  });

  const configure = (key: string, kind: "api", config: Record<string, unknown>) =>
    db.insert(jobSources).values({ key, name: key, kind, config });

  it("isolates a failing source from the others and logs metrics per source", async () => {
    await configure("greenhouse", "api", { boards: ["acme"] });
    await configure("ashby", "api", { boards: ["initech"] });
    const { fetch } = stubFetch({
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true": () => {
        throw new Error("network down");
      },
      "https://api.ashbyhq.com/posting-api/job-board/initech?includeCompensation=true": fixture("ashby-job-board.json"),
    });
    const broken: JobSourceAdapter = {
      source: { key: "broken", name: "Broken", kind: "api" },
      collect() {
        throw new Error("misconfigured");
      },
      normalize: () => null,
    };
    const logs: Record<string, unknown>[] = [];

    const { sources: reports, dedup } = await runIngestion(db, [greenhouseAdapter, broken, ashbyAdapter], {
      fetch,
      now,
      log: (entry) => logs.push(entry),
    });

    expect(reports.map((r) => [r.source, r.inserted, r.skipped, r.errors])).toEqual([
      ["greenhouse", 0, 0, [{ scope: "board:acme", error: "network down" }]],
      ["broken", 0, 0, [{ scope: "collect", error: "misconfigured" }]],
      ["ashby", 2, 1, []],
    ]);
    expect(await db.$count(jobs)).toBe(2);

    const sources = await db.select().from(jobSources);
    const lastCollected = Object.fromEntries(sources.map((s) => [s.key, s.lastCollectedAt]));
    expect(lastCollected).toEqual({ greenhouse: null, ashby: collectedAt, broken: null });

    expect(dedup).toMatchObject({ processed: 2, newGroups: 2, error: null });
    expect(logs.map((l) => l.event)).toEqual([
      "ingest.source",
      "ingest.source",
      "ingest.source",
      "dedup.run",
      "ingest.run",
    ]);
    expect(logs[2]).toMatchObject({ event: "ingest.source", source: "ashby", ok: true, fetched: 3, inserted: 2, skipped: 1 });
    expect(logs[4]).toMatchObject({
      sources: [{ source: "greenhouse", ok: false }, { source: "broken", ok: false }, { ok: true }],
      dedup: { processed: 2 },
    });
  });

  it("records a collect failure mid-stream without losing earlier records", async () => {
    const flaky: JobSourceAdapter<{ title: string }> = {
      source: { key: "flaky", name: "Flaky", kind: "api" },
      async *collect() {
        yield { externalId: "1", sourceUrl: "https://jobs.example/1", payload: { title: "Recruiter" } };
        throw new Error("page 2 timed out");
      },
      normalize: ({ payload }) => ({ title: payload.title, description: "Hire people" }),
    };

    const {
      sources: [report],
    } = await runIngestion(db, [flaky], { now, log: () => {} });

    expect(report).toMatchObject({ inserted: 1, errors: [{ scope: "collect", error: "page 2 timed out" }] });
    const [source] = await db.select().from(jobSources);
    expect(source!.lastCollectedAt).toBeNull();
  });
});

describe("ingest cron handler", () => {
  const request = (authorization?: string) =>
    new Request("https://example.test/api/cron/ingest", {
      headers: authorization ? { authorization } : {},
    });

  it("rejects requests without the cron secret", async () => {
    let ran = false;
    const run = async () => ((ran = true), { sources: [], dedup: emptyDedupReport() });
    expect((await createIngestCronHandler("s3cret", run)(request("Bearer nope"))).status).toBe(401);
    expect((await createIngestCronHandler("s3cret", run)(request())).status).toBe(401);
    expect((await createIngestCronHandler(undefined, run)(request("Bearer undefined"))).status).toBe(401);
    expect(ran).toBe(false);
  });

  it("runs ingestion and returns per-source and dedup metrics", async () => {
    const dedup = { ...emptyDedupReport(), processed: 2, newGroups: 1, joinedByKey: 1 };
    const handler = createIngestCronHandler("s3cret", async () => ({
      dedup,
      sources: [
        {
          source: "lever",
          disabled: false,
          fetched: 2,
          inserted: 2,
          updated: 0,
          unchanged: 0,
          skipped: 0,
          invalid: [],
          failed: [],
          errors: [],
          durationMs: 120,
        },
      ],
    }));
    const response = await handler(request("Bearer s3cret"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sources: [
        {
          source: "lever",
          ok: true,
          disabled: false,
          fetched: 2,
          inserted: 2,
          updated: 0,
          unchanged: 0,
          skipped: 0,
          invalid: 0,
          failed: 0,
          errors: 0,
          durationMs: 120,
        },
      ],
      dedup,
    });
  });
});
