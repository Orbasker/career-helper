import { AiDeepMatcher } from "../../ai/deep-matcher.js";
import { AiJobDiscoverer } from "../../ai/job-discoverer.js";
import type { CvTailorer } from "../../cv/tailoring.js";
import { SOURCE_ADAPTERS } from "../../ingestion/sources/index.js";
import { buildStats, formatStats, type SpendLookup } from "../../observability/report.js";
import type { Db } from "../../db/types.js";
import type { AppServices, ProfileAssistant } from "../services.js";
import { PgConnectionService } from "./connections.js";
import { PgConversationService } from "./conversation.js";
import { PgCvService } from "./cv.js";
import { PgFeedbackService } from "./feedback.js";
import { PgJobLinkService, type JobLinkDeps } from "./job-links.js";
import { PgMatchService } from "./matches.js";
import { PgOnboardingService } from "./onboarding.js";
import { PgSiteService } from "./sites.js";
import { PgSourceService } from "./sources.js";
import { PgUserService } from "./users.js";

export function createPgServices(
  db: Db,
  assistant: ProfileAssistant,
  tailorer: CvTailorer,
  options: { spend?: SpendLookup; jobLinks?: JobLinkDeps } = {},
): AppServices {
  const onboarding = new PgOnboardingService(db, assistant);
  const sites = new PgSiteService(db, SOURCE_ADAPTERS);
  return {
    users: new PgUserService(db),
    onboarding,
    matches: new PgMatchService(db),
    feedback: new PgFeedbackService(db),
    cv: new PgCvService(db, tailorer),
    conversation: new PgConversationService(db, onboarding, assistant),
    sites,
    sources: new PgSourceService(db, sites),
    connections: new PgConnectionService(db),
    jobLinks: new PgJobLinkService(db, options.jobLinks ?? { reader: new AiJobDiscoverer(), matcher: new AiDeepMatcher() }),
    stats: { report: async (days) => formatStats(await buildStats(db, { days, spend: options.spend }), { html: true }) },
  };
}
