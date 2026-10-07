import { Bot, InlineKeyboard, InputFile, type Api, type Context, type BotConfig } from "grammy";
import { MAX_DOCUMENT_BYTES } from "../app/documents.js";
import type { AppServices, ApplicationView, ApplyOutcome, CvRequestOutcome, ProfileReply } from "../app/services.js";
import { applicationLink, isApplicationsRequest, parseApplicationDetails } from "../domain/applications.js";
import { parseCvLibraryRequest } from "../domain/cv-library.js";
import { CONVERSATION_LANGUAGES, type ConversationLanguage, type CvFileFormat } from "../domain/enums.js";
import { DEFAULT_LANGUAGE, parseLanguageRequest } from "../domain/language.js";
import { ALL_STRINGS, strings, type Strings } from "../i18n/index.js";
import { decodeCallback, encodeCallback, type DocumentAction } from "./callbacks.js";
import {
  ASK_LANGUAGE,
  addSiteReply,
  applicationCardView,
  applicationsViews,
  boardsViews,
  botCommands,
  chooseDefaultView,
  connectionsImportReply,
  connectionsView,
  cvDocumentKeyboard,
  cvDraftViews,
  cvLibraryViews,
  documentCardView,
  documentName,
  escapeHtml,
  feedbackReasonView,
  jobLinkFailureText,
  jobLinkReadingText,
  jobLinkResultView,
  languageKeyboard,
  languageSettingsView,
  mainMenu,
  matchDetailsView,
  matchListItem,
  profileReplyViews,
  proposalView,
  removeDocumentView,
  sitesView,
  sourcesView,
  type View,
} from "./views.js";

export const LATEST_MATCHES_LIMIT = 5;

const CONNECTIONS_FILE = /\.(csv|zip)$/i;
const FORGET_CONNECTIONS = [
  /\b(delete|remove|forget|erase)\b.*\b(my )?(linkedin )?(connections|contacts)\b/i,
  /(?:^|\s)(?:ת?מחק|ל?מחוק|ת?שכח|ל?שכוח)\s.*אנשי (?:ה)?קשר/,
];

