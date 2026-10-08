const GENERIC = /^(?:a|an|new|some|more|any|other|relevant|matching|good|the|me|for me|now|חדשות|נוספות|מתאימות|רלוונטיות|עכשיו)$/i;

/** "find me jobs", "search for product manager jobs now". */
const ENGLISH =
  /^(?:please\s+)?(?:can you\s+)?(?:search|find|look)(?:\s+for)?(?:\s+me)?(?:\s+(.+?))?\s+(?:jobs?|positions?|roles?|openings?)(?:\s+(?:for me|now|please))*\s*[.!?]*$/i;
/** "חפש לי משרות", "תחפש עכשיו משרות של מנהל מוצר". */
const HEBREW =
  /^(?:בבקשה\s+)?(?:ת?חפש|ל?חפש|ת?מצא|למצוא)(?:\s+לי)?(?:\s+עכשיו)?\s+(?:משרות|עבודות|עבודה|משרה)(?:\s+(?:(?:של|בתחום|בתור)\s+|[כב]-)?(.+?))?(?:\s+עכשיו)?\s*[.!?]*$/;

/** A plain-language request to search for jobs now, with what to search for when the user named it. */
export function parseSearchRequest(text: string): { keywords: string | null } | null {
  const trimmed = text.trim();
  const match = trimmed.match(HEBREW) ?? trimmed.match(ENGLISH);
  if (!match) return null;
  const keywords = match[1]?.trim() ?? null;
  return { keywords: keywords && !GENERIC.test(keywords) ? keywords : null };
}
