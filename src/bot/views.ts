import { InlineKeyboard, Keyboard } from "grammy";
import type { MatchRecommendation } from "../domain/enums.js";
import type { MatchDetails, MatchSummary } from "../app/services.js";
import { encodeCallback } from "./callbacks.js";

export const WHATS_NEW_LABEL = "What's new?";
const DESCRIPTION_PREVIEW_LENGTH = 1200;

const RECOMMENDATION_LABELS: Record<MatchRecommendation, string> = {
  strong_fit: "Strong fit",
  good_fit: "Good fit",
  stretch: "Stretch",
  not_recommended: "Not recommended",
};

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const mainMenu = new Keyboard().text(WHATS_NEW_LABEL).resized().persistent();

export const messages = {
  welcomeBack: "Welcome back! Tap <b>What's new?</b> for your latest matches, or just tell me what you'd like to change in your preferences.",
  welcomeNew: "Hi! I'm your career agent. I'll find jobs that fit your experience — including adjacent roles — and help tailor your CV. Let's start with a few questions.",
  onboardingDone: "Thanks — your profile draft is saved. I'll start looking for matches and let you know when something fits.",
  noMatches: "No new matches right now. I'll message you when something relevant shows up.",
  matchNotFound: "I couldn't find that job anymore.",
  preferenceNoted: "Got it — I've noted that preference. I'll confirm with you before it changes how I filter jobs.",
  feedbackInterested: "Marked as interested 👍",
  feedbackNotInterested: "Got it, I'll show fewer jobs like this.",
  cvRequested: "I'm preparing a tailored CV for this job. I'll send it here when it's ready for your review.",
  cvAlreadyRequested: "A tailored CV for this job is already in progress.",
  help: [
    "<b>What I can do</b>",
    "• /new — your latest matches",
    "• /start — restart onboarding",
    "• Send me any message to update your preferences (e.g. \"no more than 40 minutes commute\").",
  ].join("\n"),
  error: "Something went wrong on my side. Please try again in a moment.",
};

export function matchListItem(match: MatchSummary): { text: string; keyboard: InlineKeyboard } {
  const lines = [`<b>${escapeHtml(match.title)}</b>`];
  const meta = [match.company, match.location].filter((v): v is string => Boolean(v)).map(escapeHtml);
  if (meta.length > 0) lines.push(meta.join(" · "));
  if (match.recommendation) lines.push(`<i>${RECOMMENDATION_LABELS[match.recommendation]}</i>`);
  if (match.explanation) lines.push(escapeHtml(match.explanation));
  return {
    text: lines.join("\n"),
    keyboard: new InlineKeyboard().text("Details", encodeCallback({ type: "job_details", matchId: match.matchId })),
  };
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
