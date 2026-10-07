import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgServices } from "../src/app/postgres/index.js";
import { createBot } from "../src/bot/bot.js";
import { encodeCallback } from "../src/bot/callbacks.js";
import {
  careerFacts,
  cvVersions,
  duplicateGroups,
  jobSources,
  jobs,
  matches,
  rawJobRecords,
  sourceDocuments,
  users,
  workExperiences,
} from "../src/db/schema.js";
import { parseCvLibraryRequest } from "../src/domain/cv-library.js";
import type { ProfileChange } from "../src/domain/profile.js";
import { strings } from "../src/i18n/index.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { createTestDb, expectDbError, type TestDb } from "./support/db.js";
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
const he = strings("he");

const ENGLISH_CV = "Dana Levi\nHR Manager, Acme Ltd, 2019 - present\nManaged a team of 6 recruiters\nCut time-to-hire by 30%";
const HEBREW_CV = "דנה לוי\nמנהלת משאבי אנוש, Acme בעמ, 2019 - היום\nניהלה צוות של 6 מגייסים\nקיצרה את זמן הגיוס ב-30%";
const MIXED_CV = "דנה לוי, מנהלת משאבי אנוש\nDana Levi, HR Manager, Acme, Workday, SuccessFactors";

const EXTRACTION: ProfileChange[] = [
  {
    op: "add_experience",
    ref: "x0",
    origin: "cv_upload",
    experience: {
      employer: "Acme Ltd",
      title: "HR Manager",
      industry: null,
      location: null,
      seniority: "manager",
      managedHeadcount: 6,
      startDate: "2019-01-01",
      endDate: null,
      isCurrent: true,
    },
  },
  { op: "add_fact", kind: "achievement", statement: "Cut time-to-hire by 30%", experienceId: null, experienceRef: "x0", origin: "cv_upload" },
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
  fileContent = ENGLISH_CV;
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
const inlineButtons = (payloads = sentMessages()): { text: string; callback_data: string }[] =>
  payloads.flatMap((p) => p.reply_markup?.inline_keyboard?.flat() ?? []);
const toast = () => calls.find((c) => c.method === "answerCallbackQuery")?.payload.text as string | undefined;
const edited = () => calls.find((c) => c.method === "editMessageText")?.payload;

async function send(update: Parameters<typeof bot.handleUpdate>[0]) {
  calls.length = 0;
  await bot.handleUpdate(update);
}

async function upload(fileName: string, content: string, person: TelegramPerson = DANA, caption?: string) {
  fileContent = content;
  await send(documentUpdate({ fileName, mimeType: fileName.endsWith(".doc") ? "application/msword" : "text/plain", caption }, person));
}

async function userIdOf(person: TelegramPerson) {
  const [user] = await db.select().from(users).where(eq(users.telegramUserId, person.id));
  return user!.id;
}

const documentsOf = async (userId: string) =>
  db.select().from(sourceDocuments).where(eq(sourceDocuments.userId, userId)).orderBy(sourceDocuments.createdAt);

const documentByName = async (userId: string, fileName: string) =>
  (await documentsOf(userId)).find((d) => d.fileName === fileName)!;

/** Onboards with an English and a Hebrew CV; the role and achievement come from the English one, Workday from the Hebrew one. */
async function onboard(person: TelegramPerson = DANA, language: "en" | "he" = "en") {
  await send(textUpdate("/start", person));
  await send(callbackUpdate(encodeCallback({ type: "set_language", language }), person));
  await send(textUpdate("skip", person));
  await upload("cv-en.txt", ENGLISH_CV, person);
  await upload("cv-he.txt", HEBREW_CV, person);
  const userId = await userIdOf(person);
  const english = await documentByName(userId, "cv-en.txt");
  const hebrew = await documentByName(userId, "cv-he.txt");
  const from = (change: ProfileChange, documentId: string): ProfileChange =>
    change.op === "add_experience" || change.op === "add_fact" ? { ...change, sourceDocumentId: documentId } : change;
  assistant.extraction = {
    changes: [from(EXTRACTION[0]!, english.id), from(EXTRACTION[1]!, english.id), from(EXTRACTION[2]!, hebrew.id)],
    followUpQuestions: [],
  };
  await send(callbackUpdate(encodeCallback({ type: "onboarding_analyze" }), person));
  await send(callbackUpdate(encodeCallback({ type: "onboarding_confirm" }), person));
  return { userId, english, hebrew };
}

describe("CV library", () => {
  it("asks users without a confirmed profile to onboard first", async () => {
    await send(textUpdate("/cvs"));
    expect(sent()).toEqual([en.messages.notOnboarded]);
  });

  it("lists every CV with its language, file type and the default for each language", async () => {
    const { userId } = await onboard();
    await upload("cv-old.doc", "binary");
    expect(sent()).toEqual([en.messages.legacyDoc]);

    await send(textUpdate("/cvs"));
    const [list] = sent();
    expect(list).toContain(en.cvs.title);
    expect(list).toContain(
      `1. <b>cv-old.doc</b>\nDocument · DOC · added ${new Date().toISOString().slice(0, 10)}\n${en.cvs.failures.legacy}`,
    );
    expect(list).toMatch(/2\. <b>cv-he\.txt<\/b>\nCV · Hebrew \(detected\) · TXT · added [\d-]+\n⭐ Default for Hebrew/);
    expect(list).toMatch(/3\. <b>cv-en\.txt<\/b>\nCV · English \(detected\) · TXT · added [\d-]+\n⭐ Default for English/);
    expect(list).toContain(en.cvs.outro);
    const buttons = inlineButtons();
    expect(buttons.map((b) => b.text)).toEqual(["1. cv-old.doc", "2. cv-he.txt", "3. cv-en.txt", en.buttons.addCv]);
    const failed = await documentByName(userId, "cv-old.doc");
    expect(buttons[0]!.callback_data).toBe(encodeCallback({ type: "document", documentId: failed.id }));

    await send(textUpdate("show my CVs"));
    expect(sent()[0]).toContain(en.cvs.title);
    await send(callbackUpdate(encodeCallback({ type: "document_upload" })));
    expect(sent()).toEqual([en.cvs.uploadHowTo]);
  });

  it("shows a CV's details, how many profile facts came from it and what can be done with it", async () => {
    const { english } = await onboard();
    await send(callbackUpdate(encodeCallback({ type: "document", documentId: english.id })));
    const [card] = sent();
    expect(card).toContain("📄 <b>cv-en.txt</b>");
    expect(card).toContain(en.cvs.defaultExplained("English"));
    expect(card).toContain(en.cvs.facts(2));
    expect(inlineButtons().map((b) => b.text)).toEqual([
      en.documents.languageButton("Hebrew", true),
      en.buttons.rename,
      en.buttons.replace,
      en.buttons.remove,
      en.buttons.myCvs,
    ]);
  });

  it("makes another CV the default for its language and uses it when tailoring", async () => {
    const { userId, english } = await onboard();
    await upload("cv-en-2026.txt", `${ENGLISH_CV}\nWorkday`);
    expect(sent()[0]).toContain("Saved your CV (cv-en-2026.txt) · English · version 2 ✅");
    expect(inlineButtons().map((b) => b.text)).toContain(en.buttons.myCvs);
    const newer = await documentByName(userId, "cv-en-2026.txt");

    await send(callbackUpdate(encodeCallback({ type: "document", documentId: english.id })));
    expect(sent()[0]).not.toContain("⭐");
    expect(inlineButtons()[0]!.text).toBe(en.buttons.makeDefault("English"));

    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: english.id, action: "default" })));
    expect(toast()).toBe(en.cvs.defaultFor("English"));
    expect(edited()!.text).toContain(en.cvs.defaultFor("English"));
    expect((await documentsOf(userId)).filter((d) => d.isDefault).map((d) => d.id)).toEqual([english.id]);

    await send(textUpdate("/cvs"));
    expect(sent()[0]).toMatch(/<b>cv-en-2026\.txt<\/b>\n[^\n]+\n\n/);
    expect(sent()[0]).toMatch(/<b>cv-en\.txt<\/b>\n[^\n]+\n⭐ Default for English/);

    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: newer.id, action: "default" })));
    expect((await documentsOf(userId)).filter((d) => d.isDefault).map((d) => d.id)).toEqual([newer.id]);

    const matchId = await seedMatch(userId, "Own hiring and onboarding for a team of 150.");
    await send(callbackUpdate(encodeCallback({ type: "tailor_cv", matchId })));
    const [version] = await db.select().from(cvVersions).where(eq(cvVersions.matchId, matchId));
    expect(version!.sourceDocumentId).toBe(newer.id);
  });

  it("tailors from the default CV in the job's language", async () => {
    const { userId, hebrew } = await onboard();
    const matchId = await seedMatch(userId, "דרוש/ה מנהל/ת משאבי אנוש לחברה צומחת, ניסיון בגיוס חובה");
    await send(callbackUpdate(encodeCallback({ type: "tailor_cv", matchId })));
    const [version] = await db.select().from(cvVersions).where(eq(cvVersions.matchId, matchId));
    expect(version!.sourceDocumentId).toBe(hebrew.id);
  });

  it("refuses to make an unreadable document a default", async () => {
    const { userId } = await onboard();
    await upload("cv-old.doc", "binary");
    const failed = await documentByName(userId, "cv-old.doc");
    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: failed.id, action: "default" })));
    expect(toast()).toBe(en.cvs.notEligible);
    await expectDbError(
      db.update(sourceDocuments).set({ isDefault: true }).where(eq(sourceDocuments.id, failed.id)),
      /source_documents_default_chk/,
    );
  });

  it("maps natural-language default requests to the same setting", async () => {
    const { userId, english, hebrew } = await onboard();
    await send(textUpdate("Use my English CV by default"));
    expect(sent()).toEqual([en.cvs.defaultSet("cv-en.txt", "English")]);
    expect((await documentsOf(userId)).filter((d) => d.isDefault).map((d) => d.id)).toEqual([english.id]);

    await send(textUpdate("תשתמש בקורות החיים בעברית כברירת מחדל"));
    expect(sent()).toEqual([en.cvs.defaultSet("cv-he.txt", "Hebrew")]);
    expect((await documentsOf(userId)).filter((d) => d.isDefault).map((d) => d.id).sort()).toEqual([english.id, hebrew.id].sort());

    await upload("cv-en-2026.txt", `${ENGLISH_CV}\nWorkday`);
    await send(textUpdate("make my English resume the default"));
    expect(sent()).toEqual([en.cvs.chooseDefault("English")]);
    expect(inlineButtons().map((b) => b.text)).toEqual(["cv-en-2026.txt", "⭐ cv-en.txt"]);

    await send(textUpdate("which CV is my default?"));
    expect(sent()).toEqual([en.cvs.chooseDefault(null)]);
    expect(inlineButtons()).toHaveLength(3);
  });

  it("says when there is no CV in the requested language", async () => {
    await send(textUpdate("/start"));
    await send(callbackUpdate(encodeCallback({ type: "set_language", language: "en" })));
    await send(textUpdate("skip"));
    await upload("cv-en.txt", ENGLISH_CV);
    await send(callbackUpdate(encodeCallback({ type: "onboarding_analyze" })));
    await send(callbackUpdate(encodeCallback({ type: "onboarding_confirm" })));

    await send(textUpdate("use my Hebrew CV by default"));
    expect(sent()).toEqual([en.cvs.noCvs("Hebrew")]);
  });

  it("renames a CV with the next message, even one that looks like another request", async () => {
    const { userId, english } = await onboard();
    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: english.id, action: "label" })));
    expect(sent()).toEqual([en.cvs.labelPrompt("cv-en.txt")]);

    await send(textUpdate("English"));
    expect(sent()[0]).toBe(en.cvs.labelSaved("English"));
    expect(sent()[1]).toContain("📄 <b>English</b>");
    expect(sent()[1]).toContain("CV · English (detected) · TXT · cv-en.txt");
    expect((await documentByName(userId, "cv-en.txt")).label).toBe("English");
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect(user!.preferredLanguage).toBe("en");

    await send(textUpdate("Switch to Hebrew"));
    expect(sent()).toEqual([he.messages.languageSaved]);
  });

  it("corrects a CV's language from its details and keeps defaults one per language", async () => {
    const { userId, english, hebrew } = await onboard();
    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: english.id, action: "default" })));
    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: hebrew.id, action: "default" })));

    await send(callbackUpdate(encodeCallback({ type: "document_language", documentId: english.id, language: "he" })));
    expect(edited()).toBeUndefined();
    expect(await documentByName(userId, "cv-en.txt")).toMatchObject({ language: "he", languageConfirmed: true, isDefault: false });
    expect((await documentsOf(userId)).filter((d) => d.isDefault).map((d) => d.id)).toEqual([hebrew.id]);
  });

  it("refreshes the details card when the language is corrected there", async () => {
    const { english } = await onboard();
    await send(callbackUpdate(encodeCallback({ type: "document", documentId: english.id })));
    const keyboard = sentMessages()[0]!.reply_markup;
    const update = callbackUpdate(encodeCallback({ type: "document_language", documentId: english.id, language: "he" }));
    (update.callback_query!.message as { reply_markup?: unknown }).reply_markup = keyboard;
    await send(update);
    expect(edited()!.text).toContain("CV · Hebrew · TXT");
    expect(edited()!.text).not.toContain("⭐");
    expect(edited()!.reply_markup.inline_keyboard[0][0].text).toBe(en.buttons.makeDefault("Hebrew"));
  });

  it("removes a CV after confirmation without touching profile facts", async () => {
    const { userId, english, hebrew } = await onboard();
    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: english.id, action: "remove" })));
    expect(sent()).toEqual([en.cvs.removeConfirm("cv-en.txt", 2)]);
    expect(inlineButtons().map((b) => b.callback_data)).toEqual([
      encodeCallback({ type: "document_action", documentId: english.id, action: "confirm_remove" }),
      encodeCallback({ type: "document", documentId: english.id }),
    ]);
    expect((await documentByName(userId, "cv-en.txt")).removedAt).toBeNull();

    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: english.id, action: "confirm_remove" })));
    expect(sent()).toEqual([en.cvs.removed("cv-en.txt")]);
    expect((await documentByName(userId, "cv-en.txt")).removedAt).not.toBeNull();

    const facts = await db.select().from(careerFacts).where(eq(careerFacts.userId, userId));
    expect(facts.map((f) => [f.statement, f.verificationStatus, f.sourceDocumentId]).sort()).toEqual([
      ["Cut time-to-hire by 30%", "verified", english.id],
      ["Workday", "verified", hebrew.id],
    ]);
    const [role] = await db.select().from(workExperiences).where(eq(workExperiences.userId, userId));
    expect(role).toMatchObject({ verificationStatus: "verified", sourceDocumentId: english.id });

    await send(textUpdate("/cvs"));
    expect(sent()[0]).not.toContain("cv-en.txt");
    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: english.id, action: "confirm_remove" })));
    expect(toast()).toBe(en.messages.expired);
    await send(callbackUpdate(encodeCallback({ type: "document", documentId: english.id })));
    expect(toast()).toBe(en.messages.expired);
  });

  it("replaces a CV with the next upload, keeping its name, default and every profile fact", async () => {
    const { userId, english, hebrew } = await onboard();
    await send(textUpdate("use my English CV by default"));
    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: english.id, action: "label" })));
    await send(textUpdate("Main CV"));

    await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: english.id, action: "replace" })));
    expect(sent()).toEqual([en.cvs.replacePrompt("Main CV")]);

    await upload("cv-old.doc", "binary");
    expect(sent()).toEqual([en.messages.legacyDoc]);
    expect((await documentByName(userId, "cv-en.txt")).removedAt).toBeNull();

    const updated = `${ENGLISH_CV}\nHead of People, Globex, 2026 - present`;
    assistant.merge = () => ({ reply: null, changes: [] });
    await upload("cv-en-2026.txt", updated);
    expect(sent()[0]).toBe(en.documents.replaced(en.sources.cv, "cv-en-2026.txt", "English", "Main CV"));
    expect(sent()[1]).toBe(en.messages.documentNothingNew);

    const old = await documentByName(userId, "cv-en.txt");
    const added = await documentByName(userId, "cv-en-2026.txt");
    expect(old).toMatchObject({ isDefault: false, label: "Main CV" });
    expect(old.removedAt).not.toBeNull();
    expect(added).toMatchObject({ isDefault: true, label: "Main CV", language: "en", extractedText: updated, fileRef: expect.any(String) });
    expect(assistant.mergeCalls.at(-1)!.document.documentId).toBe(added.id);

    const facts = await db
      .select({ statement: careerFacts.statement, sourceDocumentId: careerFacts.sourceDocumentId })
      .from(careerFacts)
      .where(and(eq(careerFacts.userId, userId), eq(careerFacts.verificationStatus, "verified")));
    expect(facts.map((f) => [f.statement, f.sourceDocumentId]).sort()).toEqual([
      ["Cut time-to-hire by 30%", english.id],
      ["Workday", hebrew.id],
    ]);

    await upload("cv-en-2027.txt", `${updated}\nWorkday`);
    expect(sent()[0]).toContain("Saved your CV (cv-en-2027.txt)");
    expect((await documentByName(userId, "cv-en-2026.txt")).removedAt).toBeNull();
  });

  it("asks for the language when it cannot tell", async () => {
    await onboard();
    await upload("cv-mixed.txt", MIXED_CV);
    expect(sent()[0]).toContain(en.cvs.askLanguage);
    expect(inlineButtons().map((b) => b.text)).toEqual([
      en.documents.languageButton("English", false),
      en.documents.languageButton("Hebrew", false),
      en.buttons.myCvs,
    ]);

    await send(textUpdate("/start", NOA));
    await send(callbackUpdate(encodeCallback({ type: "set_language", language: "en" }), NOA));
    await send(textUpdate("skip", NOA));
    await upload("cv-mixed.txt", MIXED_CV, NOA);
    expect(sent()[0]).toContain(en.cvs.askLanguage);
    expect(inlineButtons().map((b) => b.text)).toEqual([
      en.documents.languageButton("English", false),
      en.documents.languageButton("Hebrew", false),
      en.buttons.analyze,
    ]);
  });

  it("never lets one user manage another user's CVs", async () => {
    const { userId, english } = await onboard();
    await onboard(NOA);
    for (const action of ["default", "label", "replace", "remove", "confirm_remove"] as const) {
      await send(callbackUpdate(encodeCallback({ type: "document_action", documentId: english.id, action }), NOA));
      expect(toast()).toBe(en.messages.expired);
    }
    await send(callbackUpdate(encodeCallback({ type: "document", documentId: english.id }), NOA));
    expect(toast()).toBe(en.messages.expired);
    const mine = await db
      .select()
      .from(sourceDocuments)
      .where(and(eq(sourceDocuments.userId, userId), isNull(sourceDocuments.removedAt)));
    expect(mine).toHaveLength(2);
  });

  it("works in Hebrew", async () => {
    const { english } = await onboard(DANA, "he");
    await send(textUpdate("/cvs"));
    expect(sent()[0]).toContain(he.cvs.title);
    expect(sent()[0]).toContain(he.cvs.defaultFor(he.documentLanguages.en));
    expect(sent()[0]).toContain(he.cvs.outro);
    await send(textUpdate("תראה לי את קורות החיים שלי"));
    expect(sent()[0]).toContain(he.cvs.title);

    await send(callbackUpdate(encodeCallback({ type: "document", documentId: english.id })));
    expect(sent()[0]).toContain(he.cvs.facts(2));
    expect(inlineButtons().map((b) => b.text)).toContain(he.buttons.rename);

    await send(textUpdate("השתמש בקורות החיים באנגלית כברירת מחדל"));
    expect(sent()).toEqual([he.cvs.defaultSet("cv-en.txt", he.documentLanguages.en)]);
    await send(textUpdate("/help"));
    expect(sent()[0]).toContain("/cvs");
  });
});

