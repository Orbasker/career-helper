import JSZip from "jszip";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgConnectionService } from "../src/app/postgres/connections.js";
import { createPgServices } from "../src/app/postgres/index.js";
import { PgMatchService } from "../src/app/postgres/matches.js";
import type { MatchSummary } from "../src/app/services.js";
import { createBot } from "../src/bot/bot.js";
import { digestView, matchDetailsView, matchListItem, messages } from "../src/bot/views.js";
import { contactsAtCompanies, rankContacts, type Contact } from "../src/connections/lookup.js";
import { parseConnectedOn, parseConnectionsCsv, readConnectionsFile } from "../src/connections/parse.js";
import { careerProfiles, connections, duplicateGroups, jobSources, jobs, matches, rawJobRecords, users } from "../src/db/schema.js";
import { runNotifications } from "../src/pipeline/notify.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { createTestDb, type TestDb } from "./support/db.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { BOT_INFO, DANA, callbackUpdate, captureApiCalls, documentUpdate, textUpdate, type ApiCall } from "./support/telegram.js";

const CSV = [
  "Notes:",
  '"When exporting your connection data, you may notice that some of the email addresses are missing."',
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Noa,Cohen,https://www.linkedin.com/in/noacohen,,Via Transportation Inc.,Engineering Manager,06 Oct 2026",
  'Avi,Levi,https://www.linkedin.com/in/avilevi,avi@example.com,"Via","Senior Backend Engineer, Routing",12 Mar 2024',
  "Dana,,https://www.linkedin.com/in/dana,,Viasat,Recruiter,01 Jan 2020",
  ",,https://www.linkedin.com/in/nobody,,Wiz,,",
  "Maya,Bar,not-a-url,,,,",
  "",
].join("\r\n");

const encode = (text: string) => new TextEncoder().encode(text);

describe("parsing LinkedIn connections", () => {
  it("skips the notes, reads quoted fields and reports rows without a name", () => {
    expect(parseConnectionsCsv(CSV)).toEqual({
      connections: [
        { fullName: "Noa Cohen", profileUrl: "https://www.linkedin.com/in/noacohen", company: "Via Transportation Inc.", position: "Engineering Manager", connectedOn: "2026-10-06" },
        { fullName: "Avi Levi", profileUrl: "https://www.linkedin.com/in/avilevi", company: "Via", position: "Senior Backend Engineer, Routing", connectedOn: "2024-03-12" },
        { fullName: "Dana", profileUrl: "https://www.linkedin.com/in/dana", company: "Viasat", position: "Recruiter", connectedOn: "2020-01-01" },
        { fullName: "Maya Bar", profileUrl: null, company: null, position: null, connectedOn: null },
      ],
      skipped: 1,
    });
    expect(parseConnectionsCsv("Name,Phone\nA,1")).toBeNull();
  });

  it("reads dates in LinkedIn's and ISO format", () => {
    expect(parseConnectedOn("6 Oct 2026")).toBe("2026-10-06");
    expect(parseConnectedOn("2025-02-03")).toBe("2025-02-03");
    expect(parseConnectedOn("yesterday")).toBeNull();
  });

  it("finds Connections.csv inside the export ZIP and rejects other files", async () => {
    const zip = new JSZip();
    zip.file("Basic_LinkedInDataExport/Connections.csv", CSV);
    zip.file("Basic_LinkedInDataExport/Profile.csv", "First Name\nx");
    const data = await zip.generateAsync({ type: "uint8array" });
    expect((await readConnectionsFile(data, "Basic_LinkedInDataExport.zip"))?.connections).toHaveLength(4);

    const other = new JSZip();
    other.file("Profile.csv", "a,b");
    expect(await readConnectionsFile(await other.generateAsync({ type: "uint8array" }), "export.zip")).toBeNull();
    expect(await readConnectionsFile(encode(CSV), "notes.txt")).toBeNull();
  });
});