const DOMAIN = String.raw`((?:https?:\/\/)?(?:[\w-]+\.)+[a-z]{2,}(?:\/\S*)?)`;
/** "search on example.co.il", "also look at https://jobs.example.com" and similar requests to add a job site. */
const SITE_REQUEST = new RegExp(String.raw`\b(search|look|check)\b[^.?!\n]*?\b(?:on|in|at)\s+${DOMAIN}`, "i");
/** "חפש גם ב-example.co.il", "תחפש באתר example.co.il". */
const HEBREW_SITE_REQUEST = new RegExp(String.raw`(?:^|\s)(?:ת?חפש|ל?חפש)\s[^.?!\n]*?ב[-־]?\s*(?:אתר\s+)?${DOMAIN}`, "i");
const MAX_JOB_LINKS = 3;
const LINK = /https?:\/\/[^\s<>"']+/gi;
const LINKEDIN_PROFILE = /^https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\//i;

/** A request to add a whole site; "look at" followed by a link to one page is about that page, not the site. */
export function siteRequestFrom(text: string): string | null {
  const hebrew = text.match(HEBREW_SITE_REQUEST);
  if (hebrew) return hebrew[1]!;
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

/** "where are you searching?", "which sites do you check?", "איפה אתה מחפש?" and similar questions about job sources. */
const SOURCES_REQUEST =
  /\bwhere (?:are|do|did) you (?:search|look|find|get|check)|\b(?:which|what) (?:sites|sources|boards|job boards) (?:do|are|did) you\b|\b(?:your|job|search) sources\b|איפה (?:אתה |את )?(?:מחפש|מחפשת|חיפשת)|באילו (?:אתרים|מקורות)|מאיפה (?:אתה מביא|את מביאה|הגיעו|מגיעות)/i;

export type BotContext = Context & {
  userId: string;
  hasProfile: boolean;
  language: ConversationLanguage | null;
  /** Copy in the user's language, or the default language until they choose one. */
  t: Strings;
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

  const locale = (ctx: BotContext) => ctx.language ?? DEFAULT_LANGUAGE;

  const useLanguage = async (ctx: BotContext, language: ConversationLanguage) => {
    ctx.language = language;
    ctx.t = strings(language);
    if (!ctx.chat) return;
    await ctx.api
      .setMyCommands(botCommands(ctx.t), { scope: { type: "chat", chat_id: ctx.chat.id } })
      .catch((error) => console.error("setting chat commands failed", { error }));
  };

  const sendReplies = async (ctx: BotContext, replies: ProfileReply[]) => {
    for (const reply of replies) {
      if (reply.kind === "language_saved") await useLanguage(ctx, reply.language);
      const views = profileReplyViews(ctx.t, reply);
      for (const [i, view] of views.entries()) {
        const isLast = i === views.length - 1;
        const menu = isLast && !view.keyboard && (ctx.hasProfile || MENU_REPLIES.has(reply.kind));
        const hideMenu = reply.kind === "onboarding_welcome" ? { remove_keyboard: true as const } : undefined;
        await ctx.reply(view.text, { ...html, reply_markup: view.keyboard ?? (menu ? mainMenu(ctx.t) : hideMenu) });
      }
    }
  };

  const sendViews = async (ctx: BotContext, views: View[]) => {
    for (const view of views) await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
  };

  const sendCvDocument = async (ctx: BotContext, versionId: string, format: CvFileFormat = "docx") => {
    const file = await services.cv.document(ctx.userId, versionId, format).catch((error) => {
      console.error("cv document failed", { versionId, format, error });
      return null;
    });
    if (!file) {
      const retry = new InlineKeyboard().text(ctx.t.buttons.sendDocument, encodeCallback({ type: "cv_document", versionId, format }));
      await ctx.reply(ctx.t.messages.cvDocumentFailed, { ...html, reply_markup: retry });
      return;
    }
    const document = file.kind === "cached" ? file.fileRef : new InputFile(file.data, file.fileName);
    const sent = await ctx.replyWithDocument(document, {
      caption: ctx.t.messages.cvDocumentCaption,
      reply_markup: cvDocumentKeyboard(ctx.t, versionId, file),
    });
    const fileRef = sent?.document?.file_id;
    if (file.kind === "rendered" && fileRef) await services.cv.saveDocumentRef(ctx.userId, versionId, format, fileRef);
  };

  /** Sends what a CV request led to, tailoring a new request right away. */
  const sendCvOutcome = async (ctx: BotContext, outcome: CvRequestOutcome, requestedMessage: string) => {
    switch (outcome.kind) {
      case "not_found":
        await ctx.reply(ctx.t.messages.matchNotFound, html);
        return;
      case "in_progress":
        await ctx.reply(ctx.t.messages.cvInProgress, html);
        return;
      case "approved":
        await sendCvDocument(ctx, outcome.versionId);
        return;
      case "draft": {
        const draft = await services.cv.draft(ctx.userId, outcome.versionId);
        if (draft) await sendViews(ctx, cvDraftViews(ctx.t, draft));
        return;
      }
      case "requested": {
        await ctx.reply(requestedMessage, html);
        await typing(ctx);
        const result = await services.cv.tailor(ctx.userId, outcome.versionId);
        if (result.kind === "draft") await sendViews(ctx, cvDraftViews(ctx.t, result.draft));
        else await ctx.reply(ctx.t.messages.cvFailed, html);
        return;
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
    ctx.language = session.language;
    ctx.t = strings(session.language);
    ctx.languagePromptDue = session.languagePromptDue;
    await next();
    if (ctx.languagePromptDue && (await services.users.claimLanguagePrompt(session.userId))) {
      await ctx.reply(ASK_LANGUAGE, { ...html, reply_markup: languageKeyboard() });
    }
  });

  const sendProposals = async (ctx: BotContext) => {
    for (const proposal of await services.feedback.learn(ctx.userId, locale(ctx))) {
      const view = proposalView(ctx.t, proposal);
      await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
    }
  };

  const sendLatest = async (ctx: BotContext) => {
    const latest = await services.matches.whatsNew(ctx.userId, LATEST_MATCHES_LIMIT);
    if (latest.length === 0) {
      await ctx.reply(ctx.t.messages.noMatches, { ...html, reply_markup: mainMenu(ctx.t) });
      return;
    }
    for (const match of latest) {
      const view = matchListItem(ctx.t, match);
      await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
    }
  };

  const analyzeJobLink = async (ctx: BotContext, link: string, several: boolean) => {
    await ctx.reply(jobLinkReadingText(ctx.t, link, several), html);
    await typing(ctx);
    const outcome = await services.jobLinks.analyze(ctx.userId, link);
    if (outcome.kind !== "evaluated" && outcome.kind !== "fails_must_have") {
      await ctx.reply(jobLinkFailureText(ctx.t, outcome, several ? link : null), { ...html, reply_markup: mainMenu(ctx.t) });
      return;
    }
    const details = await services.matches.details(ctx.userId, outcome.matchId);
    if (!details) {
      await ctx.reply(ctx.t.messages.matchNotFound, html);
      return;
    }
    const view = jobLinkResultView(ctx.t, outcome, details);
    await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
  };

  bot.command("start", async (ctx) => {
    if (ctx.hasProfile) {
      await ctx.reply(ctx.t.messages.welcomeBack, { ...html, reply_markup: mainMenu(ctx.t) });
      return;
    }
    await sendReplies(ctx, await services.onboarding.start(ctx.userId));
  });

  const showLanguage = (ctx: BotContext) => {
    ctx.languagePromptDue = false;
    const view = languageSettingsView(ctx.t, ctx.language);
    return ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
  };
  bot.command(["language", "settings"], showLanguage);


  const showProfile = async (ctx: BotContext) => sendReplies(ctx, [await services.conversation.showProfile(ctx.userId)]);

  const showHelp = (ctx: BotContext) => ctx.reply(ctx.t.messages.help, { ...html, reply_markup: mainMenu(ctx.t) });

  bot.command("help", showHelp);
  bot.command("new", sendLatest);
  bot.hears(ALL_STRINGS.map((t) => t.menu.whatsNew), sendLatest);
  bot.command("profile", showProfile);

  const showSites = async (ctx: BotContext) => {
    const view = sitesView(ctx.t, await services.sites.list(ctx.userId));
    await ctx.reply(view.text, { ...html, reply_markup: view.keyboard ?? mainMenu(ctx.t) });
  };
  const addSite = async (ctx: BotContext, input: string) => {
    await ctx.reply(addSiteReply(ctx.t, await services.sites.add(ctx.userId, input)), { ...html, reply_markup: mainMenu(ctx.t) });
  };
  bot.command("sites", showSites);
  const showSources = async (ctx: BotContext) => {
    const view = sourcesView(ctx.t, await services.sources.overview(ctx.userId));
    await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
  };
  bot.command("sources", showSources);
  const showConnections = async (ctx: BotContext) => {
    const view = connectionsView(ctx.t, await services.connections.summary(ctx.userId));
    await ctx.reply(view.text, { ...html, reply_markup: view.keyboard ?? mainMenu(ctx.t) });
  };
  bot.command("connections", showConnections);
  const showDocuments = async (ctx: BotContext) => {
    const documents = await services.documents.list(ctx.userId);
    if (!documents) {
      await ctx.reply(ctx.t.messages.notOnboarded, html);
      return;
    }
    await sendViews(ctx, cvLibraryViews(ctx.t, documents));
  };
  bot.command("cvs", showDocuments);

  const showApplications = async (ctx: BotContext) => {
    const list = await services.applications.list(ctx.userId);
    if (!list) {
      await ctx.reply(ctx.t.messages.notOnboarded, html);
      return;
    }
    await sendViews(ctx, applicationsViews(ctx.t, list));
  };
  bot.command("applications", showApplications);

  const sendApplication = (ctx: BotContext, application: ApplicationView) =>
    sendViews(ctx, [applicationCardView(ctx.t, application)]);

  const sendApplyOutcome = async (ctx: BotContext, outcome: ApplyOutcome) => {
    if (outcome.kind === "not_found") {
      await ctx.reply(ctx.t.messages.matchNotFound, html);
      return;
    }
    const title = escapeHtml(outcome.application.title);
    await ctx.reply(outcome.kind === "created" ? ctx.t.applications.created(title) : ctx.t.applications.exists(title), html);
    await sendApplication(ctx, outcome.application);
  };

  const askApplicationDetails = async (ctx: BotContext, prompt: string) => {
    if (!(await services.applications.awaitDetails(ctx.userId))) {
      await ctx.reply(ctx.t.messages.notOnboarded, html);
      return;
    }
    await ctx.reply(prompt, html);
  };

  /** Logs an application from "Acme — HR Manager" and/or a link, matching a linked posting first when it can be read. */
  const logApplication = async (ctx: BotContext, text: string) => {
    const link = applicationLink(text);
    const details = parseApplicationDetails(text);
    if (link) {
      await ctx.reply(jobLinkReadingText(ctx.t, link, false), html);
      await typing(ctx);
      const outcome = await services.jobLinks.analyze(ctx.userId, link);
      if (outcome.kind === "evaluated" || outcome.kind === "fails_must_have") {
        await sendApplyOutcome(ctx, await services.applications.applyToMatch(ctx.userId, outcome.matchId));
        return;
      }
      if (!details) {
        await askApplicationDetails(ctx, `${jobLinkFailureText(ctx.t, outcome, null)}\n\n${ctx.t.applications.logLinkFailed}`);
        return;
      }
    }
    if (!details) {
      await askApplicationDetails(ctx, ctx.t.applications.logInvalid);
      return;
    }
    await sendApplyOutcome(ctx, await services.applications.logManual(ctx.userId, { ...details, url: link }));
  };

  bot.command("applied", async (ctx) => {
    const text = ctx.match.trim();
    if (!text || !ctx.hasProfile) {
      await askApplicationDetails(ctx, ctx.t.applications.logPrompt);
      return;
    }
    await logApplication(ctx, text);
  });

  const requestDefaultCv = async (ctx: BotContext, language: ConversationLanguage | null) => {
    const outcome = await services.documents.requestDefault(ctx.userId, language);
    const languageName = language ? ctx.t.documentLanguages[language] : null;
    switch (outcome.kind) {
      case "not_onboarded":
        await ctx.reply(ctx.t.messages.notOnboarded, html);
        return;
      case "none":
        await ctx.reply(ctx.t.cvs.noCvs(languageName), { ...html, reply_markup: mainMenu(ctx.t) });
        return;
      case "choose":
        await sendViews(ctx, [chooseDefaultView(ctx.t, outcome.language, outcome.documents)]);
        return;
      case "set": {
        const { document } = outcome;
        const text = ctx.t.cvs.defaultSet(documentName(ctx.t, document), ctx.t.documentLanguages[document.language!]);
        await ctx.reply(text, { ...html, reply_markup: mainMenu(ctx.t) });
        return;
      }
    }
  };
  bot.command("stats", async (ctx) => {
    if (!ctx.from || !options.adminTelegramIds?.includes(ctx.from.id)) {
      await showHelp(ctx);
      return;
    }
    const days = Math.min(90, Math.max(1, Number.parseInt(ctx.match, 10) || 7));
    await ctx.reply(await services.stats.report(days), html);
  });
  bot.command("addsite", async (ctx) => {
    const input = ctx.match.trim();
    if (!input) {
      await ctx.reply(ctx.t.messages.siteUsage, html);
      return;
    }
    await addSite(ctx, input);
  });
  bot.hears(ALL_STRINGS.map((t) => t.menu.myProfile), showProfile);

  bot.on("message:document", async (ctx) => {
    const { document } = ctx.message;
    if (document.file_size !== undefined && document.file_size > MAX_DOCUMENT_BYTES) {
      await ctx.reply(ctx.t.messages.documentTooLarge, html);
      return;
    }
    await typing(ctx);
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram returned a file without a path");
    const fileName = document.file_name ?? null;
    const data = await io.downloadFile(file.file_path);
    if (fileName && CONNECTIONS_FILE.test(fileName)) {
      const outcome = await services.connections.import(ctx.userId, { data, fileName });
      await ctx.reply(connectionsImportReply(ctx.t, outcome), { ...html, reply_markup: mainMenu(ctx.t) });
      return;
    }
    const replies = await services.conversation.addDocument(ctx.userId, {
      fileRef: document.file_id,
      fileName,
      mimeType: document.mime_type ?? null,
      data,
      sizeBytes: document.file_size ?? null,
      label: ctx.message.caption ?? null,
    }, locale(ctx));
    await sendReplies(ctx, replies);
  });

  const handleDocumentAction = async (ctx: BotContext, documentId: string, action: DocumentAction) => {
    if (action === "default") {
      const outcome = await services.documents.setDefault(ctx.userId, documentId);
      if (outcome.kind !== "set") {
        await ctx.answerCallbackQuery({ text: outcome.kind === "not_eligible" ? ctx.t.cvs.notEligible : ctx.t.messages.expired });
        return;
      }
      await ctx.answerCallbackQuery({ text: ctx.t.cvs.defaultFor(ctx.t.documentLanguages[outcome.document.language!]) });
      const card = documentCardView(ctx.t, outcome.document);
      await ctx.editMessageText(card.text, { ...html, reply_markup: card.keyboard }).catch(() => undefined);
      return;
    }
    const document =
      action === "label"
        ? await services.documents.awaitLabel(ctx.userId, documentId)
        : action === "replace"
          ? await services.documents.awaitReplacement(ctx.userId, documentId)
          : action === "remove"
            ? await services.documents.get(ctx.userId, documentId)
            : await services.documents.remove(ctx.userId, documentId);
    if (!document) {
      await ctx.answerCallbackQuery({ text: ctx.t.messages.expired });
      return;
    }
    await ctx.answerCallbackQuery();
    const name = documentName(ctx.t, document);
    switch (action) {
      case "label":
        await ctx.reply(ctx.t.cvs.labelPrompt(name), html);
        return;
      case "replace":
        await ctx.reply(ctx.t.cvs.replacePrompt(name), html);
        return;
      case "remove":
        await sendViews(ctx, [removeDocumentView(ctx.t, document)]);
        return;
      case "confirm_remove":
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        await ctx.reply(ctx.t.cvs.removed(name), { ...html, reply_markup: mainMenu(ctx.t) });
        return;
    }
  };

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
          await ctx.reply(ctx.t.messages.matchNotFound, html);
          return;
        }
        const view = matchDetailsView(ctx.t, details);
        await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
        return;
      }
      case "feedback": {
        const recorded = await services.feedback.record(ctx.userId, action.matchId, action.verdict);
        if (!recorded) {
          await ctx.answerCallbackQuery({ text: ctx.t.messages.matchNotFound });
          return;
        }
        await ctx.answerCallbackQuery({
          text: action.verdict === "interested" ? ctx.t.messages.feedbackInterested : ctx.t.messages.feedbackNotInterested,
        });
        const details = await services.matches.details(ctx.userId, action.matchId);
        if (details) await ctx.editMessageReplyMarkup({ reply_markup: matchDetailsView(ctx.t, details).keyboard });
        if (action.verdict === "not_interested") {
          const view = feedbackReasonView(ctx.t, recorded.feedbackId);
          await ctx.reply(view.text, { ...html, reply_markup: view.keyboard });
          await sendProposals(ctx);
        }
        return;
      }
      case "feedback_reason": {
        const saved = await services.feedback.addReasonTag(ctx.userId, action.feedbackId, action.tag);
        await ctx.answerCallbackQuery({ text: saved ? ctx.t.messages.feedbackReasonNoted : ctx.t.messages.matchNotFound });
        if (saved) await sendProposals(ctx);
        return;
      }
      case "feedback_reason_text": {
        const waiting = await services.feedback.awaitReasonText(ctx.userId, action.feedbackId);
        await ctx.answerCallbackQuery();
        await ctx.reply(waiting ? ctx.t.messages.feedbackReasonTextPrompt : ctx.t.messages.matchNotFound, html);
        return;
      }
      case "proposal_decision": {
        const outcome = await services.feedback.decideProposal(ctx.userId, action.preferenceId, action.accept);
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        const { proposalAccepted, proposalRejected, expired } = ctx.t.messages;
        const reply = { accepted: proposalAccepted, rejected: proposalRejected, not_found: expired }[outcome];
        await ctx.reply(reply, { ...html, reply_markup: mainMenu(ctx.t) });
        return;
      }
      case "tailor_cv": {
        const outcome = await services.cv.requestTailored(ctx.userId, action.matchId);
        await ctx.answerCallbackQuery();
        await sendCvOutcome(ctx, outcome, ctx.t.messages.cvRequested);
        return;
      }
      case "cv_language": {
        const outcome = await services.cv.requestLanguage(ctx.userId, action.versionId, action.language);
        await ctx.answerCallbackQuery();
        await sendCvOutcome(ctx, outcome, ctx.t.messages.cvLanguageRequested(ctx.t.documentLanguages[action.language]));
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
        await ctx.reply(deleted ? ctx.t.messages.connectionsDeleted : ctx.t.messages.connectionsNone, {
          ...html,
          reply_markup: mainMenu(ctx.t),
        });
        return;
      }
      case "site_remove": {
        const removed = await services.sites.remove(ctx.userId, action.siteId);
        await ctx.answerCallbackQuery({ text: removed ? ctx.t.messages.siteRemoved : ctx.t.messages.expired });
        const view = sitesView(ctx.t, await services.sites.list(ctx.userId));
        await ctx.editMessageText(view.text, { ...html, reply_markup: view.keyboard }).catch(() => undefined);
        return;
      }
      case "sources_boards": {
        await ctx.answerCallbackQuery();
        await sendViews(ctx, boardsViews(ctx.t, await services.sources.overview(ctx.userId)));
        return;
      }
      case "sources_sites": {
        await ctx.answerCallbackQuery();
        await showSites(ctx);
        return;
      }
      case "cv_document": {
        await ctx.answerCallbackQuery();
        await sendCvDocument(ctx, action.versionId, action.format);
        return;
      }
      case "cv_decision": {
        const decision = await services.cv.decide(ctx.userId, action.versionId, action.approve);
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        const { cvApproved, cvDiscarded, expired } = ctx.t.messages;
        const reply = { approved: cvApproved, discarded: cvDiscarded, not_found: expired }[decision];
        await ctx.reply(reply, { ...html, reply_markup: mainMenu(ctx.t) });
        if (decision === "approved") await sendCvDocument(ctx, action.versionId);
        return;
      }
      case "onboarding_analyze": {
        await ctx.answerCallbackQuery();
        await ctx.editMessageReplyMarkup().catch(() => undefined);
        await ctx.reply(ctx.t.messages.analyzing, html);
        await typing(ctx);
        await sendReplies(ctx, [await services.onboarding.analyze(ctx.userId, locale(ctx))]);
        return;
      }
      case "document_language": {
        const saved = await services.onboarding.setDocumentLanguage(ctx.userId, action.documentId, action.language);
        await ctx.answerCallbackQuery({
          text: saved ? ctx.t.documents.languageMarked(ctx.t.documentLanguages[action.language]) : ctx.t.messages.expired,
        });
        if (saved) {
          const rows = ctx.callbackQuery.message?.reply_markup?.inline_keyboard ?? [];
          const cardAction = encodeCallback({ type: "document_action", documentId: action.documentId, action: "label" });
          if (rows.flat().some((button) => "callback_data" in button && button.callback_data === cardAction)) {
            const document = await services.documents.get(ctx.userId, action.documentId);
            if (document) {
              const card = documentCardView(ctx.t, document);
              await ctx.editMessageText(card.text, { ...html, reply_markup: card.keyboard }).catch(() => undefined);
              return;
            }
          }
          const kept = rows
            .map((row) => row.filter((button) => !("callback_data" in button && button.callback_data.startsWith("dl:"))))
            .filter((row) => row.length > 0);
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: kept } }).catch(() => undefined);
        }
        return;
      }
      case "documents": {
        await ctx.answerCallbackQuery();
        await showDocuments(ctx);
        return;
      }
      case "document_upload": {
        await ctx.answerCallbackQuery();
        await ctx.reply(ctx.t.cvs.uploadHowTo, html);
        return;
      }
      case "document": {
        const document = await services.documents.get(ctx.userId, action.documentId);
        await ctx.answerCallbackQuery(document ? undefined : { text: ctx.t.messages.expired });
        if (document) await sendViews(ctx, [documentCardView(ctx.t, document)]);
        return;
      }
      case "document_action":
        await handleDocumentAction(ctx, action.documentId, action.action);
        return;
      case "onboarding_confirm": {
        await ctx.answerCallbackQuery();
        const reply = await services.onboarding.confirm(ctx.userId);
        if (reply.kind !== "expired") await ctx.editMessageReplyMarkup().catch(() => undefined);
        await sendReplies(ctx, [reply]);
        return;
      }
      case "applications": {
        await ctx.answerCallbackQuery();
        await showApplications(ctx);
        return;
      }
      case "application_log": {
        await ctx.answerCallbackQuery();
        await askApplicationDetails(ctx, ctx.t.applications.logPrompt);
        return;
      }
      case "application": {
        const application = await services.applications.get(ctx.userId, action.applicationId);
        await ctx.answerCallbackQuery(application ? undefined : { text: ctx.t.messages.expired });
        if (application) await sendApplication(ctx, application);
        return;
      }
      case "apply_match": {
        await ctx.answerCallbackQuery();
        const outcome = await services.applications.applyToMatch(ctx.userId, action.matchId);
        const details = outcome.kind === "not_found" ? null : await services.matches.details(ctx.userId, action.matchId);
        if (details) await ctx.editMessageReplyMarkup({ reply_markup: matchDetailsView(ctx.t, details).keyboard }).catch(() => undefined);
        await sendApplyOutcome(ctx, outcome);
        return;
      }
      case "apply_cv": {
        await ctx.answerCallbackQuery();
        await sendApplyOutcome(ctx, await services.applications.applyWithCv(ctx.userId, action.versionId));
        return;
      }
      case "application_status": {
        const change = await services.applications.setStatus(ctx.userId, action.applicationId, action.status);
        if (change.kind === "not_found") {
          await ctx.answerCallbackQuery({ text: ctx.t.messages.expired });
          return;
        }
        const { statusChanged, statusUnchanged, statuses } = ctx.t.applications;
        await ctx.answerCallbackQuery({ text: change.kind === "changed" ? statusChanged(statuses[action.status]) : statusUnchanged });
        const card = applicationCardView(ctx.t, change.application);
        await ctx.editMessageText(card.text, { ...html, reply_markup: card.keyboard }).catch(() => undefined);
        return;
      }
      case "application_note": {
        const application = await services.applications.awaitNote(ctx.userId, action.applicationId);
        await ctx.answerCallbackQuery(application ? undefined : { text: ctx.t.messages.expired });
        if (application) await ctx.reply(ctx.t.applications.notePrompt(escapeHtml(application.title)), html);
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
      await showHelp(ctx);
      return;
    }
    const labelled = await services.documents.takeLabel(ctx.userId, ctx.message.text);
    if (labelled) {
      await ctx.reply(ctx.t.cvs.labelSaved(documentName(ctx.t, labelled)), html);
      await sendViews(ctx, [documentCardView(ctx.t, labelled)]);
      return;
    }
    const noted = await services.applications.takeNote(ctx.userId, ctx.message.text);
    if (noted) {
      await ctx.reply(ctx.t.applications.noteSaved, html);
      await sendApplication(ctx, noted);
      return;
    }
    if (await services.applications.takeDetails(ctx.userId)) {
      await logApplication(ctx, ctx.message.text);
      return;
    }
    if (isApplicationsRequest(ctx.message.text)) {
      await showApplications(ctx);
      return;
    }
    const cvRequest = parseCvLibraryRequest(ctx.message.text);
    if (cvRequest?.kind === "list") {
      await showDocuments(ctx);
      return;
    }
    if (cvRequest?.kind === "default") {
      await requestDefaultCv(ctx, cvRequest.language);
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
    if (FORGET_CONNECTIONS.some((pattern) => pattern.test(ctx.message.text))) {
      const deleted = await services.connections.forget(ctx.userId);
      await ctx.reply(deleted ? ctx.t.messages.connectionsDeleted : ctx.t.messages.connectionsNone, {
        ...html,
        reply_markup: mainMenu(ctx.t),
      });
      return;
    }
    const siteRequest = siteRequestFrom(ctx.message.text);
    if (siteRequest && ctx.hasProfile) {
      await addSite(ctx, siteRequest);
      return;
    }
    if (SOURCES_REQUEST.test(ctx.message.text)) {
      await showSources(ctx);
      return;
    }
    if (await services.feedback.takeReasonText(ctx.userId, ctx.message.text)) {
      await ctx.reply(ctx.t.messages.feedbackReasonTextSaved, { ...html, reply_markup: mainMenu(ctx.t) });
      return;
    }
    const links = ctx.hasProfile ? jobLinksFromText(ctx.message.text) : [];
    if (links.length > 0) {
      for (const link of links) await analyzeJobLink(ctx, link, links.length > 1);
      return;
    }
    await typing(ctx);
    await sendReplies(ctx, await services.conversation.handleText(ctx.userId, ctx.message.text, locale(ctx)));
  });

  bot.catch(async (err) => {
    console.error("bot update failed", { updateId: err.ctx.update.update_id, error: err.error });
    await err.ctx.reply(strings(err.ctx.language).messages.error).catch(() => undefined);
  });

  return bot;
}

/** Telegram shows these by the client's language; a user's own choice is set per chat when they switch. */
export async function registerCommands(api: Api): Promise<void> {
  await api.setMyCommands(botCommands(strings(DEFAULT_LANGUAGE)));
  for (const language of CONVERSATION_LANGUAGES) {
    if (language !== DEFAULT_LANGUAGE) await api.setMyCommands(botCommands(strings(language)), { language_code: language });
  }
}
