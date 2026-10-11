import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a Mini App launch stays valid; Telegram re-signs the data every time the app is opened. */
export const INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * The Telegram user a Mini App's `initData` was signed for, or null when the signature is wrong, the data is too old or
 * it names no user. See https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  now: Date,
  maxAgeSeconds = INIT_DATA_MAX_AGE_SECONDS,
): { telegramUserId: number } | null {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const expected = signature(params, botToken);
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now.getTime() / 1000 - authDate > maxAgeSeconds) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "null") as { id?: unknown } | null;
    return typeof user?.id === "number" && Number.isSafeInteger(user.id) ? { telegramUserId: user.id } : null;
  } catch {
    return null;
  }
}

/** Signs `fields` the way Telegram does, for tests and local development. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  params.set("hash", signature(params, botToken).toString("hex"));
  return params.toString();
}

function signature(params: URLSearchParams, botToken: string): Buffer {
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  return createHmac("sha256", secret).update(dataCheckString).digest();
}
