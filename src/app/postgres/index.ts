import type { CvTailorer } from "../../cv/tailoring.js";
import { SOURCE_ADAPTERS } from "../../ingestion/sources/index.js";
import type { Db } from "../../db/types.js";
import type { AppServices, ProfileAssistant } from "../services.js";
import { PgConversationService } from "./conversation.js";
import { PgCvService } from "./cv.js";
import { PgFeedbackService } from "./feedback.js";
import { PgMatchService } from "./matches.js";
import { PgOnboardingService } from "./onboarding.js";
import { PgSiteService } from "./sites.js";
import { PgUserService } from "./users.js";

export function createPgServices(db: Db, assistant: ProfileAssistant, tailorer: CvTailorer): AppServices {
  const onboarding = new PgOnboardingService(db, assistant);
  return {
    users: new PgUserService(db),
    onboarding,
    matches: new PgMatchService(db),
    feedback: new PgFeedbackService(db),
    cv: new PgCvService(db, tailorer),
    conversation: new PgConversationService(db, onboarding, assistant),
    sites: new PgSiteService(db, SOURCE_ADAPTERS),
  };
}
