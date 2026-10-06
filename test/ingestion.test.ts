import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobSources, jobs, rawJobRecords } from "../src/db/schema.js";
import { contentHash, toCanonicalJob, type JobSourceAdapter, type RawJob } from "../src/ingestion/adapter.js";
import { validateCanonicalJob } from "../src/ingestion/canonical-job.js";
import { ingestFromSource } from "../src/ingestion/ingest.js";
import { createTestDb, type TestDb } from "./support/db.js";

interface FixturePosting {
  id?: string;
  url: string;
  title: string;
  body: string;
  company?: string;
  remote?: boolean;
  posted?: string;
}

function fixtureAdapter(postings: FixturePosting[] | (() => FixturePosting[])): JobSourceAdapter<FixturePosting> {
  return {
    source: { key: "fixture", name: "Fixture board", kind: "api", baseUrl: "https://jobs.example" },
    *collect() {
      for (const p of typeof postings === "function" ? postings() : postings) {
        yield { externalId: p.id ?? null, sourceUrl: p.url, payload: p };
      }
    },
    normalize({ payload }) {
      if (payload.title === "SPAM") return null;
      return {
        title: payload.title,
        description: payload.body,
        company: payload.company,
        workMode: payload.remote ? "remote" : null,
        publishedAt: payload.posted ? new Date(payload.posted) : null,
      };
    },
  };
}

const HR_MANAGER: FixturePosting = {
  id: "101",
  url: "https://jobs.example/101",
  title: "  HR Manager ",
  body: "Lead people operations",
  company: "Acme",
  remote: true,
  posted: "2026-10-01T08:00:00Z",
};

describe("canonical job contract", () => {
  const collectedAt = new Date("2026-10-06T10:00:00Z");

  it("maps a raw record to a canonical job with a raw-source reference", () => {
    const raw: RawJob<FixturePosting> = { externalId: "101", sourceUrl: HR_MANAGER.url, payload: HR_MANAGER };
    const result = toCanonicalJob(fixtureAdapter([]), raw, collectedAt);
    expect(result).toEqual({
      ok: true,
      job: {
        source: "fixture",
        externalId: "101",
        sourceUrl: "https://jobs.example/101",
        title: "HR Manager",
        company: "Acme",
        description: "Lead people operations",
        location: null,
        workMode: "remote",
        employmentType: null,
        publishedAt: new Date("2026-10-01T08:00:00Z"),
        collectedAt,
        rawRef: { source: "fixture", contentHash: contentHash(raw) },
      },
    });
  });

  it("lets adapters skip records that are not postings", () => {
    const raw = { sourceUrl: "https://jobs.example/x", payload: { ...HR_MANAGER, title: "SPAM" } };
    expect(toCanonicalJob(fixtureAdapter([]), raw, collectedAt)).toEqual({ ok: "skipped" });
  });

  it("reports every contract violation", () => {
    const result = validateCanonicalJob({
      source: "fixture",
      externalId: null,
      sourceUrl: "ftp://jobs.example/1",
      title: " ",
      company: null,
      description: "",
      location: null,
      workMode: "on the moon",
      employmentType: null,
      publishedAt: new Date("nope"),
      collectedAt,
      rawRef: { source: "other", contentHash: "h" },
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        "sourceUrl must be an http(s) URL",
        "title is required",
        "description is required",
        "workMode must be one of onsite, hybrid, remote",
        "publishedAt must be a valid Date",
        "rawRef.source must match source",
      ],
    });
  });

  it("hashes payloads independently of key order", () => {
    const a = contentHash({ sourceUrl: "https://x", payload: { a: 1, b: [1, { c: 2, d: 3 }] } });
    const b = contentHash({ sourceUrl: "https://x", payload: { b: [1, { d: 3, c: 2 }], a: 1 } });
    expect(a).toBe(b);
    expect(contentHash({ sourceUrl: "https://x", payload: { a: 2 } })).not.toBe(a);
  });
});

