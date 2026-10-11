import { parseEnv } from "@neon/env";
import { attachDatabasePool } from "@vercel/functions";
import config from "../neon.js";
import { PgApplicationService } from "../src/app/postgres/applications.js";
import { PgExploreService } from "../src/app/postgres/explore.js";
import { PgFeedbackService } from "../src/app/postgres/feedback.js";
import { PgMatchService } from "../src/app/postgres/matches.js";
import { telegramBotToken } from "../src/bot/telegram-env.js";
import { createDb } from "../src/db/client.js";
import { createMiniAppHandler } from "../src/miniapp/handler.js";

const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
attachDatabasePool(pool);

const handle = createMiniAppHandler({
  db,
  botToken: telegramBotToken(),
  explore: new PgExploreService(db),
  matches: new PgMatchService(db),
  feedback: new PgFeedbackService(db),
  applications: new PgApplicationService(db),
});

export const GET = handle;
export const POST = handle;
