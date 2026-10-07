import { Api } from "grammy";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgServices } from "../src/app/postgres/index.js";
import type { MatchSummary } from "../src/app/services.js";
import { createBot } from "../src/bot/bot.js";
import { encodeCallback } from "../src/bot/callbacks.js";
import { TelegramNotifier } from "../src/bot/notifier.js";
import { ASK_LANGUAGE } from "../src/bot/views.js";
import {
  careerProfiles,
  duplicateGroups,
  jobSources,
  jobs,
  matchEvaluations,
  matches,
  rawJobRecords,
  users,
} from "../src/db/schema.js";
import type { ConversationLanguage } from "../src/domain/enums.js";
import { RLM } from "../src/i18n/he.js";
import { strings, type Strings } from "../src/i18n/index.js";
import { runNotifications } from "../src/pipeline/notify.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { BOT_INFO, DANA, callbackUpdate, captureApiCalls, textUpdate, type ApiCall } from "./support/telegram.js";

const HEBREW = /[֐-׿]/;
const LRM = "‎";

/** Direction Telegram gives a paragraph: that of its first strong character, ignoring HTML tags. */
function paragraphDirection(line: string): "rtl" | "ltr" | null {
  const text = line.replace(/<[^>]+>/g, "");
  for (const char of text) {
    if (char === RLM || HEBREW.test(char)) return "rtl";
    if (char === LRM || /\p{L}/u.test(char)) return "ltr";
  }
  return null;
}

function staticStrings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, v]) => staticStrings(v, path ? `${path}.${key}` : key));
  }
  return [];
}

const he = strings("he");
const en = strings("en");

/** Hebrew copy filled with Latin names, as it is with real companies, job titles and domains. */
const hebrewWithLatinContent = (t: Strings) => [
  t.siteAdded("example.co.il"),
  t.siteExists("example.co.il"),
  t.languageStatus("English", false),
  t.match.currentEmployer("Acme"),
  t.match.formerEmployer("Acme"),
  t.match.connections(3, "Acme"),
  t.match.contactsHeading("Acme"),
  t.match.contactsStale("2026-05"),
  t.digest.heading(2),
  t.digest.more(4, t.menu.whatsNew),
  t.proposal.dislike("Recruiter roles"),
  t.proposal.add("People Ops", t.profile.preferenceSections.target_role),
  t.cv.title("Product Manager", "Acme"),
  t.connections.imported(12, 4, 1),
  t.connections.summary(12, 4, "2026-05-01"),
  t.onboarding.sourceReceived(t.sources.cv, "cv.pdf"),
  t.onboarding.question(1, 2, "אילו תפקידים מעניינים אותך?"),
  t.profile.seniority(t.seniority.senior),
  t.profile.linkedin("linkedin.com/in/dana"),
  t.learning.roleRationale(3, "recruiter"),
  t.matching.mustHaveConflict("Remote only"),
  t.documents.saved(t.sources.cv, "cv-en.pdf", t.documentLanguages.en, 2),
  t.jobSources.boards(3, "Greenhouse 2, Lever 1", t.timeAgo.hours(3)),
  t.jobSources.sites("example.co.il, jobs.example.com"),
  t.jobSources.unreachableBoards("Greenhouse", 2, "acme, globex"),
  t.jobSources.turnedOff("Lever"),
  t.provenance.firstSeen(t.provenance.board("Greenhouse"), "2026-10-01"),
  t.provenance.alsoPostedOn("linkedin.com"),
  t.jobLinks.readingOneOf("acme.com"),
  t.jobLinks.connectionsTip("Acme"),
];

