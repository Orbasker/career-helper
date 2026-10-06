import { and, eq, or, sql } from "drizzle-orm";
import { connections } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { normalizeCompany } from "../ingestion/normalize.js";
import { sameNormalizedCompany } from "../matching/employer.js";
import { tokenize } from "../matching/relevance.js";

export interface Contact {
  fullName: string;
  position: string | null;
  profileUrl: string | null;
  company: string | null;
}

const SENIORITY = [/\b(chief|cto|ceo|coo|cpo|vp|vice president)\b/i, /\b(head|director)\b/i, /\b(manager|lead|principal|staff)\b/i];

/**
 * The user's contacts at each job company, keyed by the job company's normalized name. Companies match on whole
 * words, so contacts at "Via Transportation" count for a job at "Via".
 */
export async function contactsAtCompanies(
  db: Db,
  userId: string,
  jobCompanies: readonly (string | null)[],
): Promise<Map<string, Contact[]>> {
  const wanted = [...new Set(jobCompanies.map(normalizeCompany).filter((c): c is string => c !== null))];
  const found = new Map<string, Contact[]>();
  if (wanted.length === 0) return found;

  const escape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db
    .select({
      fullName: connections.fullName,
      position: connections.position,
      profileUrl: connections.profileUrl,
      company: connections.company,
      normalizedCompany: connections.normalizedCompany,
    })
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        or(
          ...wanted.map(
            (company) =>
              sql`(${connections.normalizedCompany} = ${company} or ${connections.normalizedCompany} like ${`${escape(company)} %`} or ${company} like ${connections.normalizedCompany} || ' %')`,
          ),
        ),
      ),
    );

  for (const company of wanted) {
    const contacts = rows.filter((r) => r.normalizedCompany && sameNormalizedCompany(r.normalizedCompany, company));
    if (contacts.length) found.set(company, contacts.map(({ normalizedCompany: _, ...contact }) => contact));
  }
  return found;
}

export function contactsFor(found: Map<string, Contact[]>, jobCompany: string | null): Contact[] {
  const company = normalizeCompany(jobCompany);
  return company ? (found.get(company) ?? []) : [];
}

/** Most useful contacts first: same function as the job (shared title words), then seniority, then name. */
export function rankContacts(contacts: readonly Contact[], jobTitle: string): Contact[] {
  const jobTerms = tokenize(jobTitle);
  const overlap = (c: Contact) => [...tokenize(c.position)].filter((t) => jobTerms.has(t)).length;
  const seniority = (c: Contact) => {
    const level = SENIORITY.findIndex((pattern) => pattern.test(c.position ?? ""));
    return level < 0 ? SENIORITY.length : level;
  };
  return [...contacts].sort(
    (a, b) => overlap(b) - overlap(a) || seniority(a) - seniority(b) || a.fullName.localeCompare(b.fullName),
  );
}
