import { describe, expect, it } from "vitest";
import { textDirection } from "../web/bidi.js";

describe("textDirection", () => {
  it("follows the script most letters are in, not the first one", () => {
    expect(textDirection("HRBP מטה חטיבת תעופה")).toBe("rtl");
    expect(textDirection("התפקיד מתאים לניסיון שלך ב-NVIDIA")).toBe("rtl");
    expect(textDirection("Senior HR Business Partner, Chip Design")).toBe("ltr");
    expect(textDirection("Talent Acquisition Partner - תל אביב")).toBe("ltr");
  });

  it("leaves text without letters to its container", () => {
    expect(textDirection("2026 · 12")).toBeUndefined();
    expect(textDirection(null)).toBeUndefined();
  });
});
