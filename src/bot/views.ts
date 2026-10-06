import { InlineKeyboard, Keyboard } from "grammy";
import { formatMonth } from "../domain/dates.js";
import type { CareerFactKind, MatchRecommendation, PreferenceKind, ProfileSourceKind } from "../domain/enums.js";
import type {
  AddSiteOutcome,
  ConnectionImport,
  ConnectionSummary,
  CvDraftView,
  JobSiteView,
  MatchDetails,
  MatchSummary,
  PreferenceProposalView,
  ProfileReply,
  ProfileView,
} from "../app/services.js";
import type { FeedbackReasonTag } from "../learning/infer.js";
import { encodeCallback } from "./callbacks.js";

export const WHATS_NEW_LABEL = "What's new?";
export const MY_PROFILE_LABEL = "👤 My profile";
const DESCRIPTION_PREVIEW_LENGTH = 1200;
const MAX_MESSAGE_LENGTH = 3800;

const RECOMMENDATION_LABELS: Record<MatchRecommendation, string> = {
  strong_fit: "Strong fit",
  good_fit: "Good fit",
  stretch: "Stretch",
  not_recommended: "Not recommended",
};

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const mainMenu = new Keyboard().text(WHATS_NEW_LABEL).text(MY_PROFILE_LABEL).resized().persistent();

