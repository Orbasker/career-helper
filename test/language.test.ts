import { describe, expect, it } from "vitest";
import { decodeCallback, encodeCallback } from "../src/bot/callbacks.js";
import { chooseCvLanguage } from "../src/cv/language.js";
import { parseLanguageChoice, parseLanguageRequest, postingLanguage } from "../src/domain/language.js";

describe("language parsing", () => {
  it("reads answers to the language question", () => {
    expect(parseLanguageChoice("English")).toBe("en");
    expect(parseLanguageChoice(" hebrew! ")).toBe("he");
    expect(parseLanguageChoice("עברית")).toBe("he");
    expect(parseLanguageChoice("אנגלית")).toBe("en");
    expect(parseLanguageChoice("French")).toBeNull();
  });

  it("recognizes requests to switch language", () => {
    expect(parseLanguageRequest("Switch to Hebrew")).toBe("he");
    expect(parseLanguageRequest("please change the language to English")).toBe("en");
    expect(parseLanguageRequest("Can you speak to me in Hebrew?")).toBe("he");
    expect(parseLanguageRequest("English please")).toBe("en");
    expect(parseLanguageRequest("עבור לעברית")).toBe("he");
    expect(parseLanguageRequest("תדבר איתי באנגלית")).toBe("en");
    expect(parseLanguageRequest("change language")).toBe("menu");
    expect(parseLanguageRequest("שנה שפה")).toBe("menu");
  });

  it("leaves profile statements about languages alone", () => {
    expect(parseLanguageRequest("I speak Hebrew and English")).toBeNull();
    expect(parseLanguageRequest("Add that I'm fluent in English")).toBeNull();
    expect(parseLanguageRequest("I switched to a Hebrew-speaking team in 2021")).toBeNull();
  });

  it("round-trips the language callback", () => {
    expect(decodeCallback(encodeCallback({ type: "set_language", language: "he" }))).toEqual({ type: "set_language", language: "he" });
    expect(decodeCallback("lang:fr")).toBeNull();
  });
});

describe("CV language", () => {
  const english = "Senior HR Business Partner. Partner with R&D leadership on performance reviews and retention.";
  const hebrew = "שותפה עסקית משאבי אנוש. ליווי הנהלת מחקר ופיתוח בתהליכי הערכת ביצועים ושימור, כולל עבודה עם Workday ו-HiBob.";

  it("reads the posting's language only when it is clear", () => {
    expect(postingLanguage(english)).toBe("en");
    expect(postingLanguage(hebrew)).toBe("he");
    expect(postingLanguage("HR Lead")).toBeNull();
    expect(postingLanguage(`${english} ${english} ${english} נדרשת עברית ברמת שפת אם`)).toBeNull();
  });

  it("prefers the request, then the posting, then a single CV language, then the conversation language", () => {
    const choose = (input: Partial<Parameters<typeof chooseCvLanguage>[0]>) =>
      chooseCvLanguage({ requested: null, posting: "", cvLanguages: [], conversation: null, ...input });

    expect(choose({ requested: "en", posting: hebrew, cvLanguages: ["he"], conversation: "he" })).toEqual({ language: "en", source: "requested" });
    expect(choose({ posting: hebrew, cvLanguages: ["en"], conversation: "en" })).toEqual({ language: "he", source: "job" });
    expect(choose({ posting: "HR Lead", cvLanguages: ["he", "he"], conversation: "en" })).toEqual({ language: "he", source: "cv" });
    expect(choose({ posting: "HR Lead", cvLanguages: ["he", "en"], conversation: "he" })).toEqual({ language: "he", source: "conversation" });
    expect(choose({})).toEqual({ language: "en", source: "conversation" });
  });
});
