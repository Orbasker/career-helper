import { timingSafeEqual } from "node:crypto";
import type { IngestReport } from "./ingest.js";
import { summarize } from "./run.js";

export function createIngestCronHandler(secret: string | undefined, run: () => Promise<IngestReport[]>) {
  return async (request: Request): Promise<Response> => {
    if (!secret || !matches(request.headers.get("authorization"), `Bearer ${secret}`)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const reports = await run();
    return Response.json({ sources: reports.map(summarize) });
  };
}

function matches(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
