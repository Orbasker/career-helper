import { InlineKeyboard, Keyboard } from "grammy";
import { formatMonth } from "../domain/dates.js";
import {
  CONVERSATION_LANGUAGES,
  CV_FILE_FORMATS,
  type ConversationLanguage,
  type CvFileFormat,
  type DocumentFormat,
  type PreferenceKind,
} from "../domain/enums.js";
import { DEFAULT_LANGUAGE, LANGUAGE_NAMES } from "../domain/language.js";
import type { Strings } from "../i18n/index.js";
import type {
  AddSiteOutcome,
  ConnectionImport,
  JobLinkOutcome,
  ConnectionSummary,
  CvDraftView,
  DocumentName,
  JobProvenance,
  JobSiteView,
  MatchDetails,
  MatchSummary,
  PreferenceProposalView,
  ProfileReply,
  ProfileView,
  SourceCoverage,
  SourceDocumentView,
  SourceIssue,
  SourcesOverview,
} from "../app/services.js";
import { FEEDBACK_REASON_TAGS } from "../learning/infer.js";
import { encodeCallback } from "./callbacks.js";

const DESCRIPTION_PREVIEW_LENGTH = 1200;
const MAX_MESSAGE_LENGTH = 3800;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const DOCUMENT_BUTTON_NAME_LENGTH = 40;

export const mainMenu = (t: Strings) => new Keyboard().text(t.menu.whatsNew).text(t.menu.myProfile).resized().persistent();

/** Asked before a language is known, so it speaks every supported language. */
export const ASK_LANGUAGE = "👋 Hi! Which language should I use with you?\nשלום! באיזו שפה נדבר?";

export function botCommands(t: Strings) {
  return (["new", "profile", "cvs", "sources", "sites", "connections", "connect_gmail", "language", "start", "help"] as const).map((command) => ({
    command,
    description: t.commands[command],
  }));
}

type JobLinkFailure = Exclude<JobLinkOutcome["kind"], "evaluated" | "fails_must_have">;

const linkHost = (link: string) => escapeHtml(new URL(link).hostname.replace(/^www\./, ""));

export function jobLinkReadingText(t: Strings, link: string, several: boolean): string {
  return several ? t.jobLinks.readingOneOf(linkHost(link)) : t.jobLinks.reading;
}

/** Why a link could not be evaluated; `link` names it when the user sent several. */
export function jobLinkFailureText(t: Strings, outcome: { kind: JobLinkFailure }, link: string | null): string {
  const text = outcome.kind === "not_onboarded" ? t.messages.notOnboarded : t.jobLinks.failures[outcome.kind];
  return link ? `<b>${linkHost(link)}</b>: ${text}` : text;
}

export function jobLinkResultView(
  t: Strings,
  outcome: Extract<JobLinkOutcome, { kind: "evaluated" | "fails_must_have" }>,
  match: MatchDetails,
): View {
  const intro = outcome.kind === "fails_must_have" ? t.jobLinks.failsMustHave : outcome.known ? t.jobLinks.known : t.jobLinks.fits;
  const view = matchDetailsView(t, match);
  const sections = [intro, view.text];
  if (match.company && !match.connectionsImportedAt) sections.push(t.jobLinks.connectionsTip(escapeHtml(match.company)));
  return { text: sections.join("\n\n"), keyboard: view.keyboard };
}

export function employerNote(t: Strings, match: Pick<MatchSummary, "employerRelation">): string | null {
  const relation = match.employerRelation;
  if (!relation) return null;
  const employer = escapeHtml(relation.employer);
  return relation.kind === "current" ? t.match.currentEmployer(employer) : t.match.formerEmployer(employer);
}

export function connectionsNote(t: Strings, match: Pick<MatchSummary, "connectionCount" | "company">): string | null {
  if (match.connectionCount === 0 || !match.company) return null;
  return t.match.connections(match.connectionCount, escapeHtml(match.company));
}

const STALE_CONNECTIONS_MS = 90 * 86_400_000;

