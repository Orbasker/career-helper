import { CONVERSATION_LANGUAGES, type ConversationLanguage } from "../domain/enums.js";
import { DEFAULT_LANGUAGE } from "../domain/language.js";
import { en, type Strings } from "./en.js";
import { he } from "./he.js";

export type { Strings };

const CATALOGS: Record<ConversationLanguage, Strings> = { en, he };

/** The user-facing copy for a language; users who never chose one get the default language. */
export function strings(language: ConversationLanguage | null | undefined): Strings {
  return CATALOGS[language ?? DEFAULT_LANGUAGE];
}

export const ALL_STRINGS: readonly Strings[] = CONVERSATION_LANGUAGES.map((language) => CATALOGS[language]);