describe("ranking contacts", () => {
  it("puts people in the job's function first, then the most senior", () => {
    const contact = (fullName: string, position: string | null): Contact => ({ fullName, position, profileUrl: null, company: "Via" });
    const ranked = rankContacts(
      [contact("Zed", "Account Executive"), contact("Ann", "Senior Backend Engineer"), contact("Bob", "VP Engineering"), contact("Cat", "Head of Sales")],
      "Backend Engineer",
    );
    expect(ranked.map((c) => c.fullName)).toEqual(["Ann", "Bob", "Cat", "Zed"]);
  });
});

describe("connections in matches", () => {
  let db: TestDb;
  let close: () => Promise<void>;
  let service: PgConnectionService;
  let userId: string;

  beforeEach(async () => {
    ({ db, close } = await createTestDb());
    service = new PgConnectionService(db, () => new Date("2026-10-06T10:00:00Z"));
    const [user] = await db.insert(users).values({ telegramUserId: DANA.id, telegramChatId: DANA.id }).returning();
    userId = user!.id;
    await db.insert(careerProfiles).values({ userId, status: "confirmed" });
  });

  afterEach(async () => {
    await close();
  });

  async function seedMatch(title: string, company: string) {
    const [source] = await db
      .insert(jobSources)
      .values({ key: `src-${title}`, name: "Source", kind: "api" })
      .onConflictDoNothing()
      .returning();
    const [raw] = await db.insert(rawJobRecords).values({ sourceId: source!.id, sourceUrl: `https://x.example/${title}`, contentHash: title, payload: {} }).returning();
    const [group] = await db.insert(duplicateGroups).values({ dedupKey: title }).returning();
    const [job] = await db
      .insert(jobs)
      .values({ sourceId: source!.id, rawRecordId: raw!.id, sourceUrl: raw!.sourceUrl, title, company, description: "d", collectedAt: new Date(), duplicateGroupId: group!.id, dedupMethod: "deterministic_key" })
      .returning();
    const [match] = await db
      .insert(matches)
      .values({ userId, jobId: job!.id, duplicateGroupId: group!.id, status: "ready", recommendation: "good_fit", confidence: "medium", explanation: "Fits." })
      .returning();
    return match!.id;
  }

  it("imports, replaces, summarizes and deletes a user's contacts", async () => {
    expect(await service.import(userId, { data: encode(CSV), fileName: "Connections.csv" })).toEqual({ kind: "imported", contacts: 4, companies: 3, skipped: 1 });
    expect(await service.summary(userId)).toEqual({ contacts: 4, companies: 3, importedAt: new Date("2026-10-06T10:00:00Z") });

    const smaller = CSV.split("\r\n").slice(0, 5).join("\n");
    expect(await service.import(userId, { data: encode(smaller), fileName: "Connections.csv" })).toMatchObject({ contacts: 1 });
    expect(await db.select().from(connections)).toHaveLength(1);

    expect(await service.import(userId, { data: encode("hello"), fileName: "Connections.csv" })).toEqual({ kind: "not_connections" });
    expect(await service.import(userId, { data: encode("First Name,Last Name\n"), fileName: "Connections.csv" })).toEqual({ kind: "empty" });
    expect(await service.forget(userId)).toBe(1);
    expect(await service.summary(userId)).toBeNull();
  });

  it("matches companies on whole words and keeps contacts private to their owner", async () => {
    await service.import(userId, { data: encode(CSV), fileName: "Connections.csv" });
    const [other] = await db.insert(users).values({ telegramUserId: 7, telegramChatId: 7 }).returning();
    await service.import(other!.id, { data: encode(CSV), fileName: "Connections.csv" });

    const found = await contactsAtCompanies(db, userId, ["Via", "Wiz", null]);
    expect(found.get("via")?.map((c) => c.fullName).sort()).toEqual(["Avi Levi", "Noa Cohen"]);
    expect(found.has("wiz")).toBe(false);
    expect((await contactsAtCompanies(db, other!.id, ["Via"])).get("via")).toHaveLength(2);
  });

  it("shows the count in the list and digest and the best contacts in the details", async () => {
    await service.import(userId, { data: encode(CSV), fileName: "Connections.csv" });
    const viaMatch = await seedMatch("Backend Engineer", "Via");
    await seedMatch("Platform Engineer", "Wiz");
    const matchService = new PgMatchService(db);

    const list = await matchService.whatsNew(userId, 5);
    expect(list.map((m) => [m.company, m.connectionCount])).toEqual(expect.arrayContaining([["Via", 2], ["Wiz", 0]]));
    expect(matchListItem(list.find((m) => m.company === "Via")!).text).toContain("👥 2 connections at Via");
    expect(matchListItem(list.find((m) => m.company === "Wiz")!).text).not.toContain("👥");

    const details = (await matchService.details(userId, viaMatch))!;
    expect(details.contacts.map((c) => c.fullName)).toEqual(["Avi Levi", "Noa Cohen"]);
    const text = matchDetailsView(details).text;
    expect(text).toContain("<b>People you know at Via</b>");
    expect(text).toContain('<a href="https://www.linkedin.com/in/avilevi">Avi Levi</a> — Senior Backend Engineer, Routing');
    expect(text).not.toContain("From your LinkedIn export");
    await db.update(connections).set({ importedAt: new Date("2026-05-01T00:00:00Z") });
    expect(matchDetailsView((await matchService.details(userId, viaMatch))!).text).toContain(
      "From your LinkedIn export of 2026-05. Send /connections to refresh it.",
    );

    const sent: MatchSummary[][] = [];
    await db.update(matches).set({ status: "ready", notifiedAt: null });
    await runNotifications(db, { sendDigest: async (_chat, digest) => void sent.push(digest) });
    expect(digestView(sent[0]!, 0).text).toContain("👥 2 connections at Via");
  });

  describe("in the bot", () => {
    let bot: ReturnType<typeof createBot>;
    let calls: ApiCall[];
    let upload: Uint8Array;

    beforeEach(() => {
      upload = encode(CSV);
      bot = createBot("test-token", createPgServices(db, new FakeProfileAssistant(), new FakeCvTailorer()), { botInfo: BOT_INFO }, {
        downloadFile: async () => upload,
      });
      calls = captureApiCalls(bot);
    });

    const send = async (update: ReturnType<typeof textUpdate>) => {
      calls.length = 0;
      await bot.handleUpdate(update);
    };
    const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload);

    it("explains how to export, imports the file, and deletes on request", async () => {
      await send(textUpdate("/connections"));
      expect(sent()[0]!.text).toContain("Get a copy of your data");

      await send(documentUpdate({ fileName: "Connections.csv", mimeType: "text/csv" }));
      expect(sent()[0]!.text).toContain("Imported 4 contacts at 3 companies ✅ (1 rows without a name were skipped)");

      await send(textUpdate("/connections"));
      const summary = sent()[0]!;
      expect(summary.text).toContain("4 contacts at 3 companies, imported");
      await send(callbackUpdate(summary.reply_markup.inline_keyboard[0][0].callback_data));
      expect(sent()[0]!.text).toBe(messages.connectionsDeleted);

      await send(documentUpdate({ fileName: "Connections.csv", mimeType: "text/csv" }));
      await send(textUpdate("Please delete my LinkedIn connections"));
      expect(sent()[0]!.text).toBe(messages.connectionsDeleted);
      expect(await db.select().from(connections).where(eq(connections.userId, userId))).toHaveLength(0);
    });

    it("tells the user when a CSV is not a connections export", async () => {
      upload = encode("Date,Amount\n2026-01-01,5");
      await send(documentUpdate({ fileName: "bank.csv", mimeType: "text/csv" }));
      expect(sent()[0]!.text).toBe(messages.connectionsNotRecognized);
    });
  });
});
