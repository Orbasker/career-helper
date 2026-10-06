import { describe, expect, it } from "vitest";
import { decodeCallback, encodeCallback, type CallbackAction } from "../src/bot/callbacks.js";

const matchId = "0b6f3f8e-8a55-4d5e-9a43-3c1f1f2b9d10";

describe("callback data", () => {
  it.each<CallbackAction>([
    { type: "job_details", matchId },
    { type: "feedback", matchId, verdict: "interested" },
    { type: "feedback", matchId, verdict: "not_interested" },
    { type: "tailor_cv", matchId },
  ])("round-trips %o within Telegram's 64-byte limit", (action) => {
    const data = encodeCallback(action);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(decodeCallback(data)).toEqual(action);
  });

  it.each(["", "job:not-a-uuid", `fb:x:${matchId}`, `unknown:${matchId}`, `job:extra:${matchId}`])(
    "rejects %s",
    (data) => {
      expect(decodeCallback(data)).toBeNull();
    },
  );
});
