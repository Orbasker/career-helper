import { and, asc, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { formatMonth } from "../../domain/dates.js";
import type { ExperienceFields, ProfileChange, ProfileFields, ProfileSnapshot } from "../../domain/profile.js";
import { careerFacts, careerProfiles, preferences, profileSources, workExperiences } from "../../db/schema.js";
import type { Db } from "../../db/types.js";
import type { Strings } from "../../i18n/index.js";
import type { ProfileView } from "../services.js";

export type ApplyMode = "draft" | "confirmed";

/** `verifiedOnly` limits experiences and facts to what the user confirmed; otherwise only rejected ones are hidden. */
export async function loadSnapshot(
  db: Db,
  userId: string,
  { verifiedOnly = false }: { verifiedOnly?: boolean } = {},
): Promise<ProfileSnapshot> {
  const experienceVisible = verifiedOnly
    ? eq(workExperiences.verificationStatus, "verified")
    : ne(workExperiences.verificationStatus, "rejected");
  const factVisible = verifiedOnly
    ? eq(careerFacts.verificationStatus, "verified")
    : ne(careerFacts.verificationStatus, "rejected");
  const [profile] = await db
    .select({
      headline: careerProfiles.headline,
      summary: careerProfiles.summary,
      currentSeniority: careerProfiles.currentSeniority,
      managementScope: careerProfiles.managementScope,
      openToAdjacentRoles: careerProfiles.openToAdjacentRoles,
      linkedinUrl: careerProfiles.linkedinUrl,
    })
    .from(careerProfiles)
    .where(eq(careerProfiles.userId, userId));
  const experiences = await db
    .select({
      id: workExperiences.id,
      employer: workExperiences.employer,
      title: workExperiences.title,
      industry: workExperiences.industry,
      location: workExperiences.location,
      seniority: workExperiences.seniority,
      managedHeadcount: workExperiences.managedHeadcount,
      startDate: workExperiences.startDate,
      endDate: workExperiences.endDate,
      isCurrent: workExperiences.isCurrent,
    })
    .from(workExperiences)
    .where(and(eq(workExperiences.userId, userId), experienceVisible))
    .orderBy(desc(workExperiences.isCurrent), sql`${workExperiences.startDate} desc nulls last`, asc(workExperiences.createdAt));
  const facts = await db
    .select({
      id: careerFacts.id,
      kind: careerFacts.kind,
      statement: careerFacts.statement,
      workExperienceId: careerFacts.workExperienceId,
    })
    .from(careerFacts)
    .where(and(eq(careerFacts.userId, userId), factVisible))
    .orderBy(asc(careerFacts.createdAt));
  const prefs = await db
    .select({
      id: preferences.id,
      kind: preferences.kind,
      dimension: preferences.dimension,
      label: preferences.label,
      value: preferences.value,
      status: preferences.status,
    })
    .from(preferences)
    .where(
      and(
        eq(preferences.userId, userId),
        inArray(preferences.status, ["proposed", "active"]),
        or(ne(preferences.origin, "inferred_from_feedback"), eq(preferences.status, "active")),
      ),
    )
    .orderBy(asc(preferences.createdAt));
  return {
    profile: profile ?? {
      headline: null,
      summary: null,
      currentSeniority: null,
      managementScope: null,
      openToAdjacentRoles: true,
      linkedinUrl: null,
    },
    experiences,
    facts,
    preferences: prefs,
  };
}

export async function clearDraftProfile(tx: Db, userId: string) {
  await tx.delete(careerFacts).where(and(eq(careerFacts.userId, userId), ne(careerFacts.verificationStatus, "verified")));
  await tx
    .delete(workExperiences)
    .where(and(eq(workExperiences.userId, userId), ne(workExperiences.verificationStatus, "verified")));
  await tx
    .delete(preferences)
    .where(and(eq(preferences.userId, userId), eq(preferences.origin, "onboarding"), eq(preferences.status, "proposed")));
  await tx.delete(profileSources).where(eq(profileSources.userId, userId));
}

export async function applyChanges(tx: Db, userId: string, changes: ProfileChange[], mode: ApplyMode) {
  const now = new Date();
  const verification =
    mode === "confirmed"
      ? ({ verificationStatus: "verified", verifiedAt: now } as const)
      : ({ verificationStatus: "unverified", verifiedAt: null } as const);
  const rejected = { verificationStatus: "rejected", verifiedAt: null } as const;
  const newExperienceIds = new Map<string, string>();

  const ownsExperience = async (experienceId: string) => {
    const [row] = await tx
      .select({ id: workExperiences.id })
      .from(workExperiences)
      .where(and(eq(workExperiences.id, experienceId), eq(workExperiences.userId, userId)));
    return row !== undefined;
  };

  for (const change of changes) {
    switch (change.op) {
      case "update_profile":
        await tx.update(careerProfiles).set(change.fields).where(eq(careerProfiles.userId, userId));
        break;
      case "add_experience": {
        const [row] = await tx
          .insert(workExperiences)
          .values({ userId, ...change.experience, origin: change.origin, ...verification })
          .returning({ id: workExperiences.id });
        newExperienceIds.set(change.ref, row!.id);
        break;
      }
      case "update_experience":
        await tx
          .update(workExperiences)
          .set({ ...change.fields, ...(mode === "confirmed" ? verification : {}) })
          .where(and(eq(workExperiences.id, change.experienceId), eq(workExperiences.userId, userId)));
        break;
      case "remove_experience":
        await tx
          .update(workExperiences)
          .set(rejected)
          .where(and(eq(workExperiences.id, change.experienceId), eq(workExperiences.userId, userId)));
        await tx
          .update(careerFacts)
          .set(rejected)
          .where(and(eq(careerFacts.workExperienceId, change.experienceId), eq(careerFacts.userId, userId)));
        break;
      case "add_fact": {
        let workExperienceId = change.experienceRef ? (newExperienceIds.get(change.experienceRef) ?? null) : null;
        if (!workExperienceId && change.experienceId && (await ownsExperience(change.experienceId))) {
          workExperienceId = change.experienceId;
        }
        await tx.insert(careerFacts).values({
          userId,
          workExperienceId,
          kind: change.kind,
          statement: change.statement,
          origin: change.origin,
          ...verification,
        });
        break;
      }
      case "update_fact": {
        const [old] = await tx
          .update(careerFacts)
          .set(rejected)
          .where(and(eq(careerFacts.id, change.factId), eq(careerFacts.userId, userId), ne(careerFacts.verificationStatus, "rejected")))
          .returning();
        if (!old) break;
        await tx.insert(careerFacts).values({
          userId,
          workExperienceId: old.workExperienceId,
          kind: change.kind ?? old.kind,
          statement: change.statement,
          metrics: old.metrics,
          origin: "conversation",
          sourceReference: old.id,
          ...verification,
        });
        break;
      }
      case "remove_fact":
        await tx
          .update(careerFacts)
          .set(rejected)
          .where(and(eq(careerFacts.id, change.factId), eq(careerFacts.userId, userId)));
        break;
      case "add_preference": {
        let supersedesId: string | null = null;
        if (change.replacesPreferenceId) {
          const [old] = await tx
            .update(preferences)
            .set({ status: "superseded", decidedAt: now })
            .where(
              and(
                eq(preferences.id, change.replacesPreferenceId),
                eq(preferences.userId, userId),
                inArray(preferences.status, ["proposed", "active"]),
              ),
            )
            .returning({ id: preferences.id });
          supersedesId = old?.id ?? null;
        }
        await tx.insert(preferences).values({
          userId,
          ...change.preference,
          supersedesId,
          ...(mode === "confirmed"
            ? { status: "active", origin: "user_stated", decidedAt: now }
            : { status: "proposed", origin: "onboarding" }),
        });
        break;
      }
      case "remove_preference":
        await tx
          .update(preferences)
          .set({
            status: sql`case when ${preferences.status} = 'proposed' then 'rejected' else 'retired' end::preference_status`,
            decidedAt: now,
          })
          .where(
            and(
              eq(preferences.id, change.preferenceId),
              eq(preferences.userId, userId),
              inArray(preferences.status, ["proposed", "active"]),
            ),
          );
        break;
    }
  }
}

export async function confirmDraftProfile(tx: Db, userId: string) {
  const now = new Date();
  await tx
    .update(workExperiences)
    .set({ verificationStatus: "verified", verifiedAt: now })
    .where(and(eq(workExperiences.userId, userId), eq(workExperiences.verificationStatus, "unverified")));
  await tx
    .update(careerFacts)
    .set({ verificationStatus: "verified", verifiedAt: now })
    .where(and(eq(careerFacts.userId, userId), eq(careerFacts.verificationStatus, "unverified")));
  await tx
    .update(preferences)
    .set({ status: "active", decidedAt: now })
    .where(and(eq(preferences.userId, userId), eq(preferences.origin, "onboarding"), eq(preferences.status, "proposed")));
  await tx
    .update(careerProfiles)
    .set({ status: "confirmed", confirmedAt: now, revision: sql`${careerProfiles.revision} + 1` })
    .where(eq(careerProfiles.userId, userId));
}

export async function bumpRevision(tx: Db, userId: string) {
  await tx
    .update(careerProfiles)
    .set({ revision: sql`${careerProfiles.revision} + 1` })
    .where(eq(careerProfiles.userId, userId));
}

export function toProfileView(snapshot: ProfileSnapshot): ProfileView {
  return {
    ...snapshot.profile,
    experiences: snapshot.experiences.map((e) => ({
      title: e.title,
      employer: e.employer,
      industry: e.industry,
      location: e.location,
      managedHeadcount: e.managedHeadcount,
      startDate: e.startDate,
      endDate: e.endDate,
      isCurrent: e.isCurrent,
      facts: snapshot.facts.filter((f) => f.workExperienceId === e.id).map((f) => f.statement),
    })),
    otherFacts: snapshot.facts
      .filter((f) => !f.workExperienceId || !snapshot.experiences.some((e) => e.id === f.workExperienceId))
      .map((f) => ({ kind: f.kind, statement: f.statement })),
    preferences: snapshot.preferences.map((p) => ({ kind: p.kind, label: p.label })),
  };
}

function formatValue(t: Strings["changes"], value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? t.yes : t.no;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatMonth(value)!;
  return String(value);
}

function formatFields(t: Strings["changes"], fields: Record<string, unknown>, labels: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${labels[key] ?? key} → ${formatValue(t, value)}`)
    .join(", ");
}

export function describeChanges(strings: Strings, changes: ProfileChange[], snapshot: ProfileSnapshot): string[] {
  const t = strings.changes;
  const role = (e: { title: string; employer: string }) => t.roleAt(e.title, e.employer);
  const experienceById = new Map(snapshot.experiences.map((e) => [e.id, e]));
  const factById = new Map(snapshot.facts.map((f) => [f.id, f]));
  const preferenceById = new Map(snapshot.preferences.map((p) => [p.id, p]));
  const newExperiences = new Map(
    changes.flatMap((c) => (c.op === "add_experience" ? [[c.ref, c.experience] as const] : [])),
  );

  return changes.map((change) => {
    switch (change.op) {
      case "update_profile":
        return `✏️ ${t.profile}: ${formatFields(t, change.fields, t.profileFields)}`;
      case "add_experience": {
        const e = change.experience;
        const end = e.isCurrent ? strings.profile.present : (formatMonth(e.endDate) ?? "?");
        return `➕ ${t.role}: ${role(e)} (${formatMonth(e.startDate) ?? "?"} – ${end})`;
      }
      case "update_experience": {
        const e = experienceById.get(change.experienceId);
        return `✏️ ${e ? role(e) : t.role}: ${formatFields(t, change.fields, t.experienceFields)}`;
      }
      case "remove_experience": {
        const e = experienceById.get(change.experienceId);
        return `➖ ${t.role}: ${e ? role(e) : t.unknownRole}`;
      }
      case "add_fact": {
        const e =
          (change.experienceRef && newExperiences.get(change.experienceRef)) ||
          (change.experienceId && experienceById.get(change.experienceId));
        return `➕ ${t.factKinds[change.kind]}: ${change.statement}${e ? ` (${role(e)})` : ""}`;
      }
      case "update_fact": {
        const old = factById.get(change.factId);
        return `✏️ ${t.factKinds[change.kind ?? old?.kind ?? "other"]}: “${old?.statement ?? "?"}” → “${change.statement}”`;
      }
      case "remove_fact": {
        const old = factById.get(change.factId);
        return `➖ ${t.factKinds[old?.kind ?? "other"]}: ${old?.statement ?? t.unknownFact}`;
      }
      case "add_preference": {
        const old = change.replacesPreferenceId ? preferenceById.get(change.replacesPreferenceId) : undefined;
        const label = `➕ ${t.preferenceKinds[change.preference.kind]}: ${change.preference.label}`;
        return old ? `${label} ${t.replaces(old.label)}` : label;
      }
      case "remove_preference": {
        const old = preferenceById.get(change.preferenceId);
        return `➖ ${old ? `${t.preferenceKinds[old.kind]}: ${old.label}` : t.unknownPreference}`;
      }
    }
  });
}
