import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgApplicationService } from "../src/app/postgres/applications.js";
import { createPgServices } from "../src/app/postgres/index.js";
import { PgMatchService } from "../src/app/postgres/matches.js";
import type { AppServices, MatchSummary } from "../src/app/services.js";
import { createBot } from "../src/bot/bot.js";
import { encodeCallback } from "../src/bot/callbacks.js";
import {
  applicationEvents,
  applications,
  careerFacts,
  careerProfiles,
  cvVersions,
  duplicateGroups,
  jobSources,
  jobs,
  matchEvaluations,
  matches,
  rawJobRecords,
  users,
} from "../src/db/schema.js";
import { isApplicationsRequest, parseApplicationDetails } from "../src/domain/applications.js";
import type { ProfileSnapshot } from "../src/domain/profile.js";
import type { PostingCheck } from "../src/discovery/page.js";
import { strings } from "../src/i18n/index.js";
import { normalizeCompany, normalizeTitle } from "../src/ingestion/normalize.js";
import type { DeepMatchJob, DeepMatchVerdict, DeepMatcher } from "../src/matching/deep-match.js";
import { buildStats } from "../src/observability/report.js";
import { runNotifications, type Notifier } from "../src/pipeline/notify.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, expectDbError, type TestDb } from "./support/db.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { BOT_INFO, DANA, NOA, callbackUpdate, captureApiCalls, textUpdate, type ApiCall, type TelegramPerson } from "./support/telegram.js";

const en = strings("en");
const NOW = new Date("2026-10-07T10:00:00Z");
const PUBLIC_IP = "93.184.216.34";

describe("application details", () => {
  it("reads the company and title in the common ways people write them", () => {
    expect(parseApplicationDetails("Acme — HR Manager")).toEqual({ company: "Acme", title: "HR Manager" });
    expect(parseApplicationDetails("Acme - HR Manager https://acme.com/jobs/1")).toEqual({ company: "Acme", title: "HR Manager" });
    expect(parseApplicationDetails("Acme, HR Manager")).toEqual({ company: "Acme", title: "HR Manager" });
    expect(parseApplicationDetails("Acme\nSenior HR Manager")).toEqual({ company: "Acme", title: "Senior HR Manager" });
    expect(parseApplicationDetails("HR Manager at Acme Ltd")).toEqual({ company: "Acme Ltd", title: "HR Manager" });
    expect(parseApplicationDetails("מנהלת משאבי אנוש ב-Acme")).toEqual({ company: "Acme", title: "מנהלת משאבי אנוש" });
  });

  it("needs both a company and a title", () => {
    expect(parseApplicationDetails("Acme")).toBeNull();
    expect(parseApplicationDetails("https://acme.com/jobs/1")).toBeNull();
    expect(parseApplicationDetails("Acme — ")).toBeNull();
  });

  it("recognizes requests to see applications in both languages", () => {
    expect(isApplicationsRequest("show my applications")).toBe(true);
    expect(isApplicationsRequest("מה המצב של המועמדויות שלי?")).toBe(true);
    expect(isApplicationsRequest("I want to apply for jobs")).toBe(false);
  });
});

class FakeMatcher implements DeepMatcher {
  readonly model = "fake-model";
  readonly promptVersion = "fake-v1";

  async evaluate({ job }: { profile: ProfileSnapshot; job: DeepMatchJob }): Promise<DeepMatchVerdict> {
    return {
      recommendation: "good_fit",
      confidence: "high",
      explanation: `Fits ${job.title}.`,
      evidence: { fitEvidence: [], gaps: [], risks: [], transferableSkills: [] },
    };
  }
}

class FakeNotifier implements Notifier {
  digests: MatchSummary[][] = [];
  async sendDigest(_chatId: number, digest: MatchSummary[]) {
    this.digests.push(digest);
  }
}

