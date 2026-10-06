import { AiCvTailorer } from "../ai/cv-tailorer.js";
import { AiProfileAssistant } from "../ai/profile-assistant.js";
import { createPgServices } from "../app/postgres/index.js";
import type { Db } from "../db/types.js";
import { PgModelCallRecorder } from "../observability/recorder.js";
import { gatewaySpend } from "../observability/report.js";
import { createBot } from "./bot.js";
import { adminTelegramIds } from "./telegram-env.js";

/** The bot with real AI services, model-call recording and operator commands. */
export function createProductionBot(token: string, db: Db) {
  const recorder = new PgModelCallRecorder(db);
  const services = createPgServices(
    db,
    new AiProfileAssistant(undefined, recorder),
    new AiCvTailorer(undefined, recorder),
    { spend: gatewaySpend },
  );
  return createBot(token, services, undefined, undefined, { adminTelegramIds: adminTelegramIds() });
}
