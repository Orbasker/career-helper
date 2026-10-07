import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgServices } from "../src/app/postgres/index.js";
import { createBot } from "../src/bot/bot.js";
import { encodeCallback } from "../src/bot/callbacks.js";
import { ASK_LANGUAGE } from "../src/bot/views.js";
import {
  careerFacts,
  careerProfiles,
  conversationStates,
  masterCvs,
  preferences,
  profileSources,
  users,
  workExperiences,
} from "../src/db/schema.js";
import type { ProfileChange } from "../src/domain/profile.js";
import { strings } from "../src/i18n/index.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { createTestDb, type TestDb } from "./support/db.js";
import {
  BOT_INFO,
  DANA,
  NOA,
  callbackUpdate,
  captureApiCalls,
  documentUpdate,
  textUpdate,
  type ApiCall,
  type TelegramPerson,
} from "./support/telegram.js";

const en = strings("en");
const messages = en.messages;

const CV_TEXT = "Dana Levi\nHR Manager, Acme Ltd, 2019 - present\nManaged a team of 6 recruiters\nCut time-to-hire by 30%";

const EXTRACTION: ProfileChange[] = [
  { op: "update_profile", fields: { headline: "HR Manager", currentSeniority: "manager" } },
  {
    op: "add_experience",
    ref: "x0",
    origin: "cv_upload",
    experience: {
      employer: "Acme Ltd",
      title: "HR Manager",
      industry: "Retail",
      location: "Tel Aviv",
      seniority: "manager",
      managedHeadcount: 6,
      startDate: "2019-01-01",
      endDate: null,
      isCurrent: true,
    },
  },
  {
    op: "add_fact",
    kind: "responsibility",
    statement: "Managed a team of 6 recruiters",
    experienceId: null,
    experienceRef: "x0",
    origin: "cv_upload",
  },
  {
    op: "add_fact",
    kind: "achievement",
    statement: "Cut time-to-hire by 30%",
    experienceId: null,
    experienceRef: "x0",
    origin: "cv_upload",
  },
  { op: "add_fact", kind: "skill", statement: "Workday", experienceId: null, experienceRef: null, origin: "cv_upload" },
];

let db: TestDb;
let close: () => Promise<void>;
let assistant: FakeProfileAssistant;
let bot: ReturnType<typeof createBot>;
let calls: ApiCall[];
let fileContent: string;

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  assistant = new FakeProfileAssistant();
  assistant.extraction = { changes: EXTRACTION, followUpQuestions: ["Which roles are you targeting?", "Remote, hybrid or onsite?"] };
  fileContent = CV_TEXT;
  bot = createBot("test-token", createPgServices(db, assistant, new FakeCvTailorer()), { botInfo: BOT_INFO }, {
    downloadFile: async () => new TextEncoder().encode(fileContent),
  });
  calls = captureApiCalls(bot);
});

afterEach(async () => {
  await close();
});

const sentMessages = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload);
const sent = () => sentMessages().map((p) => p.text as string);
const lastKeyboardData = () =>
  sentMessages()
    .flatMap((p) => p.reply_markup?.inline_keyboard?.flat() ?? [])
    .map((b: { callback_data: string }) => b.callback_data);

async function send(update: Parameters<typeof bot.handleUpdate>[0]) {
  calls.length = 0;
  await bot.handleUpdate(update);
}

async function userIdOf(person: TelegramPerson) {
  const [user] = await db.select().from(users).where(eq(users.telegramUserId, person.id));
  return user!.id;
}

async function start(person: TelegramPerson = DANA) {
  await send(textUpdate("/start", person));
  await send(callbackUpdate(encodeCallback({ type: "set_language", language: "en" }), person));
}

async function onboard(person: TelegramPerson = DANA) {
  await start(person);
  await send(textUpdate("linkedin.com/in/dana-levi", person));
  await send(documentUpdate({ fileName: "cv.txt", mimeType: "text/plain" }, person));
  await send(callbackUpdate(encodeCallback({ type: "onboarding_analyze" }), person));
  await send(textUpdate("skip", person));
  await send(textUpdate("skip", person));
  await send(callbackUpdate(encodeCallback({ type: "onboarding_confirm" }), person));
  return userIdOf(person);
}