describe("hebrew copy", () => {
  const copy = staticStrings(he).filter(([path]) => path !== "languageName");

  it("starts every paragraph right-to-left, so Telegram lays it out as Hebrew", () => {
    const ltr = [...copy.map(([, text]) => text), ...hebrewWithLatinContent(he)]
      .flatMap((text) => text.split("\n"))
      .filter((line) => paragraphDirection(line) === "ltr");
    expect(ltr).toEqual([]);
  });

  it("keeps commands left-to-right inside Hebrew sentences", () => {
    const unmarked = copy.filter(([, text]) => /(?:^|[^‎])\/(?:new|profile|sites|connections|language|start|addsite)\b/.test(text));
    expect(unmarked.map(([path]) => path)).toEqual([]);
  });

  it("translates every user-facing string", () => {
    const english = new Map(staticStrings(en));
    const untranslated = copy.filter(([path, text]) => text === english.get(path) && !/^[✅✖️🗑📄🔍👍👎]?\s*$/u.test(text));
    expect(untranslated.map(([path]) => path)).toEqual([]);
  });
});

let db: TestDb;
let close: () => Promise<void>;
let assistant: FakeProfileAssistant;
let bot: ReturnType<typeof createBot>;
let calls: ApiCall[];

beforeEach(async () => {
  ({ db, close } = await createTestDb());
  assistant = new FakeProfileAssistant();
  assistant.extraction = {
    changes: [
      { op: "update_profile", fields: { headline: "HR Manager", currentSeniority: "manager" } },
      { op: "add_fact", kind: "skill", statement: "Workday", experienceId: null, experienceRef: null, origin: "conversation" },
    ],
    followUpQuestions: ["Q1", "Q2"],
  };
  bot = createBot("test-token", createPgServices(db, assistant, new FakeCvTailorer()), { botInfo: BOT_INFO });
  calls = captureApiCalls(bot);
});

afterEach(async () => {
  await close();
});

const sentMessages = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload);
const sent = () => sentMessages().map((p) => p.text as string);
const replyKeyboardLabels = () =>
  sentMessages()
    .flatMap((p) => p.reply_markup?.keyboard?.flat() ?? [])
    .map((b: { text: string }) => b.text);
const inlineLabels = () =>
  sentMessages()
    .flatMap((p) => p.reply_markup?.inline_keyboard?.flat() ?? [])
    .map((b: { text: string }) => b.text);

const transcript: string[] = [];
async function send(update: Parameters<typeof bot.handleUpdate>[0]) {
  calls.length = 0;
  await bot.handleUpdate(update);
  transcript.push(...sent(), ...inlineLabels(), ...replyKeyboardLabels());
}

async function userId() {
  const [user] = await db.select().from(users).where(eq(users.telegramUserId, DANA.id));
  return user!.id;
}

async function seedMatch(owner: string, status: "ready" | "notified" = "ready") {
  const [source] = await db.insert(jobSources).values({ key: "src", name: "Source", kind: "api" }).returning();
  const [raw] = await db
    .insert(rawJobRecords)
    .values({ sourceId: source!.id, sourceUrl: "https://jobs.example/1", contentHash: "h", payload: {} })
    .returning();
  const [group] = await db.insert(duplicateGroups).values({ dedupKey: "k" }).returning();
  const [job] = await db
    .insert(jobs)
    .values({
      sourceId: source!.id,
      rawRecordId: raw!.id,
      sourceUrl: raw!.sourceUrl,
      title: "People Operations Manager",
      company: "Acme",
      location: "Tel Aviv",
      description: "Lead people operations.",
      collectedAt: new Date(),
      duplicateGroupId: group!.id,
      dedupMethod: "deterministic_key",
    })
    .returning();
  const [match] = await db
    .insert(matches)
    .values({
      userId: owner,
      jobId: job!.id,
      duplicateGroupId: group!.id,
      status,
      recommendation: "good_fit",
      confidence: "high",
      explanation: "explanation",
    })
    .returning();
  await db.insert(matchEvaluations).values({
    matchId: match!.id,
    stage: "deep_match",
    outcome: "passed",
    profileRevision: 1,
    evidence: { fitEvidence: [{ claim: "claim", careerFactIds: [] }], gaps: ["gap"], risks: [], transferableSkills: ["skill"] },
  });
  return match!.id;
}

