import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { duplicateGroups, jobs } from "../src/db/schema.js";
import type { JobSourceAdapter } from "../src/ingestion/adapter.js";
import { deduplicateJobs, listGroupSources } from "../src/ingestion/dedup.js";
import { ingestFromSource } from "../src/ingestion/ingest.js";
import {
  dedupKey,
  jaccard,
  normalizeCompany,
  normalizeJobKey,
  normalizeLocation,
  normalizeTitle,
  wordShingles,
} from "../src/ingestion/normalize.js";
import { createTestDb, type TestDb } from "./support/db.js";

describe("normalization", () => {
  it("normalizes titles", () => {
    expect(normalizeTitle("  Sr. HR Manager (m/f/d) ")).toBe("senior human resources manager");
    expect(normalizeTitle("Senior Human Resources Manager - Remote")).toBe("senior human resources manager");
    expect(normalizeTitle("Head of R&D (Remote, EU)")).toBe("head of r and d");
    expect(normalizeTitle("Développeur Front-End")).toBe("developpeur front end");
    expect(normalizeTitle(" ")).toBeNull();
  });

  it("normalizes company names", () => {
    expect(normalizeCompany("Acme, Inc.")).toBe("acme");
    expect(normalizeCompany("ACME Robotics GmbH")).toBe("acme robotics");
    expect(normalizeCompany("A.B.C. Ltd")).toBe("abc");
    expect(normalizeCompany("Co")).toBe("co");
    expect(normalizeCompany(null)).toBeNull();
  });

  it("reduces locations to their primary place", () => {
    expect(normalizeLocation("Tel Aviv-Yafo, Israel")).toBe("tel aviv");
    expect(normalizeLocation("Tel Aviv; London")).toBe("tel aviv");
    expect(normalizeLocation("NYC")).toBe("new york");
    expect(normalizeLocation("São Paulo / Remote")).toBe("sao paulo");
    expect(normalizeLocation("")).toBeNull();
  });

  it("builds a dedup key only when title and company are known", () => {
    expect(dedupKey(normalizeJobKey({ title: "HR Manager", company: "Acme Inc", location: "Tel Aviv" }))).toBe(
      "human resources manager|acme|tel aviv",
    );
    expect(dedupKey(normalizeJobKey({ title: "HR Manager", company: "Acme", location: null }))).toBe(
      "human resources manager|acme|",
    );
    expect(dedupKey(normalizeJobKey({ title: "HR Manager", company: null, location: "Tel Aviv" }))).toBeNull();
  });

  it("measures text similarity on word shingles", () => {
    const a = wordShingles("Lead people operations for a team of 200.");
    expect(jaccard(a, wordShingles("lead PEOPLE operations for a team of 200"))).toBe(1);
    expect(jaccard(a, wordShingles("Write backend services in Go and Postgres"))).toBe(0);
  });
});

interface Posting {
  id: string;
  title: string;
  company?: string;
  location?: string;
  body?: string;
  remote?: boolean;
  posted?: string;
}

const HR_BODY =
  "You will lead people operations for a growing team of 200 across Tel Aviv and London, own hiring, onboarding, performance reviews and compensation planning, and partner with leadership on culture.";

function boardAdapter(key: string, postings: () => Posting[]): JobSourceAdapter<Posting> {
  return {
    source: { key, name: key, kind: "api" },
    *collect() {
      for (const p of postings()) yield { externalId: p.id, sourceUrl: `https://${key}.example/${p.id}`, payload: p };
    },
    normalize: ({ payload }) => ({
      title: payload.title,
      description: payload.body ?? HR_BODY,
      company: payload.company,
      location: payload.location,
      workMode: payload.remote ? "remote" : null,
      publishedAt: payload.posted ? new Date(payload.posted) : null,
    }),
  };
}