describe("career-profile onboarding", () => {
  it("imports LinkedIn and CV, asks follow-ups and saves facts only after review", async () => {
    await send(textUpdate("/start"));
    expect(sent()).toEqual([ASK_LANGUAGE]);
    expect(lastKeyboardData()).toEqual(["lang:en", "lang:he"]);

    await send(callbackUpdate(encodeCallback({ type: "set_language", language: "en" })));
    expect(sent()).toEqual([messages.languageSaved, messages.welcomeNew, messages.askLinkedin]);

    await send(textUpdate("Sure: https://www.linkedin.com/in/dana-levi/"));
    expect(sent()[0]).toContain(messages.linkedinSaved);
    expect(sent()[0]).toContain("Save to PDF");

    await send(documentUpdate({ fileName: "cv.txt", mimeType: "text/plain" }));
    expect(calls.some((c) => c.method === "getFile")).toBe(true);
    expect(sent()[0]).toContain("Got your CV (cv.txt)");
    expect(lastKeyboardData()).toEqual([encodeCallback({ type: "onboarding_analyze" })]);

    fileContent = "Dana Levi\nContact\nwww.linkedin.com/in/dana-levi\nExperience\nAcme Ltd\nHR Manager\nPage 1 of 2";
    await send(documentUpdate({ fileName: "Profile.txt", mimeType: "text/plain" }));
    expect(sent()[0]).toContain("Got your LinkedIn export");

    await send(callbackUpdate(encodeCallback({ type: "onboarding_analyze" })));
    expect(sent()).toEqual([messages.analyzing, expect.stringContaining("Question 1 of 2")]);
    expect(assistant.extractCalls).toEqual([
      {
        linkedinUrl: "https://www.linkedin.com/in/dana-levi",
        sources: [
          { kind: "cv", content: CV_TEXT },
          { kind: "linkedin_export", content: expect.stringContaining("Page 1 of 2") },
        ],
        language: "en",
      },
    ]);

    const userId = await userIdOf(DANA);
    const draftFacts = await db.select().from(careerFacts).where(eq(careerFacts.userId, userId));
    expect(draftFacts.map((f) => f.verificationStatus)).toEqual(["unverified", "unverified", "unverified"]);

    assistant.interpretation = ({ question }) => {
      expect(question).toBe("Which roles are you targeting?");
      return {
        reply: null,
        changes: [
          {
            op: "add_preference",
            preference: {
              kind: "target_role",
              dimension: "role",
              label: "HR Business Partner",
              value: { type: "terms", terms: ["HR Business Partner"] },
            },
            replacesPreferenceId: null,
          },
        ],
      };
    };
    await send(textUpdate("HR business partner roles"));
    expect(sent()).toEqual([expect.stringContaining("Question 2 of 2")]);

    await send(textUpdate("skip"));
    expect(assistant.interpretCalls).toHaveLength(1);
    const review = sent().join("\n");
    expect(review).toContain(messages.reviewIntro);
    expect(review).toContain("<b>HR Manager</b> — Acme Ltd");
    expect(review).toContain("• Cut time-to-hire by 30%");
    expect(review).toContain("<b>Skills</b>\n• Workday");
    expect(review).toContain("<b>Target roles</b>\n• HR Business Partner");
    expect(lastKeyboardData()).toEqual([encodeCallback({ type: "onboarding_confirm" })]);

    await send(callbackUpdate(encodeCallback({ type: "onboarding_confirm" })));
    expect(sent()).toEqual([messages.onboardingDone]);

    const facts = await db.select().from(careerFacts).where(eq(careerFacts.userId, userId));
    expect(facts.every((f) => f.verificationStatus === "verified" && f.verifiedAt)).toBe(true);
    const [experience] = await db.select().from(workExperiences).where(eq(workExperiences.userId, userId));
    expect(experience).toMatchObject({ employer: "Acme Ltd", verificationStatus: "verified", origin: "cv_upload" });
    const [pref] = await db.select().from(preferences).where(eq(preferences.userId, userId));
    expect(pref).toMatchObject({ kind: "target_role", status: "active", origin: "onboarding" });
    expect(pref!.decidedAt).not.toBeNull();
    const [profile] = await db.select().from(careerProfiles).where(eq(careerProfiles.userId, userId));
    expect(profile).toMatchObject({ status: "confirmed", headline: "HR Manager", revision: 2 });
    const [cv] = await db.select().from(masterCvs).where(eq(masterCvs.userId, userId));
    expect(cv!.originalText).toBe(CV_TEXT);

    await send(callbackUpdate(encodeCallback({ type: "onboarding_confirm" })));
    expect(sent()).toEqual([messages.expired]);
    await send(textUpdate("/start"));
    expect(sent()).toEqual([messages.welcomeBack]);
  });

  it("applies corrections during review before anything is confirmed", async () => {
    assistant.extraction = { changes: EXTRACTION, followUpQuestions: [] };
    await start();
    await send(textUpdate("skip"));
    await send(textUpdate("I was HR manager at Acme since 2019 and I know Workday"));
    expect(sent()[0]).toContain("Got your notes");
    await send(callbackUpdate(encodeCallback({ type: "onboarding_analyze" })));
    expect(sent()[1]).toContain(messages.reviewIntro);

    const userId = await userIdOf(DANA);
    assistant.interpretation = ({ snapshot }) => {
      const workday = snapshot.facts.find((f) => f.statement === "Workday")!;
      return { reply: null, changes: [{ op: "remove_fact", factId: workday.id }] };
    };
    await send(textUpdate("Remove Workday, I barely used it"));
    const review = sent().join("\n");
    expect(review).toContain(messages.reviewUpdated);
    expect(review).not.toContain("Workday");

    const [removed] = await db
      .select()
      .from(careerFacts)
      .where(and(eq(careerFacts.userId, userId), eq(careerFacts.statement, "Workday")));
    expect(removed!.verificationStatus).toBe("rejected");
    const [profile] = await db.select().from(careerProfiles).where(eq(careerProfiles.userId, userId));
    expect(profile!.status).toBe("draft");
  });

  it("needs at least one source before analyzing", async () => {
    await start();
    await send(textUpdate("skip"));
    expect(sent()[0]).toContain(messages.linkedinSkipped);
    await send(callbackUpdate(encodeCallback({ type: "onboarding_analyze" })));
    expect(sent()).toEqual([messages.analyzing, messages.needSource]);
    expect(assistant.extractCalls).toHaveLength(0);
  });

  it("rejects unreadable and unexpected documents", async () => {
    await start();
    await send(documentUpdate({ fileName: "photo.jpg", mimeType: "image/jpeg" }));
    expect(sent()).toEqual([messages.unreadableDocument]);
    await send(documentUpdate({ fileName: "huge.pdf", mimeType: "application/pdf", fileSize: 50_000_000 }));
    expect(sent()).toEqual([messages.documentTooLarge]);

    await onboard(NOA);
    await send(documentUpdate({ fileName: "cv.txt", mimeType: "text/plain" }, NOA));
    expect(sent()).toEqual([messages.documentNotExpected]);
  });

  it("restarts cleanly from /start before the profile is confirmed", async () => {
    await start();
    await send(textUpdate("skip"));
    await send(documentUpdate({ fileName: "cv.txt", mimeType: "text/plain" }));
    await send(callbackUpdate(encodeCallback({ type: "onboarding_analyze" })));
    const userId = await userIdOf(DANA);
    expect(await db.select().from(careerFacts).where(eq(careerFacts.userId, userId))).toHaveLength(3);

    await send(textUpdate("/start"));
    expect(sent()).toEqual([messages.welcomeNew, messages.askLinkedin]);
    expect(await db.select().from(careerFacts).where(eq(careerFacts.userId, userId))).toHaveLength(0);
    expect(await db.select().from(profileSources).where(eq(profileSources.userId, userId))).toHaveLength(0);
  });
});

