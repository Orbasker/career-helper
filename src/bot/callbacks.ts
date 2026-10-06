import type { FeedbackVerdict } from "../domain/enums.js";
import type { FeedbackReasonTag } from "../learning/infer.js";

export type CallbackAction =
  | { type: "job_details"; matchId: string }
  | { type: "feedback"; matchId: string; verdict: FeedbackVerdict }
  | { type: "tailor_cv"; matchId: string }
  | { type: "cv_decision"; versionId: string; approve: boolean }
  | { type: "cv_document"; versionId: string }
  | { type: "site_remove"; siteId: string }
  | { type: "onboarding_analyze" }
  | { type: "onboarding_confirm" }
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
    case "onboarding_analyze":
      return "ob:analyze";
    case "onboarding_confirm":
      return "ob:confirm";
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
  if (parts.length === 3 && parts[0] === "st" && parts[1] === "x") return { type: "site_remove", siteId: id };
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
