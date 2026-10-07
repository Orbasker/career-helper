import { CONVERSATION_LANGUAGES, type ConversationLanguage, type FeedbackVerdict } from "../domain/enums.js";
import type { FeedbackReasonTag } from "../learning/infer.js";

export const DOCUMENT_ACTIONS = ["default", "label", "replace", "remove", "confirm_remove"] as const;
export type DocumentAction = (typeof DOCUMENT_ACTIONS)[number];

export type CallbackAction =
  | { type: "job_details"; matchId: string }
  | { type: "feedback"; matchId: string; verdict: FeedbackVerdict }
  | { type: "tailor_cv"; matchId: string }
  | { type: "cv_decision"; versionId: string; approve: boolean }
  | { type: "cv_document"; versionId: string }
  | { type: "site_remove"; siteId: string }
  | { type: "connections_delete" }
  | { type: "sources_boards" }
  | { type: "sources_sites" }
  | { type: "set_language"; language: ConversationLanguage }
  | { type: "onboarding_analyze" }
  | { type: "onboarding_confirm" }
  | { type: "document_language"; documentId: string; language: ConversationLanguage }
  | { type: "documents" }
  | { type: "document_upload" }
  | { type: "document"; documentId: string }
  | { type: "document_action"; documentId: string; action: DocumentAction }
  | { type: "edit_apply"; token: string }
  | { type: "edit_cancel"; token: string }
  | { type: "feedback_reason"; feedbackId: string; tag: FeedbackReasonTag }
  | { type: "feedback_reason_text"; feedbackId: string }
  | { type: "proposal_decision"; preferenceId: string; accept: boolean };

const VERDICT_CODES: Record<FeedbackVerdict, string> = { interested: "i", not_interested: "n" };
const REASON_CODES: Record<FeedbackReasonTag, string> = {
  role: "r",
  seniority: "s",
  location: "l",
  work_mode: "w",
  company: "c",
  pay: "p",
};
const REASON_TEXT_CODE = "o";
const DOCUMENT_ACTION_CODES: Record<DocumentAction, string> = {
  default: "d",
  label: "l",
  replace: "r",
  remove: "x",
  confirm_remove: "y",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{4,32}$/;

export function encodeCallback(action: CallbackAction): string {
  switch (action.type) {
    case "job_details":
      return `job:${action.matchId}`;
    case "feedback":
      return `fb:${VERDICT_CODES[action.verdict]}:${action.matchId}`;
    case "tailor_cv":
      return `cv:${action.matchId}`;
    case "cv_decision":
      return `cvd:${action.approve ? "a" : "x"}:${action.versionId}`;
    case "cv_document":
      return `cvf:${action.versionId}`;
    case "site_remove":
      return `st:x:${action.siteId}`;
    case "connections_delete":
      return "cn:delete";
    case "sources_boards":
      return "src:boards";
    case "sources_sites":
      return "src:sites";
    case "set_language":
      return `lang:${action.language}`;
    case "onboarding_analyze":
      return "ob:analyze";
    case "onboarding_confirm":
      return "ob:confirm";
    case "document_language":
      return `dl:${action.language}:${action.documentId}`;
    case "documents":
      return "doc:list";
    case "document_upload":
      return "doc:add";
    case "document":
      return `doc:${action.documentId}`;
    case "document_action":
      return `doc:${DOCUMENT_ACTION_CODES[action.action]}:${action.documentId}`;
    case "edit_apply":
      return `pe:a:${action.token}`;
    case "edit_cancel":
      return `pe:c:${action.token}`;
    case "feedback_reason":
      return `fr:${REASON_CODES[action.tag]}:${action.feedbackId}`;
    case "feedback_reason_text":
      return `fr:${REASON_TEXT_CODE}:${action.feedbackId}`;
    case "proposal_decision":
      return `pp:${action.accept ? "a" : "r"}:${action.preferenceId}`;
  }
}

export function decodeCallback(data: string): CallbackAction | null {
  const parts = data.split(":");
  if (data === "ob:analyze") return { type: "onboarding_analyze" };
  if (data === "ob:confirm") return { type: "onboarding_confirm" };
  if (data === "cn:delete") return { type: "connections_delete" };
  if (data === "src:boards") return { type: "sources_boards" };
  if (data === "src:sites") return { type: "sources_sites" };
  if (data === "doc:list") return { type: "documents" };
  if (data === "doc:add") return { type: "document_upload" };
  if (parts.length === 2 && parts[0] === "lang") {
    const language = CONVERSATION_LANGUAGES.find((l) => l === parts[1]);
    if (language) return { type: "set_language", language };
  }
  if (parts.length === 3 && parts[0] === "pe" && TOKEN.test(parts[2]!)) {
    if (parts[1] === "a") return { type: "edit_apply", token: parts[2]! };
    if (parts[1] === "c") return { type: "edit_cancel", token: parts[2]! };
  }

  const id = parts.at(-1);
  if (!id || !UUID.test(id)) return null;

  if (parts.length === 3 && parts[0] === "fr") {
    if (parts[1] === REASON_TEXT_CODE) return { type: "feedback_reason_text", feedbackId: id };
    const tag = (Object.keys(REASON_CODES) as FeedbackReasonTag[]).find((t) => REASON_CODES[t] === parts[1]);
    if (tag) return { type: "feedback_reason", feedbackId: id, tag };
  }
  if (parts.length === 3 && parts[0] === "dl") {
    const language = CONVERSATION_LANGUAGES.find((l) => l === parts[1]);
    if (language) return { type: "document_language", documentId: id, language };
  }
  if (parts.length === 3 && parts[0] === "st" && parts[1] === "x") return { type: "site_remove", siteId: id };
  if (parts.length === 2 && parts[0] === "doc") return { type: "document", documentId: id };
  if (parts.length === 3 && parts[0] === "doc") {
    const action = DOCUMENT_ACTIONS.find((a) => DOCUMENT_ACTION_CODES[a] === parts[1]);
    if (action) return { type: "document_action", documentId: id, action };
  }
  if (parts.length === 3 && parts[0] === "cvd" && (parts[1] === "a" || parts[1] === "x")) {
    return { type: "cv_decision", versionId: id, approve: parts[1] === "a" };
  }
  if (parts.length === 3 && parts[0] === "pp" && (parts[1] === "a" || parts[1] === "r")) {
    return { type: "proposal_decision", preferenceId: id, accept: parts[1] === "a" };
  }

  const matchId = id;
  if (parts.length === 2 && parts[0] === "job") return { type: "job_details", matchId };
  if (parts.length === 2 && parts[0] === "cv") return { type: "tailor_cv", matchId };
  if (parts.length === 2 && parts[0] === "cvf") return { type: "cv_document", versionId: matchId };
  if (parts.length === 3 && parts[0] === "fb") {
    const verdict = (Object.keys(VERDICT_CODES) as FeedbackVerdict[]).find((v) => VERDICT_CODES[v] === parts[1]);
    if (verdict) return { type: "feedback", matchId, verdict };
  }
  return null;
}