function contactsSection(t: Strings, match: MatchDetails, now = new Date()): string | null {
  if (match.contacts.length === 0 || !match.company) return null;
  const lines = match.contacts.map((c) => {
    const name = c.profileUrl ? `<a href="${escapeHtml(c.profileUrl)}">${escapeHtml(c.fullName)}</a>` : escapeHtml(c.fullName);
    return `• ${name}${c.position ? ` — ${escapeHtml(c.position)}` : ""}`;
  });
  const more = match.connectionCount - match.contacts.length;
  if (more > 0) lines.push(t.match.contactsMore(more));
  const imported = match.connectionsImportedAt;
  if (imported && now.getTime() - imported.getTime() > STALE_CONNECTIONS_MS) {
    lines.push(t.match.contactsStale(imported.toISOString().slice(0, 7)));
  }
  return `${t.match.contactsHeading(escapeHtml(match.company))}\n${lines.join("\n")}`;
}

export function matchListItem(t: Strings, match: MatchSummary): { text: string; keyboard: InlineKeyboard } {
  const lines = [`<b>${escapeHtml(match.title)}</b>`];
  const meta = [match.company, match.location].filter((v): v is string => Boolean(v)).map(escapeHtml);
  if (meta.length > 0) lines.push(meta.join(" · "));
  const note = employerNote(t, match);
  if (note) lines.push(note);
  const people = connectionsNote(t, match);
  if (people) lines.push(people);
  if (match.recommendation) lines.push(`<i>${t.recommendations[match.recommendation]}</i>`);
  if (match.explanation) lines.push(escapeHtml(match.explanation));
  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard().text(t.buttons.details, encodeCallback({ type: "job_details", matchId: match.matchId })),
  };
}

const DIGEST_BUTTON_TITLE_LENGTH = 40;
const DIGEST_EXPLANATION_LENGTH = 300;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function digestView(t: Strings, matches: MatchSummary[], remaining: number): { text: string; keyboard: InlineKeyboard } {
  const items = matches.map((match, i) => {
    const meta = [match.company, match.location].filter((v): v is string => Boolean(v)).map(escapeHtml);
    const lines = [`${i + 1}. <b>${escapeHtml(match.title)}</b>${meta.length > 0 ? ` — ${meta.join(" · ")}` : ""}`];
    const note = employerNote(t, match);
    if (note) lines.push(note);
    const people = connectionsNote(t, match);
    if (people) lines.push(people);
    if (match.recommendation) lines.push(`<i>${t.recommendations[match.recommendation]}</i>`);
    if (match.explanation) lines.push(escapeHtml(clip(match.explanation, DIGEST_EXPLANATION_LENGTH)));
    return lines.join("\n");
  });
  const outro = remaining > 0 ? [t.digest.more(remaining, t.menu.whatsNew)] : [];

  const keyboard = new InlineKeyboard();
  matches.forEach((match, i) => {
    const label = `${i + 1}. ${clip(match.title, DIGEST_BUTTON_TITLE_LENGTH)}`;
    keyboard.text(label, encodeCallback({ type: "job_details", matchId: match.matchId })).row();
  });
  return { text: [t.digest.heading(matches.length), ...items, ...outro].join("\n\n"), keyboard };
}

export function matchDetailsView(t: Strings, match: MatchDetails): { text: string; keyboard: InlineKeyboard } {
  const { text: header } = matchListItem(t, match);
  const sections = [header];
  const bulletSection = (title: string, items: string[]) => {
    if (items.length > 0) sections.push(`<b>${title}</b>\n${bullets(items)}`);
  };
  bulletSection(t.match.whyItFits, match.fitEvidence);
  bulletSection(t.match.transferableSkills, match.transferableSkills);
  bulletSection(t.match.gaps, match.gaps);
  const people = contactsSection(t, match);
  if (people) sections.push(people);

  const description =
    match.description.length > DESCRIPTION_PREVIEW_LENGTH
      ? `${match.description.slice(0, DESCRIPTION_PREVIEW_LENGTH)}…`
      : match.description;
  sections.push(escapeHtml(description));
  sections.push(provenanceSection(t, match.sourceUrl, match.provenance));

  const { matchId } = match;
  const keyboard = new InlineKeyboard()
    .text(
      match.feedback === "interested" ? t.buttons.interestedChosen : t.buttons.interested,
      encodeCallback({ type: "feedback", matchId, verdict: "interested" }),
    )
    .text(
      match.feedback === "not_interested" ? t.buttons.notInterestedChosen : t.buttons.notInterested,
      encodeCallback({ type: "feedback", matchId, verdict: "not_interested" }),
    )
    .row()
    .text(t.buttons.tailorCv, encodeCallback({ type: "tailor_cv", matchId }))
    .url(t.buttons.originalPosting, match.sourceUrl);
  return { text: sections.join("\n\n"), keyboard };
}