let db: TestDb;
let close: () => Promise<void>;
let services: AppServices;
let bot: ReturnType<typeof createBot>;
let calls: ApiCall[];
let pages: Record<string, () => Response>;
let sourceId: string;
let clock: Date;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  pages = {};
  clock = NOW;
  const fetcher = (async (url: string) => {
    if (new URL(url).pathname === "/robots.txt") return new Response("", { status: 404 });
    return pages[url]?.() ?? new Response("missing", { status: 404 });
  }) as typeof fetch;
  const reader = { extract: async (): Promise<PostingCheck> => ({ kind: "none" }) };
  services = createPgServices(db, new FakeProfileAssistant(), new FakeCvTailorer(), {
    jobLinks: { reader, matcher: new FakeMatcher(), fetch: fetcher, resolveHost: async () => [PUBLIC_IP], now: () => NOW },
  });
  services.applications = new PgApplicationService(db, () => clock);
  bot = createBot("test-token", services, { botInfo: BOT_INFO });
  calls = captureApiCalls(bot);
  const [source] = await db.insert(jobSources).values({ key: "greenhouse", name: "Greenhouse", kind: "api" }).returning();
  sourceId = source!.id;
});

afterEach(async () => {
  await close();
});

const sentMessages = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload);
const sent = () => sentMessages().map((p) => p.text as string);
const callbackData = (payloads = sentMessages()): string[] =>
  payloads.flatMap((p) => p.reply_markup?.inline_keyboard?.flat() ?? []).map((b: { callback_data?: string }) => b.callback_data ?? "");
const toast = () => calls.find((c) => c.method === "answerCallbackQuery")?.payload.text as string | undefined;

async function send(update: Parameters<typeof bot.handleUpdate>[0]) {
  calls.length = 0;
  await bot.handleUpdate(update);
}

async function onboard(person: TelegramPerson = DANA): Promise<string> {
  await send(textUpdate("/help", person));
  const [user] = await db.select().from(users).where(eq(users.telegramUserId, person.id));
  await db.update(users).set({ preferredLanguage: "en" }).where(eq(users.id, user!.id));
  await db.insert(careerProfiles).values({ userId: user!.id, status: "confirmed", headline: "HR Manager" });
  await db.insert(careerFacts).values({
    userId: user!.id,
    kind: "skill",
    statement: "Workday",
    origin: "cv_upload",
    verificationStatus: "verified",
    verifiedAt: NOW,
  });
  return user!.id;
}

let seeded = 0;
async function seedJob(job: { title: string; company: string }) {
  seeded++;
  const url = `https://boards.example/${seeded}`;
  const [raw] = await db
    .insert(rawJobRecords)
    .values({ sourceId, sourceUrl: url, contentHash: `h${seeded}`, payload: {} })
    .returning();
  const [group] = await db.insert(duplicateGroups).values({ dedupKey: `k${seeded}` }).returning();
  const [row] = await db
    .insert(jobs)
    .values({
      sourceId,
      rawRecordId: raw!.id,
      sourceUrl: url,
      title: job.title,
      company: job.company,
      description: "Lead people operations.",
      collectedAt: NOW,
      normalizedTitle: normalizeTitle(job.title),
      normalizedCompany: normalizeCompany(job.company),
      duplicateGroupId: group!.id,
      dedupMethod: "deterministic_key",
    })
    .returning();
  await db.update(duplicateGroups).set({ canonicalJobId: row!.id }).where(eq(duplicateGroups.id, group!.id));
  return { jobId: row!.id, groupId: group!.id, url };
}

async function seedMatch(userId: string, job = { title: "People Operations Manager", company: "Acme" }, status: "ready" | "notified" = "notified") {
  const { jobId, groupId, url } = await seedJob(job);
  const [match] = await db
    .insert(matches)
    .values({
      userId,
      jobId,
      duplicateGroupId: groupId,
      status,
      stageReached: "deep_match",
      notifiedAt: status === "notified" ? NOW : null,
      recommendation: "good_fit",
      confidence: "high",
      explanation: "Fits.",
    })
    .returning();
  await db.insert(matchEvaluations).values({ matchId: match!.id, stage: "deep_match", outcome: "passed", profileRevision: 1 });
  return { matchId: match!.id, groupId, url };
}

const applicationsOf = (userId: string) => db.select().from(applications).where(eq(applications.userId, userId));
const eventsOf = (applicationId: string) =>
  db.select().from(applicationEvents).where(eq(applicationEvents.applicationId, applicationId)).orderBy(applicationEvents.createdAt);

