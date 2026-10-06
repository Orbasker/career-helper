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