describe("continuous profile editing", () => {
  it("asks users without a profile to onboard first", async () => {
    await send(textUpdate("I don't want recruiting roles"));
    expect(sent()).toEqual([messages.notOnboarded]);
    expect(assistant.interpretCalls).toHaveLength(0);
  });

  it("confirms an inferred preference change before making it durable", async () => {
    assistant.interpretation = () => ({
      reply: null,
      changes: [
        {
          op: "add_preference",
          preference: {
            kind: "target_role",
            dimension: "role",
            label: "Recruiting roles",
            value: { type: "terms", terms: ["recruiter"] },
          },
          replacesPreferenceId: null,
        },
      ],
    });
    assistant.extraction = { changes: EXTRACTION, followUpQuestions: ["Which roles?", "Work mode?"] };
    await start();
    await send(textUpdate("skip"));
    await send(documentUpdate({ fileName: "cv.txt", mimeType: "text/plain" }));
    await send(callbackUpdate(encodeCallback({ type: "onboarding_analyze" })));
    await send(textUpdate("Recruiting"));
    await send(textUpdate("skip"));
    await send(callbackUpdate(encodeCallback({ type: "onboarding_confirm" })));
    const userId = await userIdOf(DANA);

    assistant.interpretation = ({ snapshot }) => {
      const recruiting = snapshot.preferences.find((p) => p.label === "Recruiting roles")!;
      return {
        reply: null,
        changes: [
          { op: "remove_preference", preferenceId: recruiting.id },
          {
            op: "add_preference",
            preference: {
              kind: "dislike",
              dimension: "role",
              label: "No recruiting roles",
              value: { type: "terms", terms: ["recruiting"] },
            },
            replacesPreferenceId: null,
          },
        ],
      };
    };
    await send(textUpdate("I'm no longer interested in recruiting roles"));
    const proposal = sent().join("\n");
    expect(proposal).toContain(messages.editProposed);
    expect(proposal).toContain("➖ target role: Recruiting roles");
    expect(proposal).toContain("➕ avoid: No recruiting roles");
    const [applyData, cancelData] = lastKeyboardData();
    expect(applyData).toMatch(/^pe:a:/);
    expect(cancelData).toMatch(/^pe:c:/);

    const before = await db.select().from(preferences).where(eq(preferences.userId, userId));
    expect(before.map((p) => [p.label, p.status])).toEqual([["Recruiting roles", "active"]]);

    await send(callbackUpdate(applyData!));
    expect(sent()).toEqual([messages.editApplied]);
    const after = await db.select().from(preferences).where(eq(preferences.userId, userId));
    expect(after.map((p) => [p.label, p.status, p.origin])).toEqual([
      ["Recruiting roles", "retired", "onboarding"],
      ["No recruiting roles", "active", "user_stated"],
    ]);
    const [profile] = await db.select().from(careerProfiles).where(eq(careerProfiles.userId, userId));
    expect(profile!.revision).toBe(3);

    await send(callbackUpdate(applyData!));
    expect(sent()).toEqual([messages.expired]);
  });

  it("adds a verified fact to an existing role on confirmation", async () => {
    const userId = await onboard();
    assistant.interpretation = ({ snapshot }) => ({
      reply: null,
      changes: [
        {
          op: "add_fact",
          kind: "achievement",
          statement: "Managed the payroll migration to Workday",
          experienceId: snapshot.experiences[0]!.id,
          experienceRef: null,
          origin: "conversation",
        },
      ],
    });
    await send(textUpdate("Add that I managed the payroll migration to Workday"));
    expect(sent().join("\n")).toContain("➕ achievement: Managed the payroll migration to Workday (HR Manager at Acme Ltd)");
    expect(
      await db.select().from(careerFacts).where(eq(careerFacts.statement, "Managed the payroll migration to Workday")),
    ).toHaveLength(0);

    await send(callbackUpdate(lastKeyboardData()[0]!));
    const [fact] = await db
      .select()
      .from(careerFacts)
      .where(eq(careerFacts.statement, "Managed the payroll migration to Workday"));
    const [experience] = await db.select().from(workExperiences).where(eq(workExperiences.userId, userId));
    expect(fact).toMatchObject({
      userId,
      workExperienceId: experience!.id,
      verificationStatus: "verified",
      origin: "conversation",
    });

    await send(textUpdate("/profile"));
    expect(sent().join("\n")).toContain("• Managed the payroll migration to Workday");
  });

  it("discards a cancelled edit", async () => {
    const userId = await onboard();
    assistant.interpretation = ({ snapshot }) => ({
      reply: null,
      changes: [{ op: "remove_experience", experienceId: snapshot.experiences[0]!.id }],
    });
    await send(textUpdate("Remove Acme"));
    expect(sent().join("\n")).toContain("➖ Role: HR Manager at Acme Ltd");
    await send(callbackUpdate(lastKeyboardData()[1]!));
    expect(sent()).toEqual([messages.editCancelled]);
    const [experience] = await db.select().from(workExperiences).where(eq(workExperiences.userId, userId));
    expect(experience!.verificationStatus).toBe("verified");
    const [state] = await db.select().from(conversationStates).where(eq(conversationStates.userId, userId));
    expect(state).toMatchObject({ flow: "idle", context: {} });
  });

  it("replies without proposing changes when nothing applies", async () => {
    await onboard();
    assistant.interpretation = () => ({ reply: "I can only update your profile.", changes: [] });
    await send(textUpdate("What's the weather?"));
    expect(sent()).toEqual(["I can only update your profile."]);
  });
});