const shortSourceName = (name: string) => name.replace(/\s+job boards?$/i, "");
const isoDay = (date: Date) => date.toISOString().slice(0, 10);

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function provenanceSection(t: Strings, sourceUrl: string, provenance: JobProvenance): string {
  const origin =
    provenance.origin === "board"
      ? t.provenance.board(escapeHtml(shortSourceName(provenance.sourceName)))
      : t.provenance[provenance.origin];
  const lines = [
    t.provenance.heading,
    t.provenance.firstSeen(origin, isoDay(provenance.firstCollectedAt)),
    `<a href="${escapeHtml(sourceUrl)}">${t.match.openPosting}</a>`,
  ];
  if (provenance.otherUrls.length > 0) {
    const links = provenance.otherUrls.map((url) => `<a href="${escapeHtml(url)}">${escapeHtml(hostname(url))}</a>`);
    lines.push(t.provenance.alsoPostedOn(links.join(", ")));
  }
  return lines.join("\n");
}

/** "5 min ago", "3h ago", "2 days ago". */
export function timeAgo(t: Strings, date: Date, now = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60_000));
  if (minutes < 60) return minutes <= 1 ? t.timeAgo.justNow : t.timeAgo.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.timeAgo.hours(hours);
  const days = Math.floor(hours / 24);
  return days === 1 ? t.timeAgo.yesterday : t.timeAgo.days(days);
}

function issueLine(t: Strings, issue: SourceIssue): string {
  switch (issue.kind) {
    case "turned_off":
      return t.jobSources.turnedOff(escapeHtml(issue.source));
    case "unreachable_boards": {
      const shown = issue.boards.slice(0, 5).map(escapeHtml).join(", ");
      const more = issue.boards.length > 5 ? t.jobSources.andMore(issue.boards.length - 5) : "";
      return t.jobSources.unreachableBoards(escapeHtml(shortSourceName(issue.source)), issue.boards.length, `${shown}${more}`);
    }
    case "collection_failed":
      return t.jobSources.collectionFailed(escapeHtml(issue.source));
    case "search_failed":
      return t.jobSources.searchFailed;
    case "user_search_failed":
      return t.jobSources.userSearchFailed;
  }
}

export function sourcesView(t: Strings, overview: SourcesOverview, now = new Date()): View {
  const s = t.jobSources;
  const coverage = (c: SourceCoverage) => s.coverage(overview.coverageDays, c.jobs, c.newCompanies);
  const active = overview.boardSources.filter((source) => source.enabled && source.boards.length > 0);
  const boardCount = active.reduce((sum, source) => sum + source.boards.length, 0);
  const collected = active.flatMap((source) => (source.lastCollectedAt ? [source.lastCollectedAt] : []));
  const lastCollected = collected.length ? new Date(Math.max(...collected.map((d) => d.getTime()))) : null;
  const perSource = active.map((source) => `${escapeHtml(shortSourceName(source.name))} ${source.boards.length}`).join(", ");
  const boardLines = [
    s.boardsHeading,
    boardCount > 0 ? s.boards(boardCount, perSource, lastCollected ? timeAgo(t, lastCollected, now) : null) : s.noBoards,
    coverage(overview.boardCoverage),
  ];

  const web = overview.webSearch;
  const webLines = [
    s.webHeading,
    s.web(web.enabled, web.lastSearchedAt ? timeAgo(t, web.lastSearchedAt, now) : null),
    coverage(web.coverage),
  ];

  const siteLines = [s.sitesHeading];
  if (overview.sites.length === 0) siteLines.push(s.noSites);
  else {
    siteLines.push(s.sites(overview.sites.map((site) => escapeHtml(site.domain)).join(", ")));
    siteLines.push(coverage(overview.siteCoverage));
  }

  const sections = [s.title, boardLines.join("\n"), webLines.join("\n"), siteLines.join("\n")];
  if (overview.issues.length > 0) sections.push(`${s.problems}\n${overview.issues.map((i) => `• ${issueLine(t, i)}`).join("\n")}`);
  sections.push(s.detailsHint);

  const keyboard = new InlineKeyboard();
  if (boardCount > 0) keyboard.text(t.buttons.showBoards, encodeCallback({ type: "sources_boards" }));
  keyboard.text(overview.sites.length > 0 ? t.buttons.manageSites : t.buttons.addSite, encodeCallback({ type: "sources_sites" }));
  return { text: sections.join("\n\n"), keyboard };
}

