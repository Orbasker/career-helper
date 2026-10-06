import { Bot, type Context, type BotConfig } from "grammy";
import { MAX_DOCUMENT_BYTES } from "../app/documents.js";
import type { AppServices, ProfileReply } from "../app/services.js";
import { decodeCallback } from "./callbacks.js";
import {
  MY_PROFILE_LABEL,
  WHATS_NEW_LABEL,
  mainMenu,
  matchDetailsView,
  matchListItem,
  messages,
  profileReplyViews,
} from "./views.js";

export const LATEST_MATCHES_LIMIT = 5;

export type BotContext = Context & { userId: string; hasProfile: boolean };

export interface BotIo {
  downloadFile(filePath: string): Promise<Uint8Array>;
}

export function telegramFiles(token: string): BotIo {
  return {
    async downloadFile(filePath) {
      const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
      if (!response.ok) throw new Error(`Telegram file download failed with ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

const MENU_REPLIES = new Set<ProfileReply["kind"]>(["onboarding_done", "edit_applied", "edit_cancelled", "profile"]);

export function createBot(
  token: string,
  services: AppServices,
  config?: BotConfig<BotContext>,
  io: BotIo = telegramFiles(token),
): Bot<BotContext> {
  const bot = new Bot<BotContext>(token, config);
  const html = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

  const sendReplies = async (ctx: BotContext, replies: ProfileReply[]) => {
    for (const reply of replies) {
      const views = profileReplyViews(reply);
      for (const [i, view] of views.entries()) {
        const isLast = i === views.length - 1;
        const menu = isLast && !view.keyboard && (ctx.hasProfile || MENU_REPLIES.has(reply.kind));
        await ctx.reply(view.text, { ...html, reply_markup: view.keyboard ?? (menu ? mainMenu : undefined) });
      }
    }
  };

  const typing = (ctx: BotContext) => ctx.replyWithChatAction("typing").catch(() => undefined);

  bot.use(async (ctx, next) => {
    if (!ctx.from || !ctx.chat || ctx.chat.type !== "private") return;
    const session = await services.users.ensureUser({
      telegramUserId: ctx.from.id,
      chatId: ctx.chat.id,
      displayName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || undefined,
      locale: ctx.from.language_code,
    });
    ctx.userId = session.userId;
    ctx.hasProfile = session.hasProfile;
    await next();
  });

  const sendLatest = async (ctx: BotContext) => {
    const latest = await services.matches.latest(ctx.userId, LATEST_MATCHES_LIMIT);
    if (latest.length === 0) {
      await ctx.reply(messages.noMatches, { ...html, reply_markup: mainMenu });
      return;
    }
    for (const match of latest) {
      const view = matchListItem(match);
      await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
    }
  };

  bot.command("start", async (ctx) => {
    if (ctx.hasProfile) {
      await ctx.reply(messages.welcomeBack, { ...html, reply_markup: mainMenu });
      return;
    }
    await ctx.reply(messages.welcomeNew, { ...html, reply_markup: { remove_keyboard: true } });
    await sendReplies(ctx, [await services.onboarding.start(ctx.userId)]);
  });

  const showProfile = async (ctx: BotContext) => sendReplies(ctx, [await services.conversation.showProfile(ctx.userId)]);

  bot.command("help", (ctx) => ctx.reply(messages.help, { ...html, reply_markup: mainMenu }));
  bot.command("new", sendLatest);
  bot.hears(WHATS_NEW_LABEL, sendLatest);
  bot.command("profile", showProfile);
  bot.hears(MY_PROFILE_LABEL, showProfile);

  bot.on("message:document", async (ctx) => {
    const { document } = ctx.message;
    if (document.file_size !== undefined && document.file_size > MAX_DOCUMENT_BYTES) {
      await ctx.reply(messages.documentTooLarge, html);
      return;
    }
    await typing(ctx);
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned a file without a path");
    const reply = await services.onboarding.addDocument(ctx.userId, {
      fileRef: document.file_id,
      fileName: document.file_name ?? null,
      mimeType: document.mime_type ?? null,
      data: await io.downloadFile(file.file_path),
    });
    await sendReplies(ctx, [reply]);
  });

  bot.on("callback_query:data", async (ctx) => {
    const action = decodeCallback(ctx.callbackQuery.data);
    if (!action) {
      await ctx.answerCallbackQuery();
      return;
    }

    switch (action.type) {
      case "job_details": {
        const details = await services.matches.details(ctx.userId, action.matchId);
        await ctx.answerCallbackQuery();
        if (!details) {
          await ctx.reply(messages.matchNotFound, html);
          return;
        }
        const view = matchDetailsView(details);
        await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
        return;
      }
      case "feedback": {
        const recorded = await services.feedback.record(ctx.userId, action.matchId, action.verdict);
        if (!recorded) {
          await ctx.answerCallbackQuery({ text: messages.matchNotFound });
          return;
        }
        await ctx.answerCallbackQuery({
          text: action.verdict === "interested" ? messages.feedbackInterested : messages.feedbackNotInterested,
        });
        const details = await services.matches.details(ctx.userId, action.matchId);
        if (details) await ctx.editMessageReplyMarkup({ reply_markup: matchDetailsView(details).keyboard });
        return;
      }
      case "tailor_cv": {
        const outcome = await services.cv.requestTailored(ctx.userId, action.matchId);
        await ctx.answerCallbackQuery();
        const reply = {
          requested: messages.cvRequested,
          already_requested: messages.cvAlreadyRequested,
          not_found: messages.matchNotFound,
        }[outcome];
        await ctx.reply(reply, html);
        return;
      }
      case "onboarding_analyze": {
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        await ctx.reply(messages.analyzing, html);
        await typing(ctx);
        await sendReplies(ctx, [await services.onboarding.analyze(ctx.userId)]);
        return;
      }
      case "onboarding_confirm": {
        await ctx.answerCallbackQuery();
        const reply = await services.onboarding.confirm(ctx.userId);
        if (reply.kind !== "expired") await ctx.editMessageReplyMarkup().catch(() => undefined);
        await sendReplies(ctx, [reply]);
        return;
      }
      case "edit_apply":
      case "edit_cancel": {
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        const reply =
          action.type === "edit_apply"
            ? await services.conversation.applyEdit(ctx.userId, action.token)
            : await services.conversation.cancelEdit(ctx.userId, action.token);
        await sendReplies(ctx, [reply]);
        return;
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      await ctx.reply(messages.help, { ...html, reply_markup: mainMenu });
      return;
    }
    await typing(ctx);
    await sendReplies(ctx, await services.conversation.handleText(ctx.userId, ctx.message.text));
  });

  bot.catch(async (err) => {
    console.error("bot update failed", { updateId: err.ctx.update.update_id, error: err.error });
    await err.ctx.reply(messages.error).catch(() => undefined);
  });

  return bot;
}

export const BOT_COMMANDS = [
  { command: "new", description: "Latest job matches" },
  { command: "profile", description: "Your career profile" },
  { command: "start", description: "Set up your career profile" },
  { command: "help", description: "What I can do" },
];