describe("ingestFromSource", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let clock: Date;
  const now = () => clock;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    clock = new Date("2026-10-06T10:00:00Z");
  });

  afterEach(async () => {
    await close();
  });

  it("persists raw records and canonical jobs", async () => {
    const report = await ingestFromSource(db, fixtureAdapter([HR_MANAGER]), { now });
    expect(report).toMatchObject({ fetched: 1, inserted: 1, updated: 0, unchanged: 0, invalid: [], failed: [] });

    const [job] = await db.select().from(jobs);
    const [raw] = await db.select().from(rawJobRecords);
    expect(job).toMatchObject({ title: "HR Manager", externalId: "101", workMode: "remote", rawRecordId: raw!.id });
    expect(raw!.payload).toEqual(HR_MANAGER);
    const [source] = await db.select().from(jobSources);
    expect(source!.lastCollectedAt).toEqual(clock);
  });

  it("is idempotent when re-run with the same records", async () => {
    const adapter = fixtureAdapter([HR_MANAGER, { url: "https://jobs.example/no-id", title: "Recruiter", body: "Hire" }]);
    await ingestFromSource(db, adapter, { now });
    clock = new Date("2026-10-06T11:00:00Z");
    const [before] = await db.select().from(jobs).where(eq(jobs.externalId, "101"));

    const report = await ingestFromSource(db, adapter, { now });

    expect(report).toMatchObject({ fetched: 2, inserted: 0, updated: 0, unchanged: 2 });
    expect(await db.$count(jobs)).toBe(2);
    expect(await db.$count(rawJobRecords)).toBe(2);
    const [after] = await db.select().from(jobs).where(eq(jobs.externalId, "101"));
    expect(after).toEqual(before);
  });

  it("updates a job in place when its source content changes", async () => {
    let postings = [HR_MANAGER];
    const adapter = fixtureAdapter(() => postings);
    await ingestFromSource(db, adapter, { now });
    const [original] = await db.select().from(jobs);

    postings = [{ ...HR_MANAGER, url: "https://jobs.example/101?v=2", body: "Lead people ops for 200 staff" }];
    clock = new Date("2026-10-07T10:00:00Z");
    const report = await ingestFromSource(db, adapter, { now });

    expect(report).toMatchObject({ inserted: 0, updated: 1 });
    const [updated] = await db.select().from(jobs);
    expect(updated).toMatchObject({
      id: original!.id,
      description: "Lead people ops for 200 staff",
      sourceUrl: "https://jobs.example/101?v=2",
      collectedAt: original!.collectedAt,
    });
    expect(updated!.rawRecordId).not.toBe(original!.rawRecordId);
    expect(await db.$count(rawJobRecords)).toBe(2);
  });

  it("keeps going past invalid, skipped and failing records", async () => {
    const adapter = fixtureAdapter([
      { url: "https://jobs.example/1", title: "", body: "No title" },
      { url: "https://jobs.example/2", title: "SPAM", body: "Buy now" },
      HR_MANAGER,
    ]);
    const original = adapter.normalize;
    adapter.normalize = (raw) => {
      if (raw.externalId === "101") throw new Error("boom");
      return original(raw);
    };

    const report = await ingestFromSource(db, adapter, { now });

    expect(report).toMatchObject({
      fetched: 3,
      inserted: 0,
      skipped: 1,
      invalid: [{ sourceUrl: "https://jobs.example/1", issues: ["title is required"] }],
      failed: [{ sourceUrl: HR_MANAGER.url, error: "boom" }],
    });
    expect(await db.$count(rawJobRecords)).toBe(3);
  });

  it("does not collect from a disabled source", async () => {
    await db.insert(jobSources).values({ key: "fixture", name: "Fixture board", kind: "api", isEnabled: false });
    const report = await ingestFromSource(db, fixtureAdapter([HR_MANAGER]), { now });
    expect(report).toMatchObject({ disabled: true, fetched: 0 });
    expect(await db.$count(jobs)).toBe(0);
  });

  it("passes the previous collection time and source config to the adapter", async () => {
    const seen: unknown[] = [];
    const adapter = fixtureAdapter([]);
    adapter.collect = (ctx) => {
      seen.push({ since: ctx.since, config: ctx.config });
      return [];
    };
    await db
      .insert(jobSources)
      .values({ key: "fixture", name: "Fixture board", kind: "api", config: { query: "hr" } });

    await ingestFromSource(db, adapter, { now });
    await ingestFromSource(db, adapter, { now });

    expect(seen).toEqual([
      { since: null, config: { query: "hr" } },
      { since: clock, config: { query: "hr" } },
    ]);
  });
});
