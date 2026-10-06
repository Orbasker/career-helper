import type { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { BotContext } from "../../src/bot/bot.js";

export const BOT_INFO: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: "Career Agent",
  username: "career_agent_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

export interface ApiCall {
  method: string;
  payload: Record<string, any>;
}

export function captureApiCalls(bot: Bot<BotContext>): ApiCall[] {
  const calls: ApiCall[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, any> });
    return { ok: true, result: method === "sendMessage" ? { message_id: calls.length } : true } as any;
  });
  return calls;
}

const USER = { id: 1001, is_bot: false, first_name: "Dana", language_code: "en" };
const CHAT = { id: 1001, type: "private" as const, first_name: "Dana" };
let updateId = 0;

export function textUpdate(text: string): Update {
  const entities = text.startsWith("/")
    ? [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }]
    : undefined;
  return {
    update_id: ++updateId,
    message: { message_id: updateId, date: 0, chat: CHAT, from: USER, text, entities },
  };
}

export function callbackUpdate(data: string): Update {
  return {
    update_id: ++updateId,
    callback_query: {
      id: String(updateId),
      from: USER,
      chat_instance: "1",
      data,
      message: { message_id: 99, date: 0, chat: CHAT, from: USER, text: "job" },
    },
  };
}

export const TELEGRAM_USER_ID = USER.id;