describe("multi-user isolation", () => {
  it("never lets one user's edits touch another user's profile", async () => {
    const danaId = await onboard(DANA);
    const noaId = await onboard(NOA);
    const [danaFact] = await db.select().from(careerFacts).where(eq(careerFacts.userId, danaId));
    const [danaExperience] = await db.select().from(workExperiences).where(eq(workExperiences.userId, danaId));

    assistant.interpretation = ({ snapshot }) => {
      expect(snapshot.facts.map((f) => f.id)).not.toContain(danaFact!.id);
      return {
        reply: null,
        changes: [
          { op: "remove_fact", factId: danaFact!.id },
          { op: "update_fact", factId: danaFact!.id, kind: null, statement: "hijacked" },
          { op: "remove_experience", experienceId: danaExperience!.id },
          {
            op: "add_fact",
            kind: "skill",
            statement: "Excel",
            experienceId: danaExperience!.id,
            experienceRef: null,
            origin: "conversation",
          },
        ],
      };
    };
    await send(textUpdate("Remove that fact", NOA));
    await send(callbackUpdate(lastKeyboardData()[0]!, NOA));
    expect(sent()).toEqual([messages.editApplied]);

    const danaFacts = await db.select().from(careerFacts).where(eq(careerFacts.userId, danaId));
    expect(danaFacts.map((f) => f.verificationStatus)).toEqual(["verified", "verified", "verified"]);
    expect(danaFacts.map((f) => f.statement)).not.toContain("hijacked");
    const [stillDana] = await db.select().from(workExperiences).where(eq(workExperiences.id, danaExperience!.id));
    expect(stillDana!.verificationStatus).toBe("verified");
    const [excel] = await db.select().from(careerFacts).where(eq(careerFacts.statement, "Excel"));
    expect(excel).toMatchObject({ userId: noaId, workExperienceId: null });
  });

  it("keeps pending edits and confirmations per user", async () => {
    await onboard(DANA);
    await onboard(NOA);
    assistant.interpretation = ({ snapshot }) => ({
      reply: null,
      changes: [{ op: "update_profile", fields: { headline: `Edited ${snapshot.facts.length}` } }],
    });
    await send(textUpdate("Change my headline", DANA));
    const danaApply = lastKeyboardData()[0]!;

    await send(callbackUpdate(danaApply, NOA));
    expect(sent()).toEqual([messages.expired]);

    await send(callbackUpdate(danaApply, DANA));
    expect(sent()).toEqual([messages.editApplied]);
    const profiles = await db.select().from(careerProfiles);
    const byUser = new Map(profiles.map((p) => [p.userId, p.headline]));
    expect(byUser.get(await userIdOf(DANA))).toBe("Edited 3");
    expect(byUser.get(await userIdOf(NOA))).toBe("HR Manager");
  });
});

