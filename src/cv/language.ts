import type { ConversationLanguage, CvLanguageSource } from "../domain/enums.js";
import { DEFAULT_LANGUAGE, postingLanguage } from "../domain/language.js";

export interface CvLanguageChoice {
  language: ConversationLanguage;
  source: CvLanguageSource;
}

/**
 * Picks the language of a tailored CV: the user's explicit request, then the job posting's language when it is
 * clear, then the language of the user's uploaded CVs when they are all in one language, then the conversation
 * language.
 */
export function chooseCvLanguage(input: {
  requested: ConversationLanguage | null;
  posting: string;
  cvLanguages: readonly ConversationLanguage[];
  conversation: ConversationLanguage | null;
}): CvLanguageChoice {
  if (input.requested) return { language: input.requested, source: "requested" };
  const posting = postingLanguage(input.posting);
  if (posting) return { language: posting, source: "job" };
  const cvLanguages = new Set(input.cvLanguages);
  if (cvLanguages.size === 1) return { language: [...cvLanguages][0]!, source: "cv" };
  return { language: input.conversation ?? DEFAULT_LANGUAGE, source: "conversation" };
}
