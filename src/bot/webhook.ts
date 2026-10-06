import { createHash, timingSafeEqual } from "node:crypto";
import type { Bot } from "grammy";
import type { Update } from "grammy/types";
import type { BotContext } from "./bot.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

const digest = (value: string) => createHash("sha256").update(value).digest();

export function createWebhookHandler(
  bot: Bot<BotContext>,
  secret: string,
  runInBackground: (task: Promise<unknown>) => void,
): (request: Request) => Promise<Response> {
  let ready: Promise<void> | undefined;

  return async (request) => {
    if (!timingSafeEqual(digest(request.headers.get(SECRET_HEADER) ?? ""), digest(secret))) {
      return new Response("unauthorized", { status: 401 });
    }
    const update = (await request.json()) as Update;
    ready ??= bot.init().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    // Respond immediately so slow LLM work never hits Telegram's webhook timeout and triggers redelivery.
    runInBackground(
      ready
        .then(() => bot.handleUpdate(update))
        .catch((error: unknown) => console.error("telegram update failed", { updateId: update.update_id, error })),
    );
    return new Response(null, { status: 200 });
  };
}