const MAX_BOARDS_LISTED = 60;

export function boardsViews(t: Strings, overview: SourcesOverview): View[] {
  const sections = overview.boardSources
    .filter((s) => s.boards.length > 0)
    .map((s) => {
      const shown = s.boards.slice(0, MAX_BOARDS_LISTED).map(escapeHtml).join(", ");
      const more = s.boards.length > MAX_BOARDS_LISTED ? t.jobSources.andMore(s.boards.length - MAX_BOARDS_LISTED) : "";
      const off = s.enabled ? "" : t.jobSources.boardsTurnedOff;
      return `<b>${escapeHtml(s.name)}</b> (${s.boards.length}${off})\n${shown}${more}`;
    });
  if (sections.length === 0) return [{ text: t.jobSources.noBoardsChecked }];
  return packMessages([t.jobSources.boardsListHeading, ...sections]).map((text) => ({ text }));
}

export function feedbackReasonView(t: Strings, feedbackId: string): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard();
  FEEDBACK_REASON_TAGS.forEach((tag, i) => {
    keyboard.text(t.feedbackReasons[tag], encodeCallback({ type: "feedback_reason", feedbackId, tag }));
    if (i % 2 === 1) keyboard.row();
  });
  keyboard.text(t.buttons.somethingElse, encodeCallback({ type: "feedback_reason_text", feedbackId }));
  return { text: t.messages.feedbackReasonPrompt, keyboard };
}

export function proposalView(t: Strings, proposal: PreferenceProposalView): { text: string; keyboard: InlineKeyboard } {
  const label = `<b>${escapeHtml(proposal.label)}</b>`;
  const question =
    proposal.kind === "dislike"
      ? t.proposal.dislike(label)
      : proposal.kind === "hard_constraint"
        ? t.proposal.mustHave(label)
        : t.proposal.add(label, t.profile.preferenceSections[proposal.kind]);
  const { preferenceId } = proposal;
  return {
    text: `💡 ${escapeHtml(proposal.rationale)}\n${question}`,
    keyboard: new InlineKeyboard()
      .text(t.buttons.yes, encodeCallback({ type: "proposal_decision", preferenceId, accept: true }))
      .text(t.buttons.no, encodeCallback({ type: "proposal_decision", preferenceId, accept: false })),
  };
}

const period = (t: Strings, e: { startDate: string | null; endDate: string | null; isCurrent: boolean }) =>
  `${formatMonth(e.startDate) ?? "?"} – ${e.isCurrent ? t.profile.present : (formatMonth(e.endDate) ?? "?")}`;

const otherLanguage = (language: ConversationLanguage) => CONVERSATION_LANGUAGES.find((l) => l !== language)!;

export function cvDraftViews(t: Strings, draft: CvDraftView): View[] {
  const reason = draft.languageSource ? t.cv.languageReasons[draft.languageSource] : null;
  const sections = [
    `${t.cv.title(escapeHtml(draft.jobTitle), draft.company ? escapeHtml(draft.company) : null)}\n${t.cv.language(t.documentLanguages[draft.language], reason)}`,
  ];
  if (draft.summary.length) sections.push(`<b>${t.cv.summary}</b>\n${escapeHtml(draft.summary.join(" "))}`);
  for (const e of draft.experiences) {
    const lines = [`<b>${escapeHtml(e.title)}</b> — ${escapeHtml(e.employer)}`, `<i>${period(t, e)}</i>`];
    if (e.bullets.length) lines.push(bullets(e.bullets));
    sections.push(lines.join("\n"));
  }
  if (draft.skills.length) sections.push(`<b>${t.cv.skills}</b>\n${escapeHtml(draft.skills.join(" · "))}`);
  const list: [string, string[]][] = [
    [t.cv.education, draft.education],
    [t.cv.certifications, draft.certifications],
    [t.cv.languages, draft.languages],
    [t.cv.other, draft.other],
  ];
  for (const [title, items] of list) if (items.length) sections.push(`<b>${title}</b>\n${bullets(items)}`);
  if (draft.applicationNote) sections.push(`<b>${t.cv.applicationNote}</b>\n${escapeHtml(draft.applicationNote)}`);

  const { versionId } = draft;
  const language = otherLanguage(draft.language);
  return withFinalKeyboard(
    sections,
    t.messages.cvDraftOutro,
    new InlineKeyboard()
      .text(t.buttons.approve, encodeCallback({ type: "cv_decision", versionId, approve: true }))
      .text(t.buttons.discard, encodeCallback({ type: "cv_decision", versionId, approve: false }))
      .row()
      .text(t.buttons.cvInLanguage(t.documentLanguages[language]), encodeCallback({ type: "cv_language", versionId, language })),
  );
}

