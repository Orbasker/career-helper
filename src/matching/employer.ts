import { and, eq, inArray } from "drizzle-orm";
import { workExperiences } from "../db/schema.js";
import type { Db } from "../db/types.js";
import { normalizeCompany } from "../ingestion/normalize.js";

export type EmployerRelation = { kind: "current" | "former"; employer: string };

export interface EmployerHistory {
  employer: string;
  isCurrent: boolean;
}

/**
 * Whether the job is at a company the user works or worked at. Names match on whole words after normalization,
 * so "Via" matches "Via Transportation, Inc." but not "Viasat"; a current role wins over a former one.
 */
export function employerRelation(jobCompany: string | null, history: readonly EmployerHistory[]): EmployerRelation | null {
  const company = normalizeCompany(jobCompany);
  if (!company) return null;
  const sameCompany = (employer: string) => {
    const name = normalizeCompany(employer);
    return name !== null && sameNormalizedCompany(name, company);
  };
  const current = history.find((e) => e.isCurrent && sameCompany(e.employer));
  if (current) return { kind: "current", employer: current.employer };
  const former = history.find((e) => sameCompany(e.employer));
  return former ? { kind: "former", employer: former.employer } : null;
}

/** Two normalized company names refer to the same company when one equals the other or starts it as whole words. */
export function sameNormalizedCompany(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return longer === shorter || longer.startsWith(`${shorter} `);
}

/** Verified employers per user, for flagging jobs at companies they know from the inside. */
export async function loadEmployerHistory(db: Db, userIds: readonly string[]): Promise<Map<string, EmployerHistory[]>> {
  const histories = new Map<string, EmployerHistory[]>();
  if (userIds.length === 0) return histories;
  const rows = await db
    .select({ userId: workExperiences.userId, employer: workExperiences.employer, isCurrent: workExperiences.isCurrent })
    .from(workExperiences)
    .where(and(inArray(workExperiences.userId, [...userIds]), eq(workExperiences.verificationStatus, "verified")));
  for (const { userId, ...history } of rows) histories.set(userId, [...(histories.get(userId) ?? []), history]);
  return histories;
}