describe("parseCvLibraryRequest", () => {
  it.each([
    ["show my CVs", { kind: "list" }],
    ["My resumes?", { kind: "list" }],
    ["which CVs did I upload", { kind: "list" }],
    ["קורות החיים שלי", { kind: "list" }],
    ["תראה לי את כל קורות החיים שלי", { kind: "list" }],
    ["use my English CV by default", { kind: "default", language: "en" }],
    ["Set my default resume to Hebrew please", { kind: "default", language: "he" }],
    ["תשתמש בקו״ח באנגלית כברירת מחדל", { kind: "default", language: "en" }],
    ["קורות החיים בעברית יהיו ברירת המחדל", { kind: "default", language: "he" }],
    ["which CV is my default?", { kind: "default", language: null }],
  ])("reads %s", (text, request) => {
    expect(parseCvLibraryRequest(text)).toEqual(request);
  });

  it.each(["add Workday to my CV", "I want remote jobs by default", "switch to English", "my CV says I managed 6 people"])(
    "ignores %s",
    (text) => {
      expect(parseCvLibraryRequest(text)).toBeNull();
    },
  );
});

async function seedMatch(userId: string, description: string) {
  const [source] = await db.insert(jobSources).values({ key: `src-${description.length}`, name: "Source", kind: "api" }).returning();
  const [raw] = await db
    .insert(rawJobRecords)
    .values({ sourceId: source!.id, sourceUrl: "https://jobs.example/1", contentHash: "h", payload: {} })
    .returning();
  const [group] = await db.insert(duplicateGroups).values({ dedupKey: `k-${description.length}` }).returning();
  const [job] = await db
    .insert(jobs)
    .values({
      sourceId: source!.id,
      rawRecordId: raw!.id,
      sourceUrl: raw!.sourceUrl,
      title: "People Operations Lead",
      company: "Initech",
      description,
      collectedAt: new Date(),
      duplicateGroupId: group!.id,
      dedupMethod: "deterministic_key",
    })
    .returning();
  const [match] = await db
    .insert(matches)
    .values({ userId, jobId: job!.id, duplicateGroupId: group!.id, status: "notified", notifiedAt: new Date(), recommendation: "good_fit" })
    .returning();
  return match!.id;
}
