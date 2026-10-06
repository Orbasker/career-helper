import { parseEnv } from "@neon/env";
import { attachDatabasePool } from "@vercel/functions";
import { webhookCallback } from "grammy";
import config from "../neon.js";
import { createPgServices } from "../src/app/postgres/index.js";
import { createBot } from "../src/bot/bot.js";
import { telegramBotToken, webhookSecret } from "../src/bot/telegram-env.js";
import { createDb } from "../src/db/client.js";

const token = telegramBotToken();
const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
attachDatabasePool(pool);

const handleUpdate = webhookCallback(createBot(token, createPgServices(db)), "std/http", {
  secretToken: webhookSecret(token),
});

export function POST(request: Request): Promise<Response> {
  return handleUpdate(request);
}
