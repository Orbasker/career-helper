import { parseEnv } from "@neon/env";
import { attachDatabasePool, waitUntil } from "@vercel/functions";
import config from "../neon.js";
import { AiProfileAssistant } from "../src/ai/profile-assistant.js";
import { createPgServices } from "../src/app/postgres/index.js";
import { createBot } from "../src/bot/bot.js";
import { telegramBotToken, webhookSecret } from "../src/bot/telegram-env.js";
import { createWebhookHandler } from "../src/bot/webhook.js";
import { createDb } from "../src/db/client.js";

const token = telegramBotToken();
const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
attachDatabasePool(pool);

const bot = createBot(token, createPgServices(db, new AiProfileAssistant()));
const handleUpdate = createWebhookHandler(bot, webhookSecret(token), waitUntil);

export function POST(request: Request): Promise<Response> {
  return handleUpdate(request);
}