export const messages = {
  welcomeBack: "Welcome back! Tap <b>What's new?</b> for your latest matches, or just tell me what you'd like to change in your preferences.",
  welcomeNew: "Hi! I'm your career agent. I'll find jobs that fit your experience — including adjacent roles — and help tailor your CV. Let's build your career profile first.",
  askLinkedin: "First, send me your <b>LinkedIn profile URL</b> (e.g. linkedin.com/in/your-name), or reply <i>skip</i>.",
  askDocuments: [
    "Now send me your <b>CV / resume</b> (PDF, DOCX or TXT).",
    "",
    "LinkedIn doesn't let me read profiles directly. To import yours too, open your LinkedIn profile → <b>More</b> → <b>Save to PDF</b> and send me that file.",
    "",
    "No documents? Just paste or type a summary of your work history. Tap <b>Analyze</b> when you've sent everything.",
  ].join("\n"),
  linkedinSaved: "Saved your LinkedIn URL ✅",
  linkedinSkipped: "No LinkedIn URL saved — you can add it later.",
  documentTooLarge: "That file is too large (max 10 MB). Please send a smaller PDF, DOCX or TXT file.",
  unreadableDocument: "I couldn't read text from that file. Please send a PDF, DOCX or TXT file (not a scanned image), or paste the text.",
  needSource: "I need at least one CV, LinkedIn PDF or a short written summary of your experience before I can analyze it.",
  analyzing: "Reading your documents and building your profile… this can take a minute.",
  analysisFailed: "Sorry, I couldn't analyze your documents this time. Tap <b>Analyze</b> to try again, or send more details.",
  busy: "I'm still working on your profile — I'll message you when it's ready. If nothing arrives in a few minutes, send /start to begin again.",
  reviewIntro: "<b>Here's what I extracted.</b> Please check it carefully — nothing is saved as fact until you confirm.",
  reviewUpdated: "<b>Updated.</b> Here's your profile now:",
  reviewOutro: "Reply with any corrections in your own words (e.g. <i>\"I left Acme in 2023\"</i>, <i>\"remove the Python skill\"</i>, <i>\"I managed 8 people there\"</i>), or tap <b>Confirm profile</b>.",
  onboardingDone: "Your profile is confirmed ✅ I'll start looking for matches and let you know when something fits.\n\nYou can update your profile anytime — just tell me, e.g. <i>\"I'm no longer interested in recruiting roles\"</i> or <i>\"add that I managed the payroll migration\"</i>.",
  profileOutro: "To change anything, just tell me in your own words.",
  editProposed: "<b>I'll make these changes to your profile:</b>",
  editApplied: "Done — your profile is updated ✅",
  editCancelled: "OK, nothing changed.",
  expired: "That action is no longer available.",
  noChange: "I didn't find anything to change in your profile. Tell me what to add, correct or remove — e.g. <i>\"add that I managed a team of 5\"</i>.",
  notOnboarded: "Let's set up your career profile first — send /start.",
  documentNotExpected: "I only import documents while building your profile. To change your profile, just tell me what to add or correct.",
  noMatches: "No new matches right now. I'll message you when something relevant shows up.",
  matchNotFound: "I couldn't find that job anymore.",
  feedbackInterested: "Marked as interested 👍",
  feedbackNotInterested: "Got it, I'll show fewer jobs like this.",
  feedbackReasonPrompt: "What put you off? It's optional, but it helps me learn what to skip.",
  feedbackReasonNoted: "Noted, thanks.",
  feedbackReasonTextPrompt: "Tell me in one message what put you off.",
  feedbackReasonTextSaved: "Thanks, that helps.",
  proposalAccepted: "Done ✅ I'll use this for new matches.",
  proposalRejected: "OK, I won't use that.",
  cvRequested: "I'm preparing a tailored CV for this job. It takes about a minute; I'll send it here for your review.",
  cvInProgress: "A tailored CV for this job is already being prepared.",
  cvFailed: "Sorry, I couldn't prepare the CV this time. Tap <b>Tailor my CV</b> again to retry.",
  cvDraftOutro:
    "Every line comes from your confirmed profile: I only chose, ordered and reworded it for this job. Approve to keep this version, or discard it.",
  cvApproved: "Saved ✅ Here's your CV for this job as a Word document.",
  cvDocumentCaption: "Your tailored CV. Every line comes from your confirmed profile.",
  cvDocumentFailed: "Your CV is saved, but I couldn't create the document right now. Tap below to try again.",
  cvDiscarded: "Discarded. Tap <b>Tailor my CV</b> on the job to start over.",
  help: [
    "<b>What I can do</b>",
    "• /new — your latest matches",
    "• /profile — your career profile",
    "• /sites — job sites I search for you (add one with /addsite example.co.il)",
    "• /connections — import your LinkedIn connections to see who you know at each company",
    "• /start — set up your profile",
    "• Tell me anything to update your profile (e.g. \"no more than 40 minutes commute\", \"add that I managed X\").",
  ].join("\n"),
  error: "Something went wrong on my side. Please try again in a moment.",
  connectionsHowTo: [
    "<b>Import your LinkedIn connections</b>",
    "I'll show you who you know at each company I match you with.",
    "",
    "1. On LinkedIn open <b>Settings → Data privacy → Get a copy of your data</b>.",
    "2. Choose <b>Connections</b> and request the archive. LinkedIn emails it within minutes.",
    "3. Send me <b>Connections.csv</b> (or the whole ZIP) here.",
    "",
    "I only use your contacts to show them on your own matches. You can delete them any time.",
  ].join("\n"),
  connectionsNotRecognized: "That file doesn't look like a LinkedIn connections export. Send <b>Connections.csv</b> or the export ZIP — see /connections.",
  connectionsEmpty: "I couldn't find any contacts in that file. Send /connections for how to export them.",
  connectionsDeleted: "Deleted your contacts. Send a new export any time with /connections.",
  connectionsNone: "You have no imported contacts.",
  noSites:
    "Besides the company job boards I check every day, I search the web for jobs that fit your profile.\n\nAdd your favourite job sites and I'll search them too: send <b>/addsite</b> followed by the site, e.g. <i>/addsite example.co.il</i>.",
  sitesIntro: "<b>Job sites I search for you</b>\nI also search the open web and the company job boards I check every day.",
  sitesOutro: "Add another with <b>/addsite</b> followed by the site. Tap a site to remove it.",
  siteUsage: "Send <b>/addsite</b> followed by the site, e.g. <i>/addsite example.co.il</i>.",
  siteInvalid: "That doesn't look like a website. Send something like <i>/addsite example.co.il</i>.",
  siteLimit: "You already have 20 sites, the most I can search. Remove one with /sites first.",
  siteRemoved: "Removed. I won't search that site anymore.",
};

