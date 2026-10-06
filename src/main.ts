import { parseEnv } from "@neon/env";
import config from "../neon.js";
import { createPgServices } from "./app/postgres/index.js";
import { BOT_COMMANDS, createBot } from "./bot/bot.js";
import { createDb } from "./db/client.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
const bot = createBot(token, createPgServices(db));

const shutdown = async () => {
  await bot.stop();
  await pool.end();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await bot.api.setMyCommands(BOT_COMMANDS);
await bot.start({ onStart: (me) => console.log(`bot @${me.username} polling`) });