/** Offers the sent CV in its other file format and in the other language. */
export function cvDocumentKeyboard(
  t: Strings,
  versionId: string,
  sent: { format: CvFileFormat; language: ConversationLanguage },
): InlineKeyboard {
  const format = CV_FILE_FORMATS.find((f) => f !== sent.format)!;
  const language = otherLanguage(sent.language);
  return new InlineKeyboard()
    .text(format === "pdf" ? t.buttons.pdf : t.buttons.word, encodeCallback({ type: "cv_document", versionId, format }))
    .text(t.buttons.cvInLanguage(t.documentLanguages[language]), encodeCallback({ type: "cv_language", versionId, language }));
}

export function sitesView(t: Strings, sites: JobSiteView[]): { text: string; keyboard?: InlineKeyboard } {
  if (sites.length === 0) return { text: t.messages.noSites };
  const keyboard = new InlineKeyboard();
  for (const site of sites) keyboard.text(`✖️ ${site.domain}`, encodeCallback({ type: "site_remove", siteId: site.id })).row();
  const list = sites.map((s) => `• ${escapeHtml(s.domain)}`).join("\n");
  return { text: `${t.messages.sitesIntro}\n\n${list}\n\n${t.messages.sitesOutro}`, keyboard };
}

const documentLabel = (t: Strings, d: DocumentName) => d.label ?? d.fileName ?? (d.kind ? t.cvs.kinds[d.kind] : t.cvs.unnamed);

export const documentName = (t: Strings, d: DocumentName) => escapeHtml(documentLabel(t, d));

const formatName = (t: Strings, format: DocumentFormat) => (format === "other" ? t.cvs.otherFormat : format.toUpperCase());

const canBeDefault = (d: SourceDocumentView) => d.kind === "cv" && d.parseStatus === "parsed" && d.language !== null;

function documentFailure(t: Strings, d: SourceDocumentView): string | null {
  if (d.parseStatus === "parsed") return null;
  if (d.format === "doc") return t.cvs.failures.legacy;
  return d.parseStatus === "unsupported" ? t.cvs.failures.unsupported : t.cvs.failures.failed;
}

function documentSummary(t: Strings, d: SourceDocumentView): string[] {
  const meta = [d.kind ? t.cvs.kinds[d.kind] : t.cvs.unnamed];
  if (d.parseStatus === "parsed") {
    meta.push(
      d.language ? `${t.documentLanguages[d.language]}${d.languageConfirmed ? "" : ` (${t.cvs.detected})`}` : t.cvs.languageUnknown,
    );
  }
  meta.push(formatName(t, d.format));
  if (d.version && d.version > 1) meta.push(t.cvs.version(d.version));
  if (d.label && d.fileName) meta.push(escapeHtml(d.fileName));
  meta.push(t.cvs.added(isoDay(d.createdAt)));
  const lines = [meta.join(" · ")];
  if (d.isDefault && d.language) lines.push(t.cvs.defaultFor(t.documentLanguages[d.language]));
  const failure = documentFailure(t, d);
  if (failure) lines.push(failure);
  return lines;
}

const documentButton = (t: Strings, d: SourceDocumentView, prefix: string) =>
  `${prefix}${clip(documentLabel(t, d), DOCUMENT_BUTTON_NAME_LENGTH)}`;

export function cvLibraryViews(t: Strings, documents: SourceDocumentView[]): View[] {
  if (documents.length === 0) {
    return [{ text: t.cvs.empty, keyboard: new InlineKeyboard().text(t.buttons.addCv, encodeCallback({ type: "document_upload" })) }];
  }
  const items = documents.map((d, i) => [t.cvs.item(i + 1, documentName(t, d)), ...documentSummary(t, d)].join("\n"));
  const keyboard = new InlineKeyboard();
  documents.forEach((d, i) => {
    keyboard.text(documentButton(t, d, `${i + 1}. `), encodeCallback({ type: "document", documentId: d.id })).row();
  });
  keyboard.text(t.buttons.addCv, encodeCallback({ type: "document_upload" }));
  return withFinalKeyboard([t.cvs.title, ...items], t.cvs.outro, keyboard);
}

