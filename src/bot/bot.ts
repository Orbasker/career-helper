import { Bot, type Context, type BotConfig } from "grammy";
import type { AppServices, OnboardingStep } from "../app/services.js";
import { decodeCallback } from "./callbacks.js";
import { WHATS_NEW_LABEL, mainMenu, matchDetailsView, matchListItem, messages } from "./views.js";

export const LATEST_MATCHES_LIMIT = 5;

export type BotContext = Context & { userId: string; hasProfile: boolean };

export function createBot(token: string, services: AppServices, config?: BotConfig<BotContext>): Bot<BotContext> {
  const bot = new Bot<BotContext>(token, config);
  const html = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

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

  const replyOnboardingStep = async (ctx: BotContext, step: OnboardingStep) => {
    if (step.done) await ctx.reply(messages.onboardingDone, { ...html, reply_markup: mainMenu });
    else await ctx.reply(step.question, html);
  };

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
    await ctx.reply(messages.welcomeNew, html);
    await replyOnboardingStep(ctx, await services.onboarding.start(ctx.userId));
  });

  bot.command("help", (ctx) => ctx.reply(messages.help, { ...html, reply_markup: mainMenu }));
  bot.command("new", sendLatest);
  bot.hears(WHATS_NEW_LABEL, sendLatest);

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
    }
  });

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) {
      await ctx.reply(messages.help, { ...html, reply_markup: mainMenu });
      return;
    }
    const outcome = await services.conversation.handleText(ctx.userId, ctx.message.text);
    if (outcome.kind === "onboarding") await replyOnboardingStep(ctx, outcome.step);
    else await ctx.reply(messages.preferenceNoted, { ...html, reply_markup: mainMenu });
  });

  bot.catch(async (err) => {
    console.error("bot update failed", { updateId: err.ctx.update.update_id, error: err.error });
    await err.ctx.reply(messages.error).catch(() => undefined);
  });

  return bot;
}

export const BOT_COMMANDS = [
  { command: "new", description: "Latest job matches" },
  { command: "start", description: "Start or restart onboarding" },
  { command: "help", description: "What I can do" },
];