export function employerNote(match: Pick<MatchSummary, "employerRelation">): string | null {
  const relation = match.employerRelation;
  if (!relation) return null;
  const employer = escapeHtml(relation.employer);
  return relation.kind === "current"
    ? `🏢 <b>Internal opportunity at ${employer}</b>, where you work today. Internal moves are often easier: you already know the product and the people, so ask your manager or HR about it.`
    : `↩️ <b>You worked at ${employer} before.</b> That's an advantage: mention it, and reach out to former colleagues there.`;
}

export function connectionsNote(match: Pick<MatchSummary, "connectionCount" | "company">): string | null {
  if (match.connectionCount === 0 || !match.company) return null;
  const people = match.connectionCount === 1 ? "1 connection" : `${match.connectionCount} connections`;
  return `👥 ${people} at ${escapeHtml(match.company)}`;
}

const STALE_CONNECTIONS_MS = 90 * 86_400_000;

function contactsSection(match: MatchDetails, now = new Date()): string | null {
  if (match.contacts.length === 0 || !match.company) return null;
  const lines = match.contacts.map((c) => {
    const name = c.profileUrl ? `<a href="${escapeHtml(c.profileUrl)}">${escapeHtml(c.fullName)}</a>` : escapeHtml(c.fullName);
    return `• ${name}${c.position ? ` — ${escapeHtml(c.position)}` : ""}`;
  });
  const more = match.connectionCount - match.contacts.length;
  if (more > 0) lines.push(`<i>and ${more} more</i>`);
  const imported = match.connectionsImportedAt;
  if (imported && now.getTime() - imported.getTime() > STALE_CONNECTIONS_MS) {
    lines.push(`<i>From your LinkedIn export of ${imported.toISOString().slice(0, 7)}. Send /connections to refresh it.</i>`);
  }
  return `<b>People you know at ${escapeHtml(match.company)}</b>\n${lines.join("\n")}`;
}

export function matchListItem(match: MatchSummary): { text: string; keyboard: InlineKeyboard } {
  const lines = [`<b>${escapeHtml(match.title)}</b>`];
  const meta = [match.company, match.location].filter((v): v is string => Boolean(v)).map(escapeHtml);
  if (meta.length > 0) lines.push(meta.join(" · "));
  const note = employerNote(match);
  if (note) lines.push(note);
  const people = connectionsNote(match);
  if (people) lines.push(people);
  if (match.recommendation) lines.push(`<i>${RECOMMENDATION_LABELS[match.recommendation]}</i>`);
  if (match.explanation) lines.push(escapeHtml(match.explanation));
  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard().text("Details", encodeCallback({ type: "job_details", matchId: match.matchId })),
  };
}

const DIGEST_BUTTON_TITLE_LENGTH = 40;
const DIGEST_EXPLANATION_LENGTH = 300;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function digestView(matches: MatchSummary[], remaining: number): { text: string; keyboard: InlineKeyboard } {
  const heading = matches.length === 1 ? "<b>1 new job match for you</b>" : `<b>${matches.length} new job matches for you</b>`;
  const items = matches.map((match, i) => {
    const meta = [match.company, match.location].filter((v): v is string => Boolean(v)).map(escapeHtml);
    const lines = [`${i + 1}. <b>${escapeHtml(match.title)}</b>${meta.length > 0 ? ` — ${meta.join(" · ")}` : ""}`];
    const note = employerNote(match);
    if (note) lines.push(note);
    const people = connectionsNote(match);
    if (people) lines.push(people);
    if (match.recommendation) lines.push(`<i>${RECOMMENDATION_LABELS[match.recommendation]}</i>`);
    if (match.explanation) lines.push(escapeHtml(clip(match.explanation, DIGEST_EXPLANATION_LENGTH)));
    return lines.join("\n");
  });
  const outro = remaining > 0 ? [`<i>+${remaining} more — tap <b>${WHATS_NEW_LABEL}</b> to see them.</i>`] : [];

  const keyboard = new InlineKeyboard();
  matches.forEach((match, i) => {
    const label = `${i + 1}. ${clip(match.title, DIGEST_BUTTON_TITLE_LENGTH)}`;
    keyboard.text(label, encodeCallback({ type: "job_details", matchId: match.matchId })).row();
  });
  return { text: [heading, ...items, ...outro].join("\n\n"), keyboard };
}

