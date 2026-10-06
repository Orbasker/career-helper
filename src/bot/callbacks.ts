import type { FeedbackVerdict } from "../domain/enums.js";

export type CallbackAction =
  | { type: "job_details"; matchId: string }
  | { type: "feedback"; matchId: string; verdict: FeedbackVerdict }
  | { type: "tailor_cv"; matchId: string }
  | { type: "onboarding_analyze" }
  | { type: "onboarding_confirm" }
  | { type: "edit_apply"; token: string }
  | { type: "edit_cancel"; token: string };

const VERDICT_CODES: Record<FeedbackVerdict, string> = { interested: "i", not_interested: "n" };
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
    case "onboarding_analyze":
      return "ob:analyze";
    case "onboarding_confirm":
      return "ob:confirm";
    case "edit_apply":
      return `pe:a:${action.token}`;
    case "edit_cancel":
      return `pe:c:${action.token}`;
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

  const matchId = parts.at(-1);
  if (!matchId || !UUID.test(matchId)) return null;

  if (parts.length === 2 && parts[0] === "job") return { type: "job_details", matchId };
  if (parts.length === 2 && parts[0] === "cv") return { type: "tailor_cv", matchId };
  if (parts.length === 3 && parts[0] === "fb") {
    const verdict = (Object.keys(VERDICT_CODES) as FeedbackVerdict[]).find((v) => VERDICT_CODES[v] === parts[1]);
    if (verdict) return { type: "feedback", matchId, verdict };
  }
  return null;
}
