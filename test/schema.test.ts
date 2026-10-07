import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  careerFacts,
  cvVersionItems,
  cvVersions,
  duplicateGroups,
  jobSources,
  jobs,
  matchEvaluations,
  matches,
  preferences,
  profileSources,
  rawJobRecords,
  sourceDocuments,
  users,
} from "../src/db/schema.js";
import { createTestDb, expectDbError, type TestDb } from "./support/db.js";

let db: TestDb;
let close: () => Promise<void>;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
});

afterEach(async () => {
  await close();
});

async function insertUser(telegramUserId = 1) {
  const [user] = await db.insert(users).values({ telegramUserId, telegramChatId: telegramUserId }).returning();
  return user!;
}

async function insertJob() {
  const [source] = await db.insert(jobSources).values({ key: "example", name: "Example", kind: "api" }).returning();
  const [raw] = await db
    .insert(rawJobRecords)
    .values({ sourceId: source!.id, sourceUrl: "https://jobs.example/1", contentHash: "h1", payload: { title: "HR Manager" } })
    .returning();
  const [group] = await db.insert(duplicateGroups).values({ dedupKey: "hr-manager|acme|tel-aviv" }).returning();
  const [job] = await db
    .insert(jobs)
    .values({
      sourceId: source!.id,
      rawRecordId: raw!.id,
      externalId: "1",
      sourceUrl: raw!.sourceUrl,
      title: "HR Manager",
      company: "Acme",
      description: "People operations lead",
      collectedAt: new Date(),
      duplicateGroupId: group!.id,
      dedupMethod: "deterministic_key",
    })
    .returning();
  await db.update(duplicateGroups).set({ canonicalJobId: job!.id });
  return { source: source!, job: job!, group: group! };
}

describe("schema", () => {
  it("rejects a job without a raw source record", async () => {
    const { source } = await insertJob();
    await expectDbError(
      db.insert(jobs).values({
        sourceId: source.id,
        rawRecordId: "00000000-0000-0000-0000-000000000000",
        sourceUrl: "https://jobs.example/2",
        title: "x",
        description: "x",
        collectedAt: new Date(),
      }),
      /jobs_raw_record_id/,
    );
  });

  it("keeps one match per user and duplicate group", async () => {
    const user = await insertUser();
    const { job, group } = await insertJob();
    await db.insert(matches).values({ userId: user.id, jobId: job.id, duplicateGroupId: group.id });
    await expectDbError(
      db.insert(matches).values({ userId: user.id, jobId: job.id, duplicateGroupId: group.id }),
      /matches_user_group_uq/,
    );
  });

  it("stores explainable stage history per match", async () => {
    const user = await insertUser();
    const { job, group } = await insertJob();
    const [match] = await db
      .insert(matches)
      .values({ userId: user.id, jobId: job.id, duplicateGroupId: group.id })
      .returning();
    await db.insert(matchEvaluations).values([
      { matchId: match!.id, stage: "hard_filter", outcome: "passed", profileRevision: 1 },
      {
        matchId: match!.id,
        stage: "deep_match",
        outcome: "passed",
        profileRevision: 1,
        recommendation: "good_fit",
        confidence: "medium",
        evidence: { fitEvidence: [], gaps: ["No payroll experience"], risks: [], transferableSkills: ["Team leadership"] },
      },
    ]);
    const rows = await db.select().from(matchEvaluations);
    expect(rows.map((r) => r.stage)).toEqual(["hard_filter", "deep_match"]);
  });

  it("requires a notified_at timestamp for notified matches", async () => {
    const user = await insertUser();
    const { job, group } = await insertJob();
    await expectDbError(
      db.insert(matches).values({ userId: user.id, jobId: job.id, duplicateGroupId: group.id, status: "notified" }),
      /matches_notified_chk/,
    );
  });

  it("only lets verified facts back tailored CV wording", async () => {
    const user = await insertUser();
    const [unverified] = await db
      .insert(careerFacts)
      .values({ userId: user.id, kind: "achievement", statement: "Cut hiring time by 30%", origin: "cv_upload" })
      .returning();
    const [verified] = await db
      .insert(careerFacts)
      .values({
        userId: user.id,
        kind: "responsibility",
        statement: "Managed a team of 6 recruiters",
        origin: "cv_upload",
        verificationStatus: "verified",
        verifiedAt: new Date(),
      })
      .returning();
    const [cv] = await db.insert(cvVersions).values({ userId: user.id, language: "en", status: "draft" }).returning();

    await expectDbError(
      db.insert(cvVersionItems).values({
        cvVersionId: cv!.id,
        careerFactId: unverified!.id,
        section: "experience",
        position: 0,
        generatedText: "Reduced time-to-hire by 30%",
      }),
      /only reference verified/,
    );

    await db.insert(cvVersionItems).values({
      cvVersionId: cv!.id,
      careerFactId: verified!.id,
      section: "experience",
      position: 0,
      generatedText: "Led a six-person recruiting team",
    });
  });

  it("rejects facts from another user in a CV", async () => {
    const owner = await insertUser(1);
    const other = await insertUser(2);
    const [fact] = await db
      .insert(careerFacts)
      .values({
        userId: other.id,
        kind: "skill",
        statement: "Workday",
        origin: "manual_edit",
        verificationStatus: "verified",
        verifiedAt: new Date(),
      })
      .returning();
    const [cv] = await db.insert(cvVersions).values({ userId: owner.id, language: "en" }).returning();
    await expectDbError(
      db.insert(cvVersionItems).values({
        cvVersionId: cv!.id,
        careerFactId: fact!.id,
        section: "skills",
        position: 0,
        generatedText: "Workday",
      }),
      /does not belong/,
    );
  });

  it("does not activate inferred preferences without a user decision", async () => {
    const user = await insertUser();
    const base = {
      userId: user.id,
      kind: "dislike" as const,
      dimension: "industry" as const,
      value: { type: "terms" as const, terms: ["gambling"] },
      label: "No gambling companies",
      origin: "inferred_from_feedback" as const,
    };
    await db.insert(preferences).values(base);
    await expectDbError(
      db.insert(preferences).values({ ...base, status: "active" }),
      /preferences_inferred_requires_confirmation_chk/,
    );
    await db.insert(preferences).values({ ...base, status: "active", decidedAt: new Date() });
  });

  it("keeps parse status, text and error of source documents consistent", async () => {
    const user = await insertUser();
    const base = { userId: user.id, format: "pdf" as const, fileRef: "tg-1" };
    await expectDbError(
      db.insert(sourceDocuments).values({ ...base, parseStatus: "parsed", extractedText: "text" }),
      /source_documents_parsed_chk/,
    );
    await expectDbError(
      db.insert(sourceDocuments).values({ ...base, parseStatus: "failed", parseError: null }),
      /source_documents_error_chk/,
    );
    await expectDbError(
      db.insert(sourceDocuments).values({ ...base, parseStatus: "failed", parseError: "x", languageConfirmed: true }),
      /source_documents_language_chk/,
    );
    const [document] = await db
      .insert(sourceDocuments)
      .values({ ...base, kind: "cv", parseStatus: "parsed", extractedText: "text", language: "he" })
      .returning();

    await expectDbError(
      db.insert(profileSources).values({ userId: user.id, kind: "cv", documentId: document!.id, content: "copy" }),
      /profile_sources_content_chk/,
    );
    await expectDbError(db.insert(profileSources).values({ userId: user.id, kind: "pasted_text" }), /profile_sources_content_chk/);
  });
});