export function documentCardView(t: Strings, d: SourceDocumentView): View {
  const lines = [t.cvs.cardTitle(documentName(t, d)), ...documentSummary(t, d)];
  if (d.isDefault && d.language) lines.push(t.cvs.defaultExplained(t.documentLanguages[d.language]));
  if (d.parseStatus === "parsed") lines.push(t.cvs.facts(d.factCount));

  const documentId = d.id;
  const keyboard = new InlineKeyboard();
  if (canBeDefault(d) && !d.isDefault) {
    keyboard.text(t.buttons.makeDefault(t.documentLanguages[d.language!]), encodeCallback({ type: "document_action", documentId, action: "default" })).row();
  }
  if (d.parseStatus === "parsed") {
    for (const language of CONVERSATION_LANGUAGES.filter((l) => l !== d.language)) {
      keyboard.text(
        t.documents.languageButton(t.documentLanguages[language], d.language !== null),
        encodeCallback({ type: "document_language", documentId, language }),
      );
    }
    keyboard.row();
  }
  return {
    text: lines.join("\n"),
    keyboard: keyboard
      .text(t.buttons.rename, encodeCallback({ type: "document_action", documentId, action: "label" }))
      .text(t.buttons.replace, encodeCallback({ type: "document_action", documentId, action: "replace" }))
      .text(t.buttons.remove, encodeCallback({ type: "document_action", documentId, action: "remove" }))
      .row()
      .text(t.buttons.myCvs, encodeCallback({ type: "documents" })),
  };
}

export function removeDocumentView(t: Strings, d: SourceDocumentView): View {
  const documentId = d.id;
  return {
    text: t.cvs.removeConfirm(documentName(t, d), d.factCount),
    keyboard: new InlineKeyboard()
      .text(t.buttons.confirmRemove, encodeCallback({ type: "document_action", documentId, action: "confirm_remove" }))
      .text(t.buttons.keep, encodeCallback({ type: "document", documentId })),
  };
}

export function chooseDefaultView(t: Strings, language: ConversationLanguage | null, documents: SourceDocumentView[]): View {
  const keyboard = new InlineKeyboard();
  for (const d of documents) {
    const suffix = language ? "" : ` · ${t.documentLanguages[d.language!]}`;
    keyboard.text(`${documentButton(t, d, d.isDefault ? "⭐ " : "")}${suffix}`, encodeCallback({ type: "document_action", documentId: d.id, action: "default" })).row();
  }
  return { text: t.cvs.chooseDefault(language ? t.documentLanguages[language] : null), keyboard };
}

export function connectionsImportReply(t: Strings, outcome: ConnectionImport): string {
  switch (outcome.kind) {
    case "imported":
      return t.connections.imported(outcome.contacts, outcome.companies, outcome.skipped);
    case "empty":
      return t.messages.connectionsEmpty;
    case "not_connections":
      return t.messages.connectionsNotRecognized;
  }
}

export function connectionsView(t: Strings, summary: ConnectionSummary | null): { text: string; keyboard?: InlineKeyboard } {
  if (!summary) return { text: t.messages.connectionsHowTo };
  return {
    text: t.connections.summary(summary.contacts, summary.companies, summary.importedAt.toISOString().slice(0, 10)),
    keyboard: new InlineKeyboard().text(t.buttons.deleteConnections, encodeCallback({ type: "connections_delete" })),
  };
}

/** What connecting Gmail means, with a single-use sign-in button; for a lost grant, a reconnect prompt instead. */
export function gmailConnectView(t: Strings, url: string, reconnectEmail: string | null = null): View {
  return {
    text: reconnectEmail ? t.gmail.reconnect(escapeHtml(reconnectEmail)) : t.gmail.explain,
    keyboard: new InlineKeyboard().url(reconnectEmail ? t.buttons.reconnectGmail : t.buttons.connectGmail, url),
  };
}

export function gmailDisconnectView(t: Strings, email: string): View {
  return {
    text: t.gmail.disconnectConfirm(escapeHtml(email)),
    keyboard: new InlineKeyboard().text(t.buttons.disconnectGmail, encodeCallback({ type: "gmail_disconnect" })),
  };
}