export function matchDetailsView(match: MatchDetails): { text: string; keyboard: InlineKeyboard } {
  const { text: header } = matchListItem(match);
  const sections = [header];
  const bulletSection = (title: string, items: string[]) => {
    if (items.length > 0) sections.push(`<b>${title}</b>\n${items.map((i) => `• ${escapeHtml(i)}`).join("\n")}`);
  };
  bulletSection("Why it fits", match.fitEvidence);
  bulletSection("Transferable skills", match.transferableSkills);
  bulletSection("Gaps", match.gaps);
  const people = contactsSection(match);
  if (people) sections.push(people);

  const description =
    match.description.length > DESCRIPTION_PREVIEW_LENGTH
      ? `${match.description.slice(0, DESCRIPTION_PREVIEW_LENGTH)}…`
      : match.description;
  sections.push(escapeHtml(description));
  sections.push(`<a href="${escapeHtml(match.sourceUrl)}">Open original posting</a>`);

  const { matchId } = match;
  const keyboard = new InlineKeyboard()
    .text(match.feedback === "interested" ? "✅ Interested" : "👍 Interested", encodeCallback({ type: "feedback", matchId, verdict: "interested" }))
    .text(
      match.feedback === "not_interested" ? "✅ Not interested" : "👎 Not interested",
      encodeCallback({ type: "feedback", matchId, verdict: "not_interested" }),
    )
    .row()
    .text("📝 Tailor my CV", encodeCallback({ type: "tailor_cv", matchId }));
  return { text: sections.join("\n\n"), keyboard };
}

const REASON_LABELS: [FeedbackReasonTag, string][] = [
  ["role", "🧭 Not my kind of role"],
  ["seniority", "📶 Wrong level"],
  ["location", "📍 Location"],
  ["work_mode", "🏠 Remote / office setup"],
  ["company", "🏢 Company"],
  ["pay", "💰 Pay"],
];

export function feedbackReasonView(feedbackId: string): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard();
  REASON_LABELS.forEach(([tag, label], i) => {
    keyboard.text(label, encodeCallback({ type: "feedback_reason", feedbackId, tag }));
    if (i % 2 === 1) keyboard.row();
  });
  keyboard.text("✍️ Something else", encodeCallback({ type: "feedback_reason_text", feedbackId }));
  return { text: messages.feedbackReasonPrompt, keyboard };
}

export function proposalView(proposal: PreferenceProposalView): { text: string; keyboard: InlineKeyboard } {
  const label = `<b>${escapeHtml(proposal.label)}</b>`;
  const question =
    proposal.kind === "dislike"
      ? `Should I skip ${label} from now on?`
      : proposal.kind === "hard_constraint"
        ? `Should I make ${label} a must-have?`
        : `Should I add ${label} to your ${PREFERENCE_SECTION_TITLES[proposal.kind].toLowerCase()}?`;
  const { preferenceId } = proposal;
  return {
    text: `💡 ${escapeHtml(proposal.rationale)}\n${question}`,
    keyboard: new InlineKeyboard()
      .text("✅ Yes", encodeCallback({ type: "proposal_decision", preferenceId, accept: true }))
      .text("✖️ No", encodeCallback({ type: "proposal_decision", preferenceId, accept: false })),
  };
}

export function cvDraftViews(draft: CvDraftView): View[] {
  const at = draft.company ? ` at ${escapeHtml(draft.company)}` : "";
  const sections = [`<b>📝 Tailored CV for ${escapeHtml(draft.jobTitle)}${at}</b>`];
  if (draft.summary.length) sections.push(`<b>Summary</b>\n${escapeHtml(draft.summary.join(" "))}`);
  for (const e of draft.experiences) {
    const dates = `${formatMonth(e.startDate) ?? "?"} – ${e.isCurrent ? "present" : (formatMonth(e.endDate) ?? "?")}`;
    const lines = [`<b>${escapeHtml(e.title)}</b> — ${escapeHtml(e.employer)}`, `<i>${dates}</i>`];
    if (e.bullets.length) lines.push(bullets(e.bullets));
    sections.push(lines.join("\n"));
  }
  if (draft.skills.length) sections.push(`<b>Skills</b>\n${escapeHtml(draft.skills.join(" · "))}`);
  const list: [string, string[]][] = [
    ["Education", draft.education],
    ["Certifications", draft.certifications],
    ["Languages", draft.languages],
    ["Other", draft.other],
  ];
  for (const [title, items] of list) if (items.length) sections.push(`<b>${title}</b>\n${bullets(items)}`);
  if (draft.applicationNote) sections.push(`<b>Application note</b>\n${escapeHtml(draft.applicationNote)}`);

  const { versionId } = draft;
  return withFinalKeyboard(
    sections,
    messages.cvDraftOutro,
    new InlineKeyboard()
      .text("✅ Approve", encodeCallback({ type: "cv_decision", versionId, approve: true }))
      .text("🗑 Discard", encodeCallback({ type: "cv_decision", versionId, approve: false })),
  );
}

