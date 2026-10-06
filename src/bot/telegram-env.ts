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

/** `ADMIN_TELEGRAM_IDS`: comma-separated Telegram user ids allowed to use operator commands. */
export function adminTelegramIds(env: Record<string, string | undefined> = process.env): number[] {
  return (env.ADMIN_TELEGRAM_IDS ?? "")
    .split(",")
    .map((id) => Number(id.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}