export function addSiteReply(t: Strings, outcome: AddSiteOutcome): string {
  switch (outcome.kind) {
    case "added":
      return t.siteAdded(escapeHtml(outcome.site.domain));
    case "exists":
      return t.siteExists(escapeHtml(outcome.site.domain));
    case "board":
      return t.messages.siteBoard;
    case "invalid":
      return t.messages.siteInvalid;
    case "limit":
      return t.messages.siteLimit;
  }
}

export interface View {
  text: string;
  keyboard?: InlineKeyboard;
}

const bullets = (items: string[]) => items.map((i) => `• ${escapeHtml(i)}`).join("\n");

function profileSections(t: Strings, profile: ProfileView): string[] {
  const sections: string[] = [];
  const header: string[] = [];
  if (profile.headline) header.push(`<b>${escapeHtml(profile.headline)}</b>`);
  if (profile.summary) header.push(escapeHtml(profile.summary));
  if (profile.currentSeniority) header.push(t.profile.seniority(t.seniority[profile.currentSeniority]));
  if (profile.managementScope) header.push(t.profile.managementScope(escapeHtml(profile.managementScope)));
  header.push(t.profile.openToAdjacent(profile.openToAdjacentRoles));
  if (profile.linkedinUrl) header.push(t.profile.linkedin(escapeHtml(profile.linkedinUrl)));
  sections.push(header.join("\n"));

  if (profile.experiences.length > 0) sections.push(`<b>${t.profile.experience}</b>`);
  for (const e of profile.experiences) {
    const meta = [period(t, e), e.industry, e.location, e.managedHeadcount ? t.profile.managed(e.managedHeadcount) : null]
      .filter((v): v is string => Boolean(v))
      .map(escapeHtml)
      .join(" · ");
    const lines = [`<b>${escapeHtml(e.title)}</b> — ${escapeHtml(e.employer)}`, `<i>${meta}</i>`];
    if (e.facts.length > 0) lines.push(bullets(e.facts));
    sections.push(lines.join("\n"));
  }

  const factKinds = [...new Set(profile.otherFacts.map((f) => f.kind))];
  for (const kind of factKinds) {
    const items = profile.otherFacts.filter((f) => f.kind === kind).map((f) => f.statement);
    sections.push(`<b>${t.profile.factSections[kind]}</b>\n${bullets(items)}`);
  }

  const preferenceKinds = (Object.keys(t.profile.preferenceSections) as PreferenceKind[]).filter((k) =>
    profile.preferences.some((p) => p.kind === k),
  );
  for (const kind of preferenceKinds) {
    const items = profile.preferences.filter((p) => p.kind === kind).map((p) => p.label);
    sections.push(`<b>${t.profile.preferenceSections[kind]}</b>\n${bullets(items)}`);
  }
  return sections;
}

function packMessages(sections: string[]): string[] {
  const messages: string[] = [];
  let current = "";
  for (const section of sections) {
    const piece = section.length > MAX_MESSAGE_LENGTH ? `${section.slice(0, MAX_MESSAGE_LENGTH)}…` : section;
    if (current && current.length + piece.length + 2 > MAX_MESSAGE_LENGTH) {
      messages.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function withFinalKeyboard(sections: string[], outro: string, keyboard?: InlineKeyboard): View[] {
  const texts = packMessages([...sections, outro]);
  return texts.map((text, i) => (i === texts.length - 1 && keyboard ? { text, keyboard } : { text }));
}

export function languageKeyboard(current: ConversationLanguage | null = null): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const language of CONVERSATION_LANGUAGES) {
    const label = language === current ? `✅ ${LANGUAGE_NAMES[language]}` : LANGUAGE_NAMES[language];
    keyboard.text(label, encodeCallback({ type: "set_language", language }));
  }
  return keyboard;
}

export function languageSettingsView(t: Strings, current: ConversationLanguage | null): View {
  return {
    text: t.languageStatus(LANGUAGE_NAMES[current ?? DEFAULT_LANGUAGE], current !== null),
    keyboard: languageKeyboard(current),
  };
}

export const analyzeKeyboard = (t: Strings) =>
  new InlineKeyboard().text(t.buttons.analyze, encodeCallback({ type: "onboarding_analyze" }));

export function documentLanguageKeyboard(t: Strings, documentId: string, detected: ConversationLanguage | null): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const language of CONVERSATION_LANGUAGES.filter((l) => l !== detected)) {
    keyboard.text(
      t.documents.languageButton(t.documentLanguages[language], detected !== null),
      encodeCallback({ type: "document_language", documentId, language }),
    );
  }
  return keyboard;
}