describe("deduplicateJobs", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let clock: Date;
  const now = () => clock;
  let greenhouse: Posting[];
  let lever: Posting[];

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    clock = new Date("2026-10-06T10:00:00Z");
    greenhouse = [];
    lever = [];
  });

  afterEach(async () => {
    await close();
  });

  const ingest = async () => {
    await ingestFromSource(db, boardAdapter("greenhouse", () => greenhouse), { now });
    clock = new Date(clock.getTime() + 60_000);
    await ingestFromSource(db, boardAdapter("lever", () => lever), { now });
    clock = new Date(clock.getTime() + 60_000);
  };
  const jobBy = async (sourceUrl: string) => (await db.select().from(jobs).where(eq(jobs.sourceUrl, sourceUrl)))[0]!;
  const groupOf = async (sourceUrl: string) => (await jobBy(sourceUrl)).duplicateGroupId;

  it("stores normalized fields when ingesting", async () => {
    greenhouse = [{ id: "1", title: "Sr. HR Manager", company: "Acme, Inc.", location: "Tel Aviv-Yafo, Israel" }];
    await ingest();
    expect(await jobBy("https://greenhouse.example/1")).toMatchObject({
      normalizedTitle: "senior human resources manager",
      normalizedCompany: "acme",
      normalizedLocation: "tel aviv",
      duplicateGroupId: null,
    });
  });

  it("groups the same posting across sources by deterministic key and keeps every source URL", async () => {
    greenhouse = [{ id: "1", title: "Senior HR Manager", company: "Acme Inc.", location: "Tel Aviv, Israel" }];
    lever = [
      {
        id: "a",
        title: "Sr HR Manager (m/f/d)",
        company: "ACME",
        location: "Tel Aviv-Yafo",
        remote: true,
        posted: "2026-10-01T00:00:00Z",
      },
    ];
    await ingest();

    const report = await deduplicateJobs(db, { now });

    expect(report).toMatchObject({ processed: 2, newGroups: 1, joinedByKey: 1, joinedBySimilarity: 0, error: null });
    const [group] = await db.select().from(duplicateGroups);
    expect(group!.dedupKey).toBe("senior human resources manager|acme|tel aviv");
    const leverJob = await jobBy("https://lever.example/a");
    expect(group!.canonicalJobId).toBe(leverJob.id);
    expect(await listGroupSources(db, group!.id)).toEqual([
      expect.objectContaining({ source: "greenhouse", sourceUrl: "https://greenhouse.example/1", isCanonical: false }),
      expect.objectContaining({ source: "lever", sourceUrl: "https://lever.example/a", isCanonical: true }),
    ]);
    const methods = (await db.select({ m: jobs.dedupMethod }).from(jobs).orderBy(asc(jobs.collectedAt))).map((r) => r.m);
    expect(methods).toEqual(["deterministic_key", "deterministic_key"]);
  });

  it("falls back to similarity when keys differ but title and description match", async () => {
    greenhouse = [{ id: "1", title: "HR Manager", company: "Acme", location: "Tel Aviv" }];
    lever = [{ id: "a", title: "HR Manager, People Operations", company: "Acme Ltd", body: `${HR_BODY}  ` }];
    await ingest();

    const report = await deduplicateJobs(db, { now });

    expect(report).toMatchObject({ processed: 2, newGroups: 1, joinedBySimilarity: 1 });
    expect(await groupOf("https://lever.example/a")).toBe(await groupOf("https://greenhouse.example/1"));
    expect((await jobBy("https://lever.example/a")).dedupMethod).toBe("similarity");
  });

  it("keeps distinct roles, companies, locations and company-less postings apart", async () => {
    greenhouse = [
      { id: "1", title: "HR Manager", company: "Acme", location: "Tel Aviv" },
      { id: "2", title: "Backend Engineer", company: "Acme", body: "Write backend services in Go and Postgres." },
      { id: "3", title: "Recruiter", body: "Hire people" },
    ];
    lever = [
      { id: "a", title: "HR Manager", company: "Initech", location: "Tel Aviv" },
      { id: "b", title: "HR Manager", company: "Acme", location: "London" },
      { id: "c", title: "HR Manager", company: "Acme", body: "Run payroll and benefits administration for the EMEA region." },
      { id: "d", title: "Recruiter", body: "Hire people" },
    ];
    await ingest();

    const report = await deduplicateJobs(db, { now });

    expect(report).toMatchObject({ processed: 7, newGroups: 7, joinedByKey: 0, joinedBySimilarity: 0 });
    const groups = await db.select().from(duplicateGroups);
    expect(groups.filter((g) => g.dedupKey?.startsWith("job:"))).toHaveLength(2);
  });

  it("is a no-op when re-run and only processes new jobs", async () => {
    greenhouse = [{ id: "1", title: "HR Manager", company: "Acme" }];
    await ingest();
    await deduplicateJobs(db, { now });

    expect(await deduplicateJobs(db, { now })).toMatchObject({ processed: 0, canonicalChanged: 0 });

    lever = [{ id: "a", title: "HR Manager", company: "Acme", location: "Tel Aviv", remote: true }];
    await ingest();
    expect(await deduplicateJobs(db, { now })).toMatchObject({ processed: 1, joinedBySimilarity: 1, canonicalChanged: 1 });
    expect(await db.$count(duplicateGroups)).toBe(1);
  });

  it("regroups a job whose normalized key changes and re-selects the old group's canonical", async () => {
    greenhouse = [{ id: "1", title: "HR Manager", company: "Acme", remote: true }];
    lever = [{ id: "a", title: "HR Manager", company: "Acme" }];
    await ingest();
    await deduplicateJobs(db, { now });
    const original = await groupOf("https://lever.example/a");
    const [before] = await db.select().from(duplicateGroups);
    expect(before!.canonicalJobId).toBe((await jobBy("https://greenhouse.example/1")).id);

    greenhouse = [{ id: "1", title: "Head of Engineering", company: "Acme", remote: true, body: "Build the platform team." }];
    await ingest();
    expect(await jobBy("https://greenhouse.example/1")).toMatchObject({ duplicateGroupId: null, dedupMethod: null });

    await deduplicateJobs(db, { now });

    expect(await groupOf("https://greenhouse.example/1")).not.toBe(original);
    const [after] = await db.select().from(duplicateGroups).where(eq(duplicateGroups.id, original!));
    expect(after!.canonicalJobId).toBe((await jobBy("https://lever.example/a")).id);
  });

  it("keeps manual groupings when a job is updated", async () => {
    greenhouse = [{ id: "1", title: "HR Manager", company: "Acme" }];
    await ingest();
    await deduplicateJobs(db, { now });
    await db.update(jobs).set({ dedupMethod: "manual" });

    greenhouse = [{ id: "1", title: "People Lead", company: "Acme" }];
    await ingest();

    expect(await jobBy("https://greenhouse.example/1")).toMatchObject({
      normalizedTitle: "people lead",
      dedupMethod: "manual",
    });
    expect((await jobBy("https://greenhouse.example/1")).duplicateGroupId).not.toBeNull();
  });
});
