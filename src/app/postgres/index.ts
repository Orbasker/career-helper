import type { Db } from "../../db/types.js";
import type { AppServices } from "../services.js";
import { PgConversationService } from "./conversation.js";
import { PgCvService } from "./cv.js";
import { PgFeedbackService } from "./feedback.js";
import { PgMatchService } from "./matches.js";
import { PgOnboardingService } from "./onboarding.js";
import { PgUserService } from "./users.js";

export function createPgServices(db: Db): AppServices {
  const onboarding = new PgOnboardingService(db);
  return {
    users: new PgUserService(db),
    onboarding,
    matches: new PgMatchService(db),
    feedback: new PgFeedbackService(db),
    cv: new PgCvService(db),
    conversation: new PgConversationService(db, onboarding),
  };
}
