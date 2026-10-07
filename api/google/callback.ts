import { parseEnv } from "@neon/env";
import { attachDatabasePool } from "@vercel/functions";
import { Api } from "grammy";
import config from "../../neon.js";
import { PgGmailService } from "../../src/app/postgres/gmail.js";
import { telegramBotToken } from "../../src/bot/telegram-env.js";
import { createDb } from "../../src/db/client.js";
import { gmailDepsFromEnv } from "../../src/google/env.js";
import { createGoogleCallbackHandler } from "../../src/google/routes.js";

const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
attachDatabasePool(pool);

const api = new Api(telegramBotToken());

export const GET = createGoogleCallbackHandler(new PgGmailService(db, gmailDepsFromEnv()), (chatId, html) =>
  api.sendMessage(chatId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }),
);
