import { describe, expect, it } from "vitest";
import { decodeCallback, encodeCallback } from "../src/bot/callbacks.js";
import { parseLanguageChoice, parseLanguageRequest } from "../src/domain/language.js";

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
