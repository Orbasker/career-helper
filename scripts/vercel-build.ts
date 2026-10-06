import { parseEnv } from "@neon/env";
import { Api } from "grammy";
import config from "../neon.js";
import { BOT_COMMANDS } from "../src/bot/bot.js";
import { ALLOWED_UPDATES, WEBHOOK_PATH, telegramBotToken, webhookSecret } from "../src/bot/telegram-env.js";
import { runMigrations } from "../src/db/migrations.js";

if (process.env.VERCEL_ENV !== "production") {
  console.log(`Skipping migrations and webhook registration for VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}`);
  process.exit(0);
}

const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
if (!host) throw new Error("VERCEL_PROJECT_PRODUCTION_URL is required");

const { postgres } = parseEnv(config, ["DATABASE_URL_UNPOOLED"]);
await runMigrations(postgres.databaseUrlUnpooled);
console.log("Database migrations applied");

const token = telegramBotToken();
const api = new Api(token);
const url = `https://${host}${WEBHOOK_PATH}`;
await api.setWebhook(url, { secret_token: webhookSecret(token), allowed_updates: [...ALLOWED_UPDATES] });
await api.setMyCommands(BOT_COMMANDS);
console.log(`Telegram webhook set to ${url}`);
