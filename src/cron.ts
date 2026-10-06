import { timingSafeEqual } from "node:crypto";

export function createCronHandler(secret: string | undefined, run: () => Promise<unknown>) {
  return async (request: Request): Promise<Response> => {
    if (!secret || !matches(request.headers.get("authorization"), `Bearer ${secret}`)) {
      return new Response("Unauthorized", { status: 401 });
    }
    return Response.json(await run());
  };
}

function matches(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
