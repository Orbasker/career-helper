import { parseEnv } from "@neon/env";
import { attachDatabasePool, waitUntil } from "@vercel/functions";
import config from "../neon.js";
import { createProductionBot } from "../src/bot/production.js";
import { telegramBotToken, webhookSecret } from "../src/bot/telegram-env.js";
import { createWebhookHandler } from "../src/bot/webhook.js";
import { createDb } from "../src/db/client.js";

const token = telegramBotToken();
const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
attachDatabasePool(pool);

const bot = createProductionBot(token, db);
const handleUpdate = createWebhookHandler(bot, webhookSecret(token), waitUntil);

export function POST(request: Request): Promise<Response> {
  return handleUpdate(request);
}
