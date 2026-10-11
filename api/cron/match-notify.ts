import { parseEnv } from "@neon/env";
import { attachDatabasePool } from "@vercel/functions";
import { Api } from "grammy";
import config from "../../neon.js";
import { AiDeepMatcher } from "../../src/ai/deep-matcher.js";
import { TelegramNotifier } from "../../src/bot/notifier.js";
import { telegramBotToken } from "../../src/bot/telegram-env.js";
import { createCronHandler } from "../../src/cron.js";
import { createDb } from "../../src/db/client.js";
import { PgModelCallRecorder } from "../../src/observability/recorder.js";
import { runMatchAndNotify } from "../../src/pipeline/frequent.js";
import { parseNotificationThreshold } from "../../src/pipeline/notify.js";

const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
attachDatabasePool(pool);

const deps = {
  matcher: new AiDeepMatcher(undefined, undefined, new PgModelCallRecorder(db)),
  notifier: new TelegramNotifier(new Api(telegramBotToken())),
};
const threshold = parseNotificationThreshold();

export const GET = createCronHandler(process.env.CRON_SECRET, () => runMatchAndNotify(db, deps, { threshold, deepMatchLimit: 20 }));
