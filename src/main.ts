import { parseEnv } from "@neon/env";
import config from "../neon.js";
import { AiProfileAssistant } from "./ai/profile-assistant.js";
import { createPgServices } from "./app/postgres/index.js";
import { BOT_COMMANDS, createBot } from "./bot/bot.js";
import { ALLOWED_UPDATES, telegramBotToken } from "./bot/telegram-env.js";
import { createDb } from "./db/client.js";

const token = telegramBotToken();
const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
const bot = createBot(token, createPgServices(db, new AiProfileAssistant()));

const webhook = await bot.api.getWebhookInfo();
if (webhook.url) {
  await pool.end();
  throw new Error(
    `This bot token has a webhook (${webhook.url}); polling would delete it. Use a separate dev bot token locally.`,
  );
}

const shutdown = async () => {
  await bot.stop();
  await pool.end();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await bot.api.setMyCommands(BOT_COMMANDS);
await bot.start({
  allowed_updates: [...ALLOWED_UPDATES],
  onStart: (me) => console.log(`bot @${me.username} polling`),
});
