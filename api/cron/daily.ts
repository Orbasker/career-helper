import { parseEnv } from "@neon/env";
import { attachDatabasePool } from "@vercel/functions";
import { Api } from "grammy";
import config from "../../neon.js";
import { AiDeepMatcher } from "../../src/ai/deep-matcher.js";
import { AiJobDiscoverer } from "../../src/ai/job-discoverer.js";
import { TelegramNotifier } from "../../src/bot/notifier.js";
import { telegramBotToken } from "../../src/bot/telegram-env.js";
import { createCronHandler } from "../../src/cron.js";
import { createDb } from "../../src/db/client.js";
import { discoverySettingsFromEnv } from "../../src/discovery/run.js";
import { PgModelCallRecorder } from "../../src/observability/recorder.js";
import { SOURCE_ADAPTERS } from "../../src/ingestion/sources/index.js";
import { runDailyPipeline } from "../../src/pipeline/daily.js";
import { parseNotificationThreshold } from "../../src/pipeline/notify.js";

const { postgres } = parseEnv(config, ["DATABASE_URL"]);
const { db, pool } = createDb(postgres.databaseUrl);
attachDatabasePool(pool);

const { enabled, ...discovery } = discoverySettingsFromEnv();
const recorder = new PgModelCallRecorder(db);
const deps = {
  adapters: SOURCE_ADAPTERS,
  discoverer: enabled ? new AiJobDiscoverer(undefined, recorder) : undefined,
  matcher: new AiDeepMatcher(undefined, undefined, recorder),
  notifier: new TelegramNotifier(new Api(telegramBotToken())),
};
const threshold = parseNotificationThreshold();

export const GET = createCronHandler(process.env.CRON_SECRET, () => runDailyPipeline(db, deps, { threshold, discovery }));