describe("conversation language", () => {
  const languageOf = async (person: TelegramPerson = DANA) => {
    const [user] = await db.select().from(users).where(eq(users.telegramUserId, person.id));
    return user!.preferredLanguage;
  };

  it("lets a new user answer the language question in text and keeps asking until it is clear", async () => {
    await send(textUpdate("/start"));
    await send(textUpdate("French"));
    expect(sent()).toEqual([ASK_LANGUAGE]);
    expect(await languageOf()).toBeNull();

    await send(textUpdate("עברית"));
    const he = strings("he").messages;
    expect(sent()).toEqual([he.languageSaved, he.welcomeNew, he.askLinkedin]);
    expect(await languageOf()).toBe("he");
  });

  it("keeps the choice across restarts without asking again", async () => {
    await start();
    bot = createBot("test-token", createPgServices(db, assistant, new FakeCvTailorer()), { botInfo: BOT_INFO });
    calls = captureApiCalls(bot);

    await send(textUpdate("/start"));
    expect(sent()).toEqual([messages.welcomeNew, messages.askLinkedin]);
    await send(textUpdate("/language"));
    expect(sent()[0]).toContain("<b>English</b>");
    expect(lastKeyboardData()).toEqual(["lang:en", "lang:he"]);
    expect(calls.at(-1)!.payload.reply_markup.inline_keyboard[0][0].text).toBe("✅ English");
  });

  it("switches language from settings or a request without touching the profile", async () => {
    const userId = await onboard();
    const factsBefore = await db.select().from(careerFacts).where(eq(careerFacts.userId, userId));
    const [profileBefore] = await db.select().from(careerProfiles).where(eq(careerProfiles.userId, userId));

    await send(textUpdate("Switch to Hebrew"));
    expect(sent()).toEqual([strings("he").messages.languageSaved]);
    expect(assistant.interpretCalls).toHaveLength(0);
    expect(await languageOf()).toBe("he");

    await send(textUpdate("/language"));
    expect(sent()[0]).toContain("<b>עברית</b>");
    await send(callbackUpdate(encodeCallback({ type: "set_language", language: "en" })));
    expect(sent()).toEqual([messages.languageSaved]);
    expect(await languageOf()).toBe("en");

    await send(textUpdate("תדבר איתי בעברית"));
    expect(await languageOf()).toBe("he");

    await send(textUpdate("change language"));
    expect(sent()[0]).toContain("לחצו על שפה כדי לשנות");

    const factsAfter = await db.select().from(careerFacts).where(eq(careerFacts.userId, userId));
    const [profileAfter] = await db.select().from(careerProfiles).where(eq(careerProfiles.userId, userId));
    expect(factsAfter).toEqual(factsBefore);
    expect(profileAfter).toEqual(profileBefore);
    const [state] = await db.select().from(conversationStates).where(eq(conversationStates.userId, userId));
    expect(state!.flow).toBe("idle");
  });

  it("asks an existing user without a language once, after handling their message", async () => {
    const [user] = await db.insert(users).values({ telegramUserId: DANA.id, telegramChatId: DANA.id }).returning();
    await db.insert(careerProfiles).values({ userId: user!.id, status: "confirmed" });
    expect(user!.preferredLanguage).toBeNull();

    await send(textUpdate("/new"));
    expect(sent()).toEqual([messages.noMatches, ASK_LANGUAGE]);
    await send(textUpdate("/new"));
    expect(sent()).toEqual([messages.noMatches]);

    await send(callbackUpdate(encodeCallback({ type: "set_language", language: "he" })));
    expect(sent()).toEqual([strings("he").messages.languageSaved]);
    expect(await languageOf()).toBe("he");
  });

  it("does not ask an existing user who already chose a language", async () => {
    const [user] = await db
      .insert(users)
      .values({ telegramUserId: DANA.id, telegramChatId: DANA.id, preferredLanguage: "en" })
      .returning();
    await db.insert(careerProfiles).values({ userId: user!.id, status: "confirmed" });
    await send(textUpdate("/new"));
    expect(sent()).toEqual([messages.noMatches]);
  });
});