describe("applying to a matched job", () => {
  it("records the application in one tap and swaps the button for its status", async () => {
    const userId = await onboard();
    const { matchId, groupId, url } = await seedMatch(userId);

    await send(callbackUpdate(encodeCallback({ type: "job_details", matchId })));
    expect(callbackData()).toContain(encodeCallback({ type: "apply_match", matchId }));

    await send(callbackUpdate(encodeCallback({ type: "apply_match", matchId })));
    const [application] = await applicationsOf(userId);
    expect(application).toMatchObject({
      matchId,
      duplicateGroupId: groupId,
      title: "People Operations Manager",
      company: "Acme",
      sourceUrl: url,
      status: "applied",
      cvVersionId: null,
    });
    expect(await eventsOf(application!.id)).toMatchObject([{ kind: "status_changed", fromStatus: null, toStatus: "applied", source: "user" }]);
    expect(sent()[0]).toBe(en.applications.created("People Operations Manager"));
    expect(sent()[1]).toContain(en.applications.statuses.applied);

    const markup = calls.find((c) => c.method === "editMessageReplyMarkup")!.payload.reply_markup.inline_keyboard.flat();
    expect(markup.map((b: { text: string }) => b.text)).toContain(en.buttons.appliedStatus(en.applications.statuses.applied));
    expect(markup.map((b: { callback_data?: string }) => b.callback_data)).toContain(
      encodeCallback({ type: "application", applicationId: application!.id }),
    );

    await send(callbackUpdate(encodeCallback({ type: "apply_match", matchId })));
    expect(sent()[0]).toBe(en.applications.exists("People Operations Manager"));
    expect(await applicationsOf(userId)).toHaveLength(1);
  });

  it("links the tailored CV the user approved for the job", async () => {
    const userId = await onboard();
    const { matchId } = await seedMatch(userId);
    await send(callbackUpdate(encodeCallback({ type: "tailor_cv", matchId })));
    const [version] = await db.select().from(cvVersions);
    await send(callbackUpdate(encodeCallback({ type: "cv_decision", versionId: version!.id, approve: true })));
    const document = calls.find((c) => c.method === "sendDocument")!.payload;
    expect(document.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data)).toContain(
      encodeCallback({ type: "apply_cv", versionId: version!.id }),
    );

    await send(callbackUpdate(encodeCallback({ type: "apply_match", matchId })));
    const [application] = await applicationsOf(userId);
    expect(application!.cvVersionId).toBe(version!.id);
    expect(sent()[1]).toContain("with your tailored English CV");
  });

  it("applies with a CV from its document, and links a newer CV to an existing application", async () => {
    const userId = await onboard();
    const { matchId } = await seedMatch(userId);
    await send(callbackUpdate(encodeCallback({ type: "apply_match", matchId })));
    await send(callbackUpdate(encodeCallback({ type: "tailor_cv", matchId })));
    const [version] = await db.select().from(cvVersions);
    await send(callbackUpdate(encodeCallback({ type: "cv_decision", versionId: version!.id, approve: true })));

    await send(callbackUpdate(encodeCallback({ type: "apply_cv", versionId: version!.id })));
    const [application] = await applicationsOf(userId);
    expect(application!.cvVersionId).toBe(version!.id);
    expect((await eventsOf(application!.id)).map((e) => e.kind)).toEqual(["status_changed", "cv_linked"]);
    expect(sent()[0]).toBe(en.applications.exists("People Operations Manager"));
    expect(sent()[1]).toContain("Linked your tailored English CV");

    await send(callbackUpdate(encodeCallback({ type: "apply_cv", versionId: version!.id })));
    expect(await eventsOf(application!.id)).toHaveLength(2);
  });

  it("creates the application from a CV when the user never tapped I applied", async () => {
    const userId = await onboard();
    const { matchId } = await seedMatch(userId);
    await send(callbackUpdate(encodeCallback({ type: "tailor_cv", matchId })));
    const [version] = await db.select().from(cvVersions);
    await send(callbackUpdate(encodeCallback({ type: "cv_decision", versionId: version!.id, approve: true })));
    await send(callbackUpdate(encodeCallback({ type: "apply_cv", versionId: version!.id })));
    expect(await applicationsOf(userId)).toMatchObject([{ matchId, cvVersionId: version!.id, status: "applied" }]);
  });

  it("never lets a user apply to another user's match or CV", async () => {
    const dana = await onboard(DANA);
    await onboard(NOA);
    const { matchId } = await seedMatch(dana);
    await send(callbackUpdate(encodeCallback({ type: "apply_match", matchId }), NOA));
    expect(sent()).toEqual([en.messages.matchNotFound]);
    expect(await db.select().from(applications)).toEqual([]);
  });
});