export function sitesView(sites: JobSiteView[]): { text: string; keyboard?: InlineKeyboard } {
  if (sites.length === 0) return { text: messages.noSites };
  const keyboard = new InlineKeyboard();
  for (const site of sites) keyboard.text(`✖️ ${site.domain}`, encodeCallback({ type: "site_remove", siteId: site.id })).row();
  const list = sites.map((s) => `• ${escapeHtml(s.domain)}`).join("\n");
  return { text: `${messages.sitesIntro}\n\n${list}\n\n${messages.sitesOutro}`, keyboard };
}

export function connectionsImportReply(outcome: ConnectionImport): string {
  switch (outcome.kind) {
    case "imported": {
      const skipped = outcome.skipped ? ` (${outcome.skipped} rows without a name were skipped)` : "";
      return `Imported ${outcome.contacts} contacts at ${outcome.companies} companies ✅${skipped}\nI'll show who you know when I match you with one of their companies.`;
    }
    case "empty":
      return messages.connectionsEmpty;
    case "not_connections":
      return messages.connectionsNotRecognized;
  }
}

export function connectionsView(summary: ConnectionSummary | null): { text: string; keyboard?: InlineKeyboard } {
  if (!summary) return { text: messages.connectionsHowTo };
  const date = summary.importedAt.toISOString().slice(0, 10);
  return {
    text: `<b>Your connections</b>\n${summary.contacts} contacts at ${summary.companies} companies, imported ${date}.\n\nSend a newer Connections.csv any time to replace them.`,
    keyboard: new InlineKeyboard().text("🗑 Delete my connections", encodeCallback({ type: "connections_delete" })),
  };
}

export function addSiteReply(outcome: AddSiteOutcome): string {
  switch (outcome.kind) {
    case "added":
      return `Added <b>${escapeHtml(outcome.site.domain)}</b> ✅ I'll search it for jobs that fit you in my next daily search.`;
    case "exists":
      return `I'm already searching <b>${escapeHtml(outcome.site.domain)}</b> for you.`;
    case "board":
      return "That's a company job board, so I added it to the boards I check every day ✅";
    case "invalid":
      return messages.siteInvalid;
    case "limit":
      return messages.siteLimit;
  }
}

const SOURCE_LABELS: Record<ProfileSourceKind, string> = {
  cv: "your CV",
  linkedin_export: "your LinkedIn export",
  pasted_text: "your notes",
};

const FACT_SECTION_TITLES: Record<CareerFactKind, string> = {
  skill: "Skills",
  education: "Education",
  certification: "Certifications",
  language: "Languages",
  responsibility: "Other experience",
  achievement: "Achievements",
  other: "Other",
};

const PREFERENCE_SECTION_TITLES: Record<PreferenceKind, string> = {
  target_role: "Target roles",
  hard_constraint: "Must-haves",
  soft_preference: "Nice-to-haves",
  dislike: "Avoid",
};

export interface View {
  text: string;
  keyboard?: InlineKeyboard;
}

