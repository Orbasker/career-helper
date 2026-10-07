import type { ConversationLanguage } from "./enums.js";

export type CvLibraryRequest = { kind: "list" } | { kind: "default"; language: ConversationLanguage | null };

const CV = /\b(?:cvs?|resumes?|résumés?)\b|קורות\s+(?:ה)?חיים|קו["״׳']ח/i;
const DEFAULT = /\bdefault\b|ברירת[\s־-]*(?:ה)?מחדל/i;
const ENGLISH = /\benglish\b|אנגלית/i;
const HEBREW = /\bhebrew\b|עברית/i;
const LIST = [
  /^(?:please\s+)?(?:show|list|see|view|manage)\s+(?:me\s+)?(?:all\s+)?(?:of\s+)?my\s+(?:cvs|resumes|documents)\s*[?.!]?$/i,
  /^(?:my\s+(?:cvs|resumes)|(?:what|which)\s+(?:cvs|resumes)\s+(?:do\s+i\s+have|did\s+i\s+(?:upload|send)))\s*[?.!]?$/i,
  /^(?:(?:ת?ראה|הראה|ת?ציג|הצג)\s+(?:לי\s+)?)?(?:את\s+)?(?:כל\s+)?(?:קורות\s+(?:ה)?חיים|קו["״׳']ח|המסמכים)\s+שלי\s*[?.!]?$/,
  /^(?:אילו|איזה|מה)\s+(?:קורות\s+(?:ה)?חיים|קו["״׳']ח)\s+(?:יש\s+לי|העליתי|שלחתי)\s*[?.!]?$/,
];

/** Reads requests such as "show my CVs" or "use my English CV by default", in English or Hebrew. */
export function parseCvLibraryRequest(text: string): CvLibraryRequest | null {
  const trimmed = text.trim();
  if (LIST.some((pattern) => pattern.test(trimmed))) return { kind: "list" };
  if (!CV.test(trimmed) || !DEFAULT.test(trimmed)) return null;
  const english = ENGLISH.test(trimmed);
  const hebrew = HEBREW.test(trimmed);
  return { kind: "default", language: english === hebrew ? null : english ? "en" : "he" };
}
