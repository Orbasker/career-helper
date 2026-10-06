import { Bot, InlineKeyboard, InputFile, type Context, type BotConfig } from "grammy";
import { MAX_DOCUMENT_BYTES } from "../app/documents.js";
import type { AppServices, ProfileReply } from "../app/services.js";
import { decodeCallback, encodeCallback } from "./callbacks.js";
import {
  MY_PROFILE_LABEL,
  WHATS_NEW_LABEL,
  addSiteReply,
  cvDraftViews,
  feedbackReasonView,
  mainMenu,
  matchDetailsView,
  matchListItem,
  messages,
  profileReplyViews,
  proposalView,
  sitesView,
  type View,
} from "./views.js";

export const LATEST_MATCHES_LIMIT = 5;

/** "search on example.co.il", "also look at https://jobs.example.com" and similar requests to add a job site. */
const SITE_REQUEST = /\b(?:search|look|check)\b[^.?!\n]*?\b(?:on|in|at)\s+((?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?)/i;

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

export interface BotOptions {
  /** Telegram user ids allowed to use operator commands such as /stats. */
  adminTelegramIds?: readonly number[];
}

export function createBot(
  token: string,
  services: AppServices,
  config?: BotConfig<BotContext>,
  io: BotIo = telegramFiles(token),
  options: BotOptions = {},
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

  const sendViews = async (ctx: BotContext, views: View[]) => {
    for (const view of views) await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
  };

  const sendCvDocument = async (ctx: BotContext, versionId: string) => {
    const file = await services.cv.document(ctx.userId, versionId).catch((error) => {
      console.error("cv document failed", { versionId, error });
      return null;
    });
    if (!file) {
      const retry = new InlineKeyboard().text("📄 Send document", encodeCallback({ type: "cv_document", versionId }));
      await ctx.reply(messages.cvDocumentFailed, { ...html, reply_markup: retry });
      return;
    }
    const document = file.kind === "cached" ? file.fileRef : new InputFile(file.data, file.fileName);
    const sent = await ctx.replyWithDocument(document, { caption: messages.cvDocumentCaption });
    const fileRef = sent?.document?.file_id;
    if (file.kind === "rendered" && fileRef) await services.cv.saveDocumentRef(ctx.userId, versionId, fileRef);
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

  const sendProposals = async (ctx: BotContext) => {
    for (const proposal of await services.feedback.learn(ctx.userId)) {
      const view = proposalView(proposal);
      await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
    }
  };

  const sendLatest = async (ctx: BotContext) => {
    const latest = await services.matches.whatsNew(ctx.userId, LATEST_MATCHES_LIMIT);
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

  const showSites = async (ctx: BotContext) => {
    const view = sitesView(await services.sites.list(ctx.userId));
    await ctx.reply(view.text, { ...html, reply_markup: view.keyboard ?? mainMenu });
  };
  const addSite = async (ctx: BotContext, input: string) => {
    await ctx.reply(addSiteReply(await services.sites.add(ctx.userId, input)), { ...html, reply_markup: mainMenu });
  };
  bot.command("sites", showSites);
  bot.command("stats", async (ctx) => {
    if (!ctx.from || !options.adminTelegramIds?.includes(ctx.from.id)) {
      await ctx.reply(messages.help, { ...html, reply_markup: mainMenu });
      return;
    }
    const days = Math.min(90, Math.max(1, Number.parseInt(ctx.match, 10) || 7));
    await ctx.reply(await services.stats.report(days), html);
  });
  bot.command("addsite", async (ctx) => {
    const input = ctx.match.trim();
    if (!input) {
      await ctx.reply(messages.siteUsage, html);
      return;
    }
    await addSite(ctx, input);
  });
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
        if (action.verdict === "not_interested") {
          const view = feedbackReasonView(recorded.feedbackId);
          await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
          await sendProposals(ctx);
        }
        return;
      }
      case "feedback_reason": {
        const saved = await services.feedback.addReasonTag(ctx.userId, action.feedbackId, action.tag);
        await ctx.answerCallbackQuery({ text: saved ? messages.feedbackReasonNoted : messages.matchNotFound });
        if (saved) await sendProposals(ctx);
        return;
      }
      case "feedback_reason_text": {
        const waiting = await services.feedback.awaitReasonText(ctx.userId, action.feedbackId);
        await ctx.answerCallbackQuery();
        await ctx.reply(waiting ? messages.feedbackReasonTextPrompt : messages.matchNotFound, html);
        return;
      }
      case "proposal_decision": {
        const outcome = await services.feedback.decideProposal(ctx.userId, action.preferenceId, action.accept);
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        const reply = { accepted: messages.proposalAccepted, rejected: messages.proposalRejected, not_found: messages.expired }[
          outcome
        ];
        await ctx.reply(reply, { ...html, reply_markup: mainMenu });
        return;
      }
      case "tailor_cv": {
        const outcome = await services.cv.requestTailored(ctx.userId, action.matchId);
        await ctx.answerCallbackQuery();
        switch (outcome.kind) {
          case "not_found":
            await ctx.reply(messages.matchNotFound, html);
            return;
          case "in_progress":
            await ctx.reply(messages.cvInProgress, html);
            return;
          case "draft": {
            const draft = await services.cv.draft(ctx.userId, outcome.versionId);
            if (draft) await sendViews(ctx, cvDraftViews(draft));
            return;
          }
          case "requested": {
            await ctx.reply(messages.cvRequested, html);
            await typing(ctx);
            const result = await services.cv.tailor(ctx.userId, outcome.versionId);
            if (result.kind === "draft") await sendViews(ctx, cvDraftViews(result.draft));
            else await ctx.reply(messages.cvFailed, html);
            return;
          }
        }
        return;
      }
      case "site_remove": {
        const removed = await services.sites.remove(ctx.userId, action.siteId);
        await ctx.answerCallbackQuery({ text: removed ? messages.siteRemoved : messages.expired });
        const view = sitesView(await services.sites.list(ctx.userId));
        await ctx.editMessageText(view.text, { ...html, reply_markup: view.keyboard }).catch(() => undefined);
        return;
      }
      case "cv_document": {
        await ctx.answerCallbackQuery();
        await sendCvDocument(ctx, action.versionId);
        return;
      }
      case "cv_decision": {
        const decision = await services.cv.decide(ctx.userId, action.versionId, action.approve);
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        const reply = { approved: messages.cvApproved, discarded: messages.cvDiscarded, not_found: messages.expired }[decision];
        await ctx.reply(reply, { ...html, reply_markup: mainMenu });
        if (decision === "approved") await sendCvDocument(ctx, action.versionId);
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
    const siteRequest = ctx.message.text.match(SITE_REQUEST);
    if (siteRequest && ctx.hasProfile) {
      await addSite(ctx, siteRequest[1]!);
      return;
    }
    if (await services.feedback.takeReasonText(ctx.userId, ctx.message.text)) {
      await ctx.reply(messages.feedbackReasonTextSaved, { ...html, reply_markup: mainMenu });
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
  { command: "sites", description: "Job sites I search for you" },
  { command: "start", description: "Set up your career profile" },
  { command: "help", description: "What I can do" },
];
