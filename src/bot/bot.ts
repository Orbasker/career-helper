import { Bot, InlineKeyboard, InputFile, type Context, type BotConfig } from "grammy";
import { MAX_DOCUMENT_BYTES } from "../app/documents.js";
import type { AppServices, ProfileReply } from "../app/services.js";
import type { ConversationLanguage } from "../domain/enums.js";
import { parseLanguageRequest } from "../domain/language.js";
import { decodeCallback, encodeCallback } from "./callbacks.js";
import {
  MY_PROFILE_LABEL,
  WHATS_NEW_LABEL,
  addSiteReply,
  connectionsImportReply,
  connectionsView,
  cvDraftViews,
  feedbackReasonView,
  jobLinkFailureText,
  jobLinkReadingText,
  jobLinkResultView,
  languageKeyboard,
  languageSettingsView,
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

const CONNECTIONS_FILE = /\.(csv|zip)$/i;
const FORGET_CONNECTIONS = /\b(delete|remove|forget|erase)\b.*\b(my )?(linkedin )?(connections|contacts)\b/i;

/** "search on example.co.il", "also look at https://jobs.example.com" and similar requests to add a job site. */
const SITE_REQUEST = /\b(search|look|check)\b[^.?!\n]*?\b(?:on|in|at)\s+((?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?)/i;
const MAX_JOB_LINKS = 3;
const LINK = /https?:\/\/[^\s<>"']+/gi;
const LINKEDIN_PROFILE = /^https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\//i;

/** A request to add a whole site; "look at" followed by a link to one page is about that page, not the site. */
export function siteRequestFrom(text: string): string | null {
  const match = text.match(SITE_REQUEST);
  if (!match) return null;
  const [, verb, site] = match;
  const path = site!.replace(/^https?:\/\//i, "").replace(/\/+$/, "").split("/").slice(1).join("/");
  return verb!.toLowerCase() === "search" || !path ? site! : null;
}

/** Links in a message that may be job postings, without LinkedIn profiles, at most three. */
export function jobLinksFromText(text: string): string[] {
  const links = (text.match(LINK) ?? []).map((l) => l.replace(/[.,;!?)\]]+$/, "")).filter((l) => !LINKEDIN_PROFILE.test(l));
  return [...new Set(links)].slice(0, MAX_JOB_LINKS);
}

export type BotContext = Context & {
  userId: string;
  hasProfile: boolean;
  language: ConversationLanguage | null;
  languagePromptDue: boolean;
};

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
        const hideMenu = reply.kind === "onboarding_welcome" ? { remove_keyboard: true as const } : undefined;
        await ctx.reply(view.text, { ...html, reply_markup: view.keyboard ?? (menu ? mainMenu : hideMenu) });
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
    ctx.language = session.language;
    ctx.languagePromptDue = session.languagePromptDue;
    await next();
    if (ctx.languagePromptDue && (await services.users.claimLanguagePrompt(session.userId))) {
      await ctx.reply(messages.askLanguage, { ...html, reply_markup: languageKeyboard() });
    }
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

  const analyzeJobLink = async (ctx: BotContext, link: string, several: boolean) => {
    await ctx.reply(jobLinkReadingText(link, several), html);
    await typing(ctx);
    const outcome = await services.jobLinks.analyze(ctx.userId, link);
    if (outcome.kind !== "evaluated" && outcome.kind !== "fails_must_have") {
      await ctx.reply(jobLinkFailureText(outcome, several ? link : null), { ...html, reply_markup: mainMenu });
      return;
    }
    const details = await services.matches.details(ctx.userId, outcome.matchId);
    if (!details) {
      await ctx.reply(messages.matchNotFound, html);
      return;
    }
    const view = jobLinkResultView(outcome, details);
    await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
  };

  bot.command("start", async (ctx) => {
    if (ctx.hasProfile) {
      await ctx.reply(messages.welcomeBack, { ...html, reply_markup: mainMenu });
      return;
    }
    await sendReplies(ctx, await services.onboarding.start(ctx.userId));
  });

  const showLanguage = (ctx: BotContext) => {
    ctx.languagePromptDue = false;
    const view = languageSettingsView(ctx.language);
    return ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
  };
  bot.command(["language", "settings"], showLanguage);

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
  const showConnections = async (ctx: BotContext) => {
    const view = connectionsView(await services.connections.summary(ctx.userId));
    await ctx.reply(view.text, { ...html, reply_markup: view.keyboard ?? mainMenu });
  };
  bot.command("connections", showConnections);
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
    const fileName = document.file_name ?? null;
    const data = await io.downloadFile(file.file_path);
    if (fileName && CONNECTIONS_FILE.test(fileName)) {
      const outcome = await services.connections.import(ctx.userId, { data, fileName });
      await ctx.reply(connectionsImportReply(outcome), { ...html, reply_markup: mainMenu });
      return;
    }
    const reply = await services.onboarding.addDocument(ctx.userId, {
      fileRef: document.file_id,
      fileName,
      mimeType: document.mime_type ?? null,
      data,
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
      case "set_language": {
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        await sendReplies(ctx, await services.conversation.setLanguage(ctx.userId, action.language));
        return;
      }
      case "connections_delete": {
        const deleted = await services.connections.forget(ctx.userId);
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        await ctx.reply(deleted ? messages.connectionsDeleted : messages.connectionsNone, { ...html, reply_markup: mainMenu });
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
    const languageRequest = parseLanguageRequest(ctx.message.text);
    if (languageRequest === "menu") {
      await showLanguage(ctx);
      return;
    }
    if (languageRequest) {
      await sendReplies(ctx, await services.conversation.setLanguage(ctx.userId, languageRequest));
      return;
    }
    if (FORGET_CONNECTIONS.test(ctx.message.text)) {
      const deleted = await services.connections.forget(ctx.userId);
      await ctx.reply(deleted ? messages.connectionsDeleted : messages.connectionsNone, { ...html, reply_markup: mainMenu });
      return;
    }
    const siteRequest = siteRequestFrom(ctx.message.text);
    if (siteRequest && ctx.hasProfile) {
      await addSite(ctx, siteRequest);
      return;
    }
    if (await services.feedback.takeReasonText(ctx.userId, ctx.message.text)) {
      await ctx.reply(messages.feedbackReasonTextSaved, { ...html, reply_markup: mainMenu });
      return;
    }
    const links = ctx.hasProfile ? jobLinksFromText(ctx.message.text) : [];
    if (links.length > 0) {
      for (const link of links) await analyzeJobLink(ctx, link, links.length > 1);
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
  { command: "connections", description: "Who you know at matched companies" },
  { command: "language", description: "Choose English or Hebrew" },
  { command: "start", description: "Set up your career profile" },
  { command: "help", description: "What I can do" },
];
