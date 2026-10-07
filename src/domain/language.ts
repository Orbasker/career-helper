import type { ConversationLanguage } from "./enums.js";

export const DEFAULT_LANGUAGE: ConversationLanguage = "en";

export const LANGUAGE_NAMES: Record<ConversationLanguage, string> = { en: "English", he: "עברית" };

const ENGLISH = /^(english|eng|en|אנגלית)$/i;
const HEBREW = /^(hebrew|heb|he|עברית|ivrit)$/i;

/** Reads an answer to "which language?", e.g. "English" or "עברית". */
export function parseLanguageChoice(text: string): ConversationLanguage | null {
  const answer = text.trim().replace(/[.!]+$/, "").trim();
  if (ENGLISH.test(answer)) return "en";
  if (HEBREW.test(answer)) return "he";
  return null;
}

const SWITCH_REQUEST = [
  /^(?:please\s+)?(?:switch|change|set)\s+(?:the\s+|my\s+)?(?:language\s+)?to\s+(english|hebrew)\b/i,
  /^(?:please\s+|can you\s+|could you\s+)?(?:speak|talk|reply|answer|write|respond)\s+(?:to me\s+|with me\s+)?in\s+(english|hebrew)\b/i,
  /^(english|hebrew)(?:\s+please)?\s*[.!]?$/i,
  /^(?:תעבור|עבור|תחליף|החלף|תשנה|שנה)\s+(?:את השפה\s+|שפה\s+)?ל(עברית|אנגלית)/,
  /^(?:תדבר|דבר|תכתוב|כתוב|תענה|ענה)\s+(?:איתי\s+|אליי\s+)?ב(עברית|אנגלית)/,
  /^ב?(עברית|אנגלית)\s+בבקשה/,
];
const LANGUAGE_MENU_REQUEST = /^(?:(?:change|switch|set)\s+(?:the\s+|my\s+)?language|language settings|(?:תשנה|שנה|החלף|תחליף)\s+(?:את\s+ה)?שפה)\s*[.!?]?$/i;

/** Detects a request to change the conversation language: the requested language, "menu" to choose one, or null. */
export function parseLanguageRequest(text: string): ConversationLanguage | "menu" | null {
  const trimmed = text.trim();
  if (LANGUAGE_MENU_REQUEST.test(trimmed)) return "menu";
  for (const pattern of SWITCH_REQUEST) {
    const match = trimmed.match(pattern);
    if (match) return /^(english|אנגלית)$/i.test(match[1]!) ? "en" : "he";
  }
  return null;
}
