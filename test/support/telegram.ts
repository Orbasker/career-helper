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
    if (method === "getFile") {
      return { ok: true, result: { file_id: "file-1", file_unique_id: "u1", file_path: "documents/file-1" } } as any;
    }
    return { ok: true, result: method === "sendMessage" ? { message_id: calls.length } : true } as any;
  });
  return calls;
}

export interface TelegramPerson {
  id: number;
  name: string;
}

export const DANA: TelegramPerson = { id: 1001, name: "Dana" };
export const NOA: TelegramPerson = { id: 2002, name: "Noa" };

const user = (p: TelegramPerson) => ({ id: p.id, is_bot: false, first_name: p.name, language_code: "en" });
const chat = (p: TelegramPerson) => ({ id: p.id, type: "private" as const, first_name: p.name });
let updateId = 0;

export function textUpdate(text: string, person: TelegramPerson = DANA): Update {
  const entities = text.startsWith("/")
    ? [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }]
    : undefined;
  return {
    update_id: ++updateId,
    message: { message_id: updateId, date: 0, chat: chat(person), from: user(person), text, entities },
  };
}

export function documentUpdate(
  document: { fileName: string; mimeType: string; fileSize?: number },
  person: TelegramPerson = DANA,
): Update {
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: chat(person),
      from: user(person),
      document: {
        file_id: `file-${updateId}`,
        file_unique_id: `u-${updateId}`,
        file_name: document.fileName,
        mime_type: document.mimeType,
        file_size: document.fileSize ?? 1000,
      },
    },
  };
}

export function callbackUpdate(data: string, person: TelegramPerson = DANA): Update {
  return {
    update_id: ++updateId,
    callback_query: {
      id: String(updateId),
      from: user(person),
      chat_instance: "1",
      data,
      message: { message_id: 99, date: 0, chat: chat(person), from: user(person), text: "job" },
    },
  };
}

export const TELEGRAM_USER_ID = DANA.id;
