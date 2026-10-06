import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPgServices } from "../src/app/postgres/index.js";
import { createBot } from "../src/bot/bot.js";
import { webhookSecret } from "../src/bot/telegram-env.js";
import { createWebhookHandler } from "../src/bot/webhook.js";
import { messages } from "../src/bot/views.js";
import { FakeProfileAssistant } from "./support/assistant.js";
import { FakeCvTailorer } from "./support/tailorer.js";
import { createTestDb } from "./support/db.js";
import { BOT_INFO, captureApiCalls, textUpdate, type ApiCall } from "./support/telegram.js";

const TOKEN = "123:test";
let close: () => Promise<void>;
let calls: ApiCall[];
let handle: (request: Request) => Promise<Response>;
let background: Promise<unknown>[];

beforeEach(async () => {
  const testDb = await createTestDb();
  close = testDb.close;
  const bot = createBot(TOKEN, createPgServices(testDb.db, new FakeProfileAssistant(), new FakeCvTailorer()), { botInfo: BOT_INFO });
  calls = captureApiCalls(bot);
  background = [];
  handle = createWebhookHandler(bot, webhookSecret(TOKEN), (task) => background.push(task));
});

afterEach(async () => {
  await close();
});

const post = (secret: string) =>
  new Request("https://example.test/api/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(textUpdate("/help")),
  });

describe("telegram webhook", () => {
  it("rejects requests without the derived secret", async () => {
    const response = await handle(post("wrong"));
    expect(response.status).toBe(401);
    expect(background).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("acknowledges signed updates immediately and handles them in the background", async () => {
    const response = await handle(post(webhookSecret(TOKEN)));
    expect(response.status).toBe(200);
    expect(background).toHaveLength(1);
    await Promise.all(background);
    expect(calls.map((c) => c.payload.text)).toEqual([messages.help]);
  });

  it("derives a secret Telegram accepts", () => {
    expect(webhookSecret(TOKEN)).toMatch(/^[A-Za-z0-9_-]{1,256}$/);
  });
});
