import type { ConversationLanguage } from "../domain/enums.js";
import { strings } from "../i18n/index.js";

/** Tells a model which language user-facing text must be in; names of companies, roles and tools stay as written. */
export function replyLanguageRule(language: ConversationLanguage, fields: string): string {
  const name = strings(language).languageName;
  return `Language: write ${fields} in natural, fluent ${name}, unless the user explicitly asks for another language. Keep company names, product names, tools and quoted job-posting text as written.`;
}
