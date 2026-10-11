import { eq } from "drizzle-orm";
import type { PgExploreService } from "../app/postgres/explore.js";
import type { ApplicationService, FeedbackService, MatchService } from "../app/services.js";
import { users } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { verifyInitData } from "./auth.js";
import { EXPLORE_ACTIONS, INIT_DATA_HEADER, type ExploreAction, type ExploreDetails } from "./types.js";

export interface MiniAppDeps {
  db: Db;
  botToken: string;
  explore: Pick<PgExploreService, "list">;
  matches: Pick<MatchService, "details">;
  feedback: Pick<FeedbackService, "record">;
  applications: Pick<ApplicationService, "applyToMatch">;
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The full job list runs to hundreds of kilobytes of repetitive JSON, so it is gzipped when the client accepts it. */
function compressed(request: Request, body: unknown): Response {
  if (!/\bgzip\b/.test(request.headers.get("accept-encoding") ?? "")) return json(body);
  const stream = new Blob([JSON.stringify(body)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream, {
    headers: { "content-type": "application/json", "content-encoding": "gzip", "cache-control": "no-store", vary: "accept-encoding" },
  });
}

/**
 * The Mini App's API: `GET` lists every job matched for the user, `GET ?match=<id>` returns one job's details and `POST`
 * applies an action to a match. Every request must carry Telegram's signed launch data.
 */
export function createMiniAppHandler(deps: MiniAppDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());

  const userFor = async (request: Request): Promise<string | null> => {
    const identity = verifyInitData(request.headers.get(INIT_DATA_HEADER) ?? "", deps.botToken, now());
    if (!identity) return null;
    const [user] = await deps.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, identity.telegramUserId));
    return user?.id ?? null;
  };

  return async (request) => {
    const userId = await userFor(request);
    if (!userId) return json({ error: "unauthorized" }, 401);

    if (request.method === "GET") {
      const matchId = new URL(request.url).searchParams.get("match");
      if (!matchId) return compressed(request, await deps.explore.list(userId));
      const match = UUID.test(matchId) ? await deps.matches.details(userId, matchId) : null;
      if (!match) return json({ error: "not_found" }, 404);
      const details: ExploreDetails = {
        matchId,
        url: match.sourceUrl,
        description: match.description,
        workMode: match.workMode,
        employmentType: match.employmentType,
        fitEvidence: match.fitEvidence,
        gaps: match.gaps,
        transferableSkills: match.transferableSkills,
      };
      return json(details);
    }

    if (request.method === "POST") {
      const body = (await request.json().catch(() => null)) as { matchId?: unknown; action?: unknown } | null;
      const matchId = typeof body?.matchId === "string" && UUID.test(body.matchId) ? body.matchId : null;
      const action = EXPLORE_ACTIONS.find((a) => a === body?.action);
      if (!matchId || !action) return json({ error: "bad_request" }, 400);
      return (await apply(deps, userId, matchId, action)) ? json({ ok: true }) : json({ error: "not_found" }, 404);
    }

    return json({ error: "method_not_allowed" }, 405);
  };
}

async function apply(deps: MiniAppDeps, userId: string, matchId: string, action: ExploreAction): Promise<boolean> {
  if (action === "applied") return (await deps.applications.applyToMatch(userId, matchId)).kind !== "not_found";
  return (await deps.feedback.record(userId, matchId, action)) !== null;
}
