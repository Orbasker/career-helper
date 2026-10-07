import type { ApplicationStatus } from "./enums.js";

/** Order of the `/applications` groups: live processes first, closed ones last. */
export const APPLICATION_STATUS_ORDER: readonly ApplicationStatus[] = [
  "offer",
  "interviewing",
  "screening",
  "applied",
  "no_response",
  "rejected",
  "withdrawn",
];

const MAX_FIELD_LENGTH = 120;
const LINK = /https?:\/\/[^\s<>"']+/i;
/** "HR Manager at Acme", "מנהלת משאבי אנוש ב-Acme". */
const TITLE_AT_COMPANY = /^(.+?)\s+(?:at|@)\s+(.+)$|^(.+?)\s+ב[-־](.+)$/i;
const SEPARATOR = /\s*(?:\n|\s[—–-]\s|\s?\|\s?|,\s)\s*/;

/** The job link in a message, without trailing punctuation. */
export function applicationLink(text: string): string | null {
  return text.match(LINK)?.[0].replace(/[.,;!?)\]]+$/, "") ?? null;
}

/** Company and title from "Acme — HR Manager", "Acme, HR Manager" or "HR Manager at Acme", ignoring any link. */
export function parseApplicationDetails(text: string): { company: string; title: string } | null {
  const rest = text.replace(LINK, " ").replace(/[ \t]+/g, " ").trim();
  const clean = (value: string | undefined) => value?.trim().replace(/^["“”']+|["“”']+$/g, "").slice(0, MAX_FIELD_LENGTH).trim() ?? "";
  const at = rest.match(TITLE_AT_COMPANY);
  if (at && !SEPARATOR.test(rest)) {
    const title = clean(at[1] ?? at[3]);
    const company = clean(at[2] ?? at[4]);
    return title && company ? { company, title } : null;
  }
  const [company, ...others] = rest.split(SEPARATOR);
  const title = clean(others.join(" "));
  return clean(company) && title ? { company: clean(company), title } : null;
}

/** "my applications", "where do my applications stand?", "המועמדויות שלי". */
const APPLICATIONS_REQUEST = /\bmy (?:job )?applications\b|\bapplications? status\b|המועמדויות שלי|ההגשות שלי|סטטוס (?:ה)?מועמדויות/i;

export function isApplicationsRequest(text: string): boolean {
  return APPLICATIONS_REQUEST.test(text);
}
