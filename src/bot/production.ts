import { AiCvTailorer } from "../ai/cv-tailorer.js";
import { AiDeepMatcher } from "../ai/deep-matcher.js";
import { AiJobDiscoverer } from "../ai/job-discoverer.js";
import { AiProfileAssistant } from "../ai/profile-assistant.js";
import { createPgServices } from "../app/postgres/index.js";
import type { Db } from "../db/types.js";
import { discoverySettingsFromEnv } from "../discovery/run.js";
import { SEARCH_SOURCES, SOURCE_ADAPTERS } from "../ingestion/sources/index.js";
import { parseNotificationThreshold } from "../pipeline/notify.js";
import { PgModelCallRecorder } from "../observability/recorder.js";
import { gatewaySpend } from "../observability/report.js";
import { createBot } from "./bot.js";
import { adminTelegramIds } from "./telegram-env.js";

/** The bot with real AI services, model-call recording and operator commands. */
export function createProductionBot(token: string, db: Db) {
  const recorder = new PgModelCallRecorder(db);
  const discoverer = new AiJobDiscoverer(undefined, recorder);
  const matcher = new AiDeepMatcher(undefined, undefined, recorder);
  const { enabled } = discoverySettingsFromEnv();
  const services = createPgServices(
    db,
    new AiProfileAssistant(undefined, recorder),
    new AiCvTailorer(undefined, recorder),
    {
      spend: gatewaySpend,
      jobLinks: { reader: discoverer, matcher },
      search: {
        deps: { boardAdapters: SOURCE_ADAPTERS, searchSources: SEARCH_SOURCES, discoverer: enabled ? discoverer : undefined, matcher },
        options: { threshold: parseNotificationThreshold() },
      },
    },
  );
  return createBot(token, services, undefined, undefined, { adminTelegramIds: adminTelegramIds() });
}