const FLOWS: { language: ConversationLanguage; skip: string; done: string }[] = [
  { language: "en", skip: "skip", done: "done" },
  { language: "he", skip: "דלג", done: "סיימתי" },
];

describe.each(FLOWS)("core flow in $language", ({ language, skip, done }) => {
  const t = strings(language);
  const other = strings(language === "en" ? "he" : "en");

  it("onboards, shows matches and takes feedback entirely in the chosen language", async () => {
    transcript.length = 0;
    await send(textUpdate("/start"));
    expect(sent()).toEqual([ASK_LANGUAGE]);
    transcript.length = 0;

    await send(callbackUpdate(encodeCallback({ type: "set_language", language })));
    expect(sent()).toEqual([t.messages.languageSaved, t.messages.welcomeNew, t.messages.askLinkedin]);
    const commands = calls.find((c) => c.method === "setMyCommands")!.payload;
    expect(commands.scope).toEqual({ type: "chat", chat_id: DANA.id });
    expect(commands.commands[0]).toEqual({ command: "new", description: t.commands.new });

    await send(textUpdate(skip));
    expect(sent()).toEqual([`${t.messages.linkedinSkipped}\n\n${t.messages.askDocuments}`]);
    await send(textUpdate("HR manager at Acme since 2019, led a team of 6"));
    expect(sent()[0]).toBe(t.onboarding.sourceReceived(t.sources.pasted_text, null));
    expect(inlineLabels()).toEqual([t.buttons.analyze]);

    await send(textUpdate(done));
    expect(sent()).toEqual([t.onboarding.question(1, 2, "Q1")]);
    expect(assistant.extractCalls.map((c) => c.language)).toEqual([language]);
    await send(textUpdate(skip));
    await send(textUpdate(skip));
    expect(sent()[0]).toContain(t.messages.reviewIntro);
    expect(sent()[0]).toContain(t.profile.seniority(t.seniority.manager));
    expect(sent()[0]).toContain(`<b>${t.profile.factSections.skill}</b>`);
    expect(inlineLabels()).toEqual([t.buttons.confirmProfile]);

    await send(callbackUpdate(encodeCallback({ type: "onboarding_confirm" })));
    expect(sent()).toEqual([t.messages.onboardingDone]);
    expect(replyKeyboardLabels()).toEqual([t.menu.whatsNew, t.menu.myProfile]);

    const matchId = await seedMatch(await userId());
    await send(textUpdate(t.menu.whatsNew));
    expect(sent()[0]).toContain(`<i>${t.recommendations.good_fit}</i>`);
    expect(inlineLabels()).toEqual([t.buttons.details]);

    await send(callbackUpdate(encodeCallback({ type: "job_details", matchId })));
    expect(sent()[0]).toContain(`<b>${t.match.whyItFits}</b>`);
    expect(sent()[0]).toContain(t.match.openPosting);
    expect(inlineLabels()).toEqual([t.buttons.interested, t.buttons.notInterested, t.buttons.tailorCv, t.buttons.originalPosting]);

    await send(callbackUpdate(encodeCallback({ type: "feedback", matchId, verdict: "not_interested" })));
    expect(calls.find((c) => c.method === "answerCallbackQuery")!.payload.text).toBe(t.messages.feedbackNotInterested);
    expect(sent()).toEqual([t.messages.feedbackReasonPrompt]);
    expect(inlineLabels()).toContain(t.feedbackReasons.location);

    await send(textUpdate(t.menu.myProfile));
    expect(sent().at(-1)).toContain(t.messages.profileOutro);
    await send(textUpdate("/help"));
    expect(sent()).toEqual([t.messages.help]);

    const leaked = staticStrings(other)
      .filter(([path, text]) => path !== "languageName" && /\S\s+\S/.test(text) && !/^\p{Extended_Pictographic}/u.test(text))
      .map(([, text]) => text)
      .filter((text) => transcript.some((line) => line.includes(text)));
    expect(leaked).toEqual([]);
    if (language === "en") expect(transcript.filter((line) => HEBREW.test(line))).toEqual([]);
  });
});