const bullets = (items: string[]) => items.map((i) => `• ${escapeHtml(i)}`).join("\n");
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function profileSections(profile: ProfileView): string[] {
  const sections: string[] = [];
  const header: string[] = [];
  if (profile.headline) header.push(`<b>${escapeHtml(profile.headline)}</b>`);
  if (profile.summary) header.push(escapeHtml(profile.summary));
  if (profile.currentSeniority) header.push(`Seniority: ${capitalize(profile.currentSeniority)}`);
  if (profile.managementScope) header.push(`Management scope: ${escapeHtml(profile.managementScope)}`);
  header.push(`Open to adjacent roles: ${profile.openToAdjacentRoles ? "yes" : "no"}`);
  if (profile.linkedinUrl) header.push(`LinkedIn: ${escapeHtml(profile.linkedinUrl)}`);
  sections.push(header.join("\n"));

  if (profile.experiences.length > 0) sections.push("<b>Experience</b>");
  for (const e of profile.experiences) {
    const dates = `${formatMonth(e.startDate) ?? "?"} – ${e.isCurrent ? "present" : (formatMonth(e.endDate) ?? "?")}`;
    const meta = [dates, e.industry, e.location, e.managedHeadcount ? `managed ${e.managedHeadcount}` : null]
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
    sections.push(`<b>${FACT_SECTION_TITLES[kind]}</b>\n${bullets(items)}`);
  }

  const preferenceKinds = (Object.keys(PREFERENCE_SECTION_TITLES) as PreferenceKind[]).filter((k) =>
    profile.preferences.some((p) => p.kind === k),
  );
  for (const kind of preferenceKinds) {
    const items = profile.preferences.filter((p) => p.kind === kind).map((p) => p.label);
    sections.push(`<b>${PREFERENCE_SECTION_TITLES[kind]}</b>\n${bullets(items)}`);
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

export const analyzeKeyboard = () =>
  new InlineKeyboard().text("🔍 Analyze", encodeCallback({ type: "onboarding_analyze" }));

export function profileReplyViews(reply: ProfileReply): View[] {
  switch (reply.kind) {
    case "ask_linkedin":
      return [{ text: messages.askLinkedin }];
    case "ask_documents":
      return [{ text: `${reply.linkedinSaved ? messages.linkedinSaved : messages.linkedinSkipped}\n\n${messages.askDocuments}` }];
    case "source_received": {
      const name = reply.fileName ? ` (${escapeHtml(reply.fileName)})` : "";
      return [
        {
          text: `Got ${SOURCE_LABELS[reply.source]}${name} ✅ Send more, or tap <b>Analyze</b> when you're done.`,
          keyboard: analyzeKeyboard(),
        },
      ];
    }
    case "unreadable_document":
      return [{ text: messages.unreadableDocument }];
    case "need_source":
      return [{ text: messages.needSource }];
    case "analysis_failed":
      return [{ text: messages.analysisFailed, keyboard: analyzeKeyboard() }];
    case "busy":
      return [{ text: messages.busy }];
    case "question":
      return [
        {
          text: `<i>Question ${reply.position} of ${reply.total}</i>\n${escapeHtml(reply.text)}\n\n<i>Reply \"skip\" to skip.</i>`,
        },
      ];
    case "review":
      return withFinalKeyboard(
        [reply.note ? messages.reviewUpdated : messages.reviewIntro, ...profileSections(reply.profile)],
        messages.reviewOutro,
        new InlineKeyboard().text("✅ Confirm profile", encodeCallback({ type: "onboarding_confirm" })),
      );
    case "onboarding_done":
      return [{ text: messages.onboardingDone }];
    case "profile":
      return withFinalKeyboard(profileSections(reply.profile), messages.profileOutro);
    case "edit_proposed":
      return withFinalKeyboard(
        [messages.editProposed, reply.changes.map(escapeHtml).join("\n")],
        "Apply these changes?",
        new InlineKeyboard()
          .text("✅ Apply", encodeCallback({ type: "edit_apply", token: reply.token }))
          .text("✖️ Cancel", encodeCallback({ type: "edit_cancel", token: reply.token })),
      );
    case "edit_applied":
      return [{ text: messages.editApplied }];
    case "edit_cancelled":
      return [{ text: messages.editCancelled }];
    case "expired":
      return [{ text: messages.expired }];
    case "no_change":
      return [{ text: reply.reply ? escapeHtml(reply.reply) : messages.noChange }];
    case "not_onboarded":
      return [{ text: messages.notOnboarded }];
    case "document_not_expected":
      return [{ text: messages.documentNotExpected }];
  }
}
