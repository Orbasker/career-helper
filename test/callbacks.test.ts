import { describe, expect, it } from "vitest";
import { decodeCallback, encodeCallback, type CallbackAction } from "../src/bot/callbacks.js";

const matchId = "0b6f3f8e-8a55-4d5e-9a43-3c1f1f2b9d10";
const feedbackId = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";

describe("callback data", () => {
  it.each<CallbackAction>([
    { type: "job_details", matchId },
    { type: "feedback", matchId, verdict: "interested" },
    { type: "feedback", matchId, verdict: "not_interested" },
    { type: "tailor_cv", matchId },
    { type: "onboarding_analyze" },
    { type: "onboarding_confirm" },
    { type: "document_language", documentId: feedbackId, language: "he" },
    { type: "document_language", documentId: feedbackId, language: "en" },
    { type: "edit_apply", token: "aZ_9-xYw" },
    { type: "edit_cancel", token: "aZ_9-xYw" },
    { type: "feedback_reason", feedbackId, tag: "role" },
    { type: "feedback_reason", feedbackId, tag: "work_mode" },
    { type: "feedback_reason_text", feedbackId },
    { type: "proposal_decision", preferenceId: feedbackId, accept: true },
    { type: "cv_decision", versionId: feedbackId, approve: true },
    { type: "cv_decision", versionId: feedbackId, approve: false },
    { type: "cv_document", versionId: feedbackId, format: "docx" },
    { type: "cv_document", versionId: feedbackId, format: "pdf" },
    { type: "cv_language", versionId: feedbackId, language: "he" },
    { type: "cv_language", versionId: feedbackId, language: "en" },
    { type: "site_remove", siteId: feedbackId },
    { type: "connections_delete" },
    { type: "sources_boards" },
    { type: "sources_sites" },
    { type: "proposal_decision", preferenceId: feedbackId, accept: false },
  ])("round-trips %o within Telegram's 64-byte limit", (action) => {
    const data = encodeCallback(action);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toEqual(action);
  });

  it("reads Word document buttons sent before PDFs existed", () => {
    expect(decodeCallback(`cvf:${feedbackId}`)).toEqual({ type: "cv_document", versionId: feedbackId, format: "docx" });
  });

  it.each(["", "job:not-a-uuid", `fb:x:${matchId}`, `unknown:${matchId}`, `job:extra:${matchId}`, "pe:x:abcdefgh", "pe:a:no spaces", "ob:other", `fr:z:${feedbackId}`, `pp:x:${feedbackId}`, "fr:r:not-a-uuid", `dl:fr:${feedbackId}`, `cvf:x:${feedbackId}`, `cvl:fr:${feedbackId}`])(
    "rejects %s",
    (data) => {
      expect(decodeCallback(data)).toBeNull();
    },
  );
});