export function profileReplyViews(t: Strings, reply: ProfileReply): View[] {
  const m = t.messages;
  switch (reply.kind) {
    case "ask_language":
      return [{ text: ASK_LANGUAGE, keyboard: languageKeyboard() }];
    case "language_saved":
      return [{ text: m.languageSaved }];
    case "onboarding_welcome":
      return [{ text: m.welcomeNew }];
    case "ask_linkedin":
      return [{ text: m.askLinkedin }];
    case "ask_documents":
      return [{ text: `${reply.linkedinSaved ? m.linkedinSaved : m.linkedinSkipped}\n\n${m.askDocuments}` }];
    case "source_received": {
      const fileName = reply.fileName ? escapeHtml(reply.fileName) : null;
      const language = reply.language ? t.documentLanguages[reply.language] : null;
      const text = t.onboarding.sourceReceived(t.sources[reply.source], fileName, language);
      return [
        {
          text: reply.languageCertain ? text : `${text}\n\n${t.cvs.askLanguage}`,
          keyboard: reply.documentId
            ? documentLanguageKeyboard(t, reply.documentId, reply.languageCertain ? reply.language : null)
                .row()
                .text(t.buttons.analyze, encodeCallback({ type: "onboarding_analyze" }))
            : analyzeKeyboard(t),
        },
      ];
    }
    case "document_saved": {
      const fileName = reply.fileName ? escapeHtml(reply.fileName) : null;
      const language = reply.language ? t.documentLanguages[reply.language] : null;
      const source = t.sources[reply.source];
      const text = reply.replaced
        ? t.documents.replaced(source, fileName, language, documentName(t, reply.replaced))
        : t.documents.saved(source, fileName, language, reply.version);
      return [
        {
          text: reply.languageCertain ? text : `${text}\n\n${t.cvs.askLanguage}`,
          keyboard: documentLanguageKeyboard(t, reply.documentId, reply.languageCertain ? reply.language : null)
            .row()
            .text(t.buttons.myCvs, encodeCallback({ type: "documents" })),
        },
      ];
    }
    case "document_nothing_new":
      return [{ text: m.documentNothingNew }];
    case "document_merge_failed":
      return [{ text: m.documentMergeFailed }];
    case "unreadable_document":
      return [{ text: m.unreadableDocument }];
    case "legacy_doc":
      return [{ text: m.legacyDoc }];
    case "need_source":
      return [{ text: m.needSource }];
    case "analysis_failed":
      return [{ text: m.analysisFailed, keyboard: analyzeKeyboard(t) }];
    case "busy":
      return [{ text: m.busy }];
    case "question":
      return [{ text: t.onboarding.question(reply.position, reply.total, escapeHtml(reply.text)) }];
    case "review":
      return withFinalKeyboard(
        [reply.note ? m.reviewUpdated : m.reviewIntro, ...profileSections(t, reply.profile)],
        m.reviewOutro,
        new InlineKeyboard().text(t.buttons.confirmProfile, encodeCallback({ type: "onboarding_confirm" })),
      );
    case "onboarding_done":
      return [{ text: m.onboardingDone }];
    case "profile":
      return withFinalKeyboard(profileSections(t, reply.profile), m.profileOutro);
    case "edit_proposed":
      return withFinalKeyboard(
        [m.editProposed, reply.changes.map(escapeHtml).join("\n")],
        m.editConfirm,
        new InlineKeyboard()
          .text(t.buttons.apply, encodeCallback({ type: "edit_apply", token: reply.token }))
          .text(t.buttons.cancel, encodeCallback({ type: "edit_cancel", token: reply.token })),
      );
    case "edit_applied":
      return [{ text: m.editApplied }];
    case "edit_cancelled":
      return [{ text: m.editCancelled }];
    case "expired":
      return [{ text: m.expired }];
    case "no_change":
      return [{ text: reply.reply ? escapeHtml(reply.reply) : m.noChange }];
    case "not_onboarded":
      return [{ text: m.notOnboarded }];
    case "document_not_expected":
      return [{ text: m.documentNotExpected }];
  }
}