describe("logging an application the agent never surfaced", () => {
  it("asks for the job and logs it from the company and title", async () => {
    const userId = await onboard();
    await send(callbackUpdate(encodeCallback({ type: "application_log" })));
    expect(sent()).toEqual([en.applications.logPrompt]);

    await send(textUpdate("Globex — Payroll Lead"));
    expect(sent()[0]).toBe(en.applications.created("Payroll Lead"));
    const [application] = await applicationsOf(userId);
    expect(application).toMatchObject({
      matchId: null,
      duplicateGroupId: null,
      company: "Globex",
      title: "Payroll Lead",
      normalizedCompany: "globex",
      normalizedTitle: "payroll lead",
      sourceUrl: null,
      status: "applied",
    });

    await send(textUpdate("/applied Globex Ltd, Payroll Lead"));
    expect(sent()[0]).toBe(en.applications.exists("Payroll Lead"));
    expect(await applicationsOf(userId)).toHaveLength(1);
  });

  it("asks again when it can't tell the company from the title", async () => {
    const userId = await onboard();
    await send(textUpdate("/applied"));
    await send(textUpdate("Globex"));
    expect(sent()).toEqual([en.applications.logInvalid]);
    await send(textUpdate("Globex | Payroll Lead"));
    expect(await applicationsOf(userId)).toMatchObject([{ company: "Globex", title: "Payroll Lead" }]);
  });

  it("stops waiting for details after ten minutes", async () => {
    const userId = await onboard();
    await send(textUpdate("/applied"));
    clock = new Date(NOW.getTime() + 11 * 60_000);
    await send(textUpdate("Globex — Payroll Lead"));
    expect(await applicationsOf(userId)).toEqual([]);
  });

  it("links a logged job to the user's match for it", async () => {
    const userId = await onboard();
    const { matchId, groupId } = await seedMatch(userId, { title: "Payroll Lead", company: "Globex Ltd" });
    await send(textUpdate("/applied Globex — Payroll Lead"));
    expect(await applicationsOf(userId)).toMatchObject([{ matchId, duplicateGroupId: groupId, company: "Globex Ltd" }]);
  });

  it("reads a posting link through the job-link flow and logs the matched job", async () => {
    const userId = await onboard();
    pages["https://careers.acme.com/jobs/hrbp"] = () =>
      new Response(
        `<html><head><script type="application/ld+json">${JSON.stringify({
          "@type": "JobPosting",
          title: "HR Business Partner",
          description: "<p>Partner with engineering leaders on people strategy.</p>",
          hiringOrganization: { name: "Acme Ltd" },
          validThrough: "2026-12-31",
        })}</script></head><body>Apply</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    await send(textUpdate("/applied https://careers.acme.com/jobs/hrbp"));
    expect(sent()).toContain(en.applications.created("HR Business Partner"));
    const [match] = await db.select().from(matches);
    expect(await applicationsOf(userId)).toMatchObject([
      { matchId: match!.id, company: "Acme Ltd", title: "HR Business Partner", sourceUrl: "https://careers.acme.com/jobs/hrbp" },
    ]);
  });

  it("logs the job by hand when its link can't be read", async () => {
    const userId = await onboard();
    await send(textUpdate("/applied https://careers.acme.com/jobs/gone"));
    expect(sent().at(-1)).toContain(en.applications.logLinkFailed);
    expect(await applicationsOf(userId)).toEqual([]);

    await send(textUpdate("Acme — HR Business Partner https://careers.acme.com/jobs/gone"));
    expect(await applicationsOf(userId)).toMatchObject([
      { matchId: null, company: "Acme", title: "HR Business Partner", sourceUrl: "https://careers.acme.com/jobs/gone" },
    ]);
  });

  it("asks users without a confirmed profile to onboard first", async () => {
    await send(textUpdate("/applied Globex — Payroll Lead"));
    expect(sent()).toEqual([en.messages.notOnboarded]);
    await send(textUpdate("/applications"));
    expect(sent()).toEqual([en.messages.notOnboarded]);
  });
});

describe("/applications", () => {
  it("groups applications by status, live processes first", async () => {
    const userId = await onboard();
    const app = services.applications;
    const a = await app.logManual(userId, { company: "Globex", title: "Payroll Lead", url: null });
    const b = await app.logManual(userId, { company: "Initech", title: "HRBP", url: null });
    await app.logManual(userId, { company: "Umbrella", title: "People Partner", url: null });
    if (a.kind === "not_found" || b.kind === "not_found") throw new Error("not logged");
    await app.setStatus(userId, a.application.id, "rejected");
    await app.setStatus(userId, b.application.id, "interviewing");

    await send(textUpdate("/applications"));
    const [text] = sent();
    const order = ["interviewing", "applied", "rejected"].map((s) => text!.indexOf(en.applications.statuses[s as "applied"]));
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(text).toContain(en.applications.item(1, "HRBP", "Initech", "2026-10-07"));
    expect(text).toContain(en.applications.item(3, "Payroll Lead", "Globex", "2026-10-07"));
    expect(callbackData()).toEqual([
      encodeCallback({ type: "application", applicationId: b.application.id }),
      expect.any(String),
      encodeCallback({ type: "application", applicationId: a.application.id }),
      encodeCallback({ type: "application_log" }),
    ]);

    await send(textUpdate("where do my applications stand?"));
    expect(sent()[0]).toContain(en.applications.title);
  });

  it("offers to log one when there are none", async () => {
    await onboard();
    await send(textUpdate("/applications"));
    expect(sent()).toEqual([en.applications.empty]);
    expect(callbackData()).toEqual([encodeCallback({ type: "application_log" })]);
  });

  it("updates the status from the card and keeps every change in the history", async () => {
    const userId = await onboard();
    const { matchId } = await seedMatch(userId);
    await send(callbackUpdate(encodeCallback({ type: "apply_match", matchId })));
    const [application] = await applicationsOf(userId);
    const applicationId = application!.id;

    clock = new Date("2026-10-09T10:00:00Z");
    await send(callbackUpdate(encodeCallback({ type: "application_status", applicationId, status: "screening" })));
    expect(toast()).toBe(en.applications.statusChanged(en.applications.statuses.screening));
    const card = calls.find((c) => c.method === "editMessageText")!.payload;
    expect(card.text).toContain(en.applications.eventStatus("2026-10-09", en.applications.statuses.applied, en.applications.statuses.screening));

    await send(callbackUpdate(encodeCallback({ type: "application_status", applicationId, status: "screening" })));
    expect(toast()).toBe(en.applications.statusUnchanged);

    clock = new Date("2026-10-12T10:00:00Z");
    await services.applications.setStatus(userId, applicationId, "interviewing", { source: "email", evidenceRef: "gmail:msg-1" });
    expect(await eventsOf(applicationId)).toMatchObject([
      { kind: "status_changed", fromStatus: null, toStatus: "applied", source: "user" },
      { kind: "status_changed", fromStatus: "applied", toStatus: "screening", source: "user" },
      { kind: "status_changed", fromStatus: "screening", toStatus: "interviewing", source: "email", evidenceRef: "gmail:msg-1" },
    ]);
    const [updated] = await applicationsOf(userId);
    expect(updated).toMatchObject({ status: "interviewing", lastEventAt: clock });

    await send(callbackUpdate(encodeCallback({ type: "application", applicationId })));
    expect(sent()[0]).toContain(`${en.applications.eventSources.email}`);
    expect(callbackData()).not.toContain(encodeCallback({ type: "application_status", applicationId, status: "interviewing" }));
    expect(callbackData()).toContain(encodeCallback({ type: "application_status", applicationId, status: "offer" }));
  });

  it("adds notes to the history", async () => {
    const userId = await onboard();
    const logged = await services.applications.logManual(userId, { company: "Globex", title: "Payroll Lead", url: null });
    if (logged.kind === "not_found") throw new Error("not logged");
    const applicationId = logged.application.id;

    await send(callbackUpdate(encodeCallback({ type: "application_note", applicationId })));
    expect(sent()).toEqual([en.applications.notePrompt("Payroll Lead")]);
    await send(textUpdate("Recruiter <Dana> called, interview Monday"));
    expect(sent()[0]).toBe(en.applications.noteSaved);
    expect(sent()[1]).toContain("📝 Recruiter &lt;Dana&gt; called, interview Monday");
    const [application] = await applicationsOf(userId);
    expect(application!.notes).toBe("Recruiter <Dana> called, interview Monday");
    expect((await eventsOf(applicationId)).at(-1)).toMatchObject({ kind: "note_added", source: "user" });
  });

  it("keeps each user's applications private", async () => {
    const dana = await onboard(DANA);
    await onboard(NOA);
    const logged = await services.applications.logManual(dana, { company: "Globex", title: "Payroll Lead", url: null });
    if (logged.kind === "not_found") throw new Error("not logged");
    const applicationId = logged.application.id;

    await send(callbackUpdate(encodeCallback({ type: "application", applicationId }), NOA));
    expect(toast()).toBe(en.messages.expired);
    await send(callbackUpdate(encodeCallback({ type: "application_status", applicationId, status: "offer" }), NOA));
    expect(toast()).toBe(en.messages.expired);
    await send(callbackUpdate(encodeCallback({ type: "application_note", applicationId }), NOA));
    expect(toast()).toBe(en.messages.expired);
    await send(textUpdate("/applications", NOA));
    expect(sent()).toEqual([en.applications.empty]);
    const [application] = await applicationsOf(dana);
    expect(application!.status).toBe("applied");
  });
});

describe("applied jobs are not recommended again", () => {
  it("leaves them out of the digest and of What's new, including jobs logged by hand before the agent found them", async () => {
    const userId = await onboard();
    await services.applications.logManual(userId, { company: "Globex", title: "Payroll lead", url: null });
    const applied = await seedMatch(userId, { title: "People Operations Manager", company: "Acme" }, "ready");
    await seedMatch(userId, { title: "Payroll Lead", company: "Globex Ltd." }, "ready");
    const fresh = await seedMatch(userId, { title: "HR Business Partner", company: "Initech" }, "ready");
    await services.applications.applyToMatch(userId, applied.matchId);

    const notifier = new FakeNotifier();
    const report = await runNotifications(db, notifier);
    expect(notifier.digests.map((d) => d.map((m) => m.matchId))).toEqual([[fresh.matchId]]);
    expect(report.matchesNotified).toBe(1);

    await db.update(matches).set({ status: "ready", notifiedAt: null });
    const latest = await new PgMatchService(db).whatsNew(userId, 5);
    expect(latest.map((m) => m.matchId)).toEqual([fresh.matchId]);
  });

  it("still shows the job's details with its application", async () => {
    const userId = await onboard();
    const { matchId } = await seedMatch(userId);
    await services.applications.applyToMatch(userId, matchId);
    const details = await services.matches.details(userId, matchId);
    expect(details!.application).toMatchObject({ status: "applied" });
  });
});

describe("application audit trail", () => {
  it("keeps one application per job and only well-formed events", async () => {
    const userId = await onboard();
    const { groupId } = await seedMatch(userId);
    await db.insert(applications).values({ userId, duplicateGroupId: groupId, title: "A" });
    await expectDbError(db.insert(applications).values({ userId, duplicateGroupId: groupId, title: "B" }), /applications_user_group_uq/);
    const [application] = await applicationsOf(userId);
    await expectDbError(
      db.insert(applicationEvents).values({ applicationId: application!.id, kind: "status_changed", source: "user" }),
      /application_events_status_chk/,
    );
    await expectDbError(
      db.insert(applicationEvents).values({ applicationId: application!.id, kind: "note_added", source: "user" }),
      /application_events_note_chk/,
    );
  });

  it("counts applications and status changes in the operator report", async () => {
    clock = new Date();
    const userId = await onboard();
    const { matchId } = await seedMatch(userId);
    const applied = await services.applications.applyToMatch(userId, matchId);
    await services.applications.logManual(userId, { company: "Globex", title: "Payroll Lead", url: null });
    if (applied.kind === "not_found") throw new Error("not applied");
    await services.applications.setStatus(userId, applied.application.id, "screening");
    const stats = await buildStats(db, { now: new Date(clock.getTime() + 1000) });
    expect(stats.applications).toEqual({ logged: 2, fromMatches: 1, statusChanges: 1 });
  });
});
