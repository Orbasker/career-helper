import { createHash } from "node:crypto";

export function telegramBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");
  return token;
}

export function webhookSecret(token: string): string {
  return createHash("sha256").update(`telegram-webhook:${token}`).digest("hex");
}

export const WEBHOOK_PATH = "/api/telegram";
export const ALLOWED_UPDATES = ["message", "callback_query"] as const;

/** The Mini App's URL: `MINI_APP_URL`, otherwise `/app/` on the production domain; null when neither is known. */
export function miniAppUrl(env: Record<string, string | undefined> = process.env): string | null {
  if (env.MINI_APP_URL) return env.MINI_APP_URL;
  return env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}/app/` : null;
}

/** `ADMIN_TELEGRAM_IDS`: comma-separated Telegram user ids allowed to use operator commands. */
export function adminTelegramIds(env: Record<string, string | undefined> = process.env): number[] {
  return (env.ADMIN_TELEGRAM_IDS ?? "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}