describe("switching language", () => {
  async function onboardInEnglish() {
    await send(textUpdate("/start"));
    await send(callbackUpdate(encodeCallback({ type: "set_language", language: "en" })));
    await send(textUpdate("skip"));
    await send(textUpdate("I'm an HR manager"));
    await send(textUpdate("done"));
    await send(textUpdate("skip"));
    await send(textUpdate("skip"));
    await send(callbackUpdate(encodeCallback({ type: "onboarding_confirm" })));
  }

  it("changes the very next replies, the menu and the command list", async () => {
    await onboardInEnglish();

    await send(textUpdate("תדבר איתי בעברית"));
    expect(sent()).toEqual([he.messages.languageSaved]);
    expect(replyKeyboardLabels()).toEqual([he.menu.whatsNew, he.menu.myProfile]);
    const commands = calls.find((c) => c.method === "setMyCommands")!.payload;
    expect(commands.commands.map((c: { description: string }) => c.description)).toContain(he.commands.language);

    await send(textUpdate("/new"));
    expect(sent()).toEqual([he.messages.noMatches]);
    await send(textUpdate(en.menu.whatsNew));
    expect(sent()).toEqual([he.messages.noMatches]);

    await send(callbackUpdate(encodeCallback({ type: "set_language", language: "en" })));
    expect(sent()).toEqual([en.messages.languageSaved]);
    await send(textUpdate("/new"));
    expect(sent()).toEqual([en.messages.noMatches]);
  });

  it("answers profile edits in the new language", async () => {
    await onboardInEnglish();
    await send(textUpdate("Switch to Hebrew"));
    await send(textUpdate("מה שלומך?"));
    expect(assistant.interpretCalls.at(-1)!.language).toBe("he");
    expect(sent()).toEqual([he.messages.noChange]);
  });

  it("understands Hebrew requests for connections and job sites", async () => {
    await onboardInEnglish();
    await send(textUpdate("Switch to Hebrew"));

    await send(textUpdate("תמחק את אנשי הקשר שלי"));
    expect(sent()).toEqual([he.messages.connectionsNone]);
    await send(textUpdate("תחפש גם ב-example.co.il"));
    expect(sent()).toEqual([he.siteAdded("example.co.il")]);
  });
});

describe("digest notifications", () => {
  it("are sent in each user's language", async () => {
    const [user] = await db
      .insert(users)
      .values({ telegramUserId: 5, telegramChatId: 5, preferredLanguage: "he" })
      .returning();
    await db.insert(careerProfiles).values({ userId: user!.id, status: "confirmed" });
    await seedMatch(user!.id);

    const languages: (ConversationLanguage | null)[] = [];
    await runNotifications(db, { sendDigest: async (_chat, _matches, _remaining, language) => void languages.push(language) });
    expect(languages).toEqual(["he"]);

    const api = new Api("test-token");
    const payloads: Record<string, any>[] = [];
    api.config.use(async (_prev, _method, payload) => {
      payloads.push(payload as Record<string, any>);
      return { ok: true, result: { message_id: 1 } } as any;
    });
    const digest: MatchSummary[] = [
      { matchId: "11111111-1111-1111-1111-111111111111", title: "People Lead", company: "Acme", location: null, recommendation: "strong_fit", explanation: "x", employerRelation: null, connectionCount: 2 },
    ];
    await new TelegramNotifier(api).sendDigest(5, digest, 3, "he");
    expect(payloads[0]!.text).toContain(he.digest.heading(1));
    expect(payloads[0]!.text).toContain(he.recommendations.strong_fit);
    expect(payloads[0]!.text).toContain(he.match.connections(2, "Acme"));
    expect(payloads[0]!.text).toContain(he.digest.more(3, he.menu.whatsNew));

    await new TelegramNotifier(api).sendDigest(5, digest, 0, null);
    expect(payloads[1]!.text).toContain(en.digest.heading(1));
  });
});
