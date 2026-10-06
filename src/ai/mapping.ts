import { normalizeDate } from "../domain/dates.js";
import type { FactOrigin, ProfileSourceKind } from "../domain/enums.js";
import type { ExperienceFields, ProfileChange, ProfileFields, ProfileSnapshot } from "../domain/profile.js";
import { toPreferenceValue, type Extraction, type Interpretation } from "./schemas.js";

const SOURCE_ORIGINS: Record<ProfileSourceKind, FactOrigin> = {
  cv: "cv_upload",
  linkedin_export: "linkedin_import",
  pasted_text: "conversation",
};

type RawExperience = Omit<ExperienceFields, "startDate" | "endDate"> & {
  startDate: string | null;
  endDate: string | null;
};

export function normalizeExperience(raw: RawExperience): ExperienceFields {
  const startDate = normalizeDate(raw.startDate);
  let endDate = raw.isCurrent ? null : normalizeDate(raw.endDate);
  if (startDate && endDate && endDate < startDate) endDate = null;
  return {
    employer: raw.employer.trim(),
    title: raw.title.trim(),
    industry: raw.industry,
    location: raw.location,
    seniority: raw.seniority,
    managedHeadcount: raw.managedHeadcount,
    startDate,
    endDate,
    isCurrent: raw.isCurrent,
  };
}

function definedFields<T extends Record<string, unknown>>(fields: T): Partial<{ [K in keyof T]: NonNullable<T[K]> }> {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined)) as Partial<{
    [K in keyof T]: NonNullable<T[K]>;
  }>;
}

export function extractionToChanges(extraction: Extraction): ProfileChange[] {
  const changes: ProfileChange[] = [];
  const profile: Partial<ProfileFields> = definedFields({
    headline: extraction.headline,
    summary: extraction.summary,
    currentSeniority: extraction.currentSeniority,
    managementScope: extraction.managementScope,
    openToAdjacentRoles: extraction.openToAdjacentRoles,
  });
  if (Object.keys(profile).length > 0) changes.push({ op: "update_profile", fields: profile });

  extraction.experiences.forEach(({ source, facts, ...raw }, index) => {
    if (!raw.employer.trim() || !raw.title.trim()) return;
    const ref = `x${index}`;
    const origin = SOURCE_ORIGINS[source];
    changes.push({ op: "add_experience", ref, experience: normalizeExperience(raw), origin });
    for (const fact of facts) {
      if (!fact.statement.trim()) continue;
      changes.push({
        op: "add_fact",
        kind: fact.kind,
        statement: fact.statement.trim(),
        experienceId: null,
        experienceRef: ref,
        origin,
      });
    }
  });

  for (const fact of extraction.generalFacts) {
    if (!fact.statement.trim()) continue;
    changes.push({
      op: "add_fact",
      kind: fact.kind,
      statement: fact.statement.trim(),
      experienceId: null,
      experienceRef: null,
      origin: SOURCE_ORIGINS[fact.source],
    });
  }

  for (const { value, ...preference } of extraction.preferences) {
    changes.push({
      op: "add_preference",
      preference: { ...preference, value: toPreferenceValue(value) },
      replacesPreferenceId: null,
    });
  }
  return changes;
}

export interface Aliases {
  experiences: Map<string, string>;
  facts: Map<string, string>;
  preferences: Map<string, string>;
}

export function aliasSnapshot(snapshot: ProfileSnapshot): { aliases: Aliases; view: unknown } {
  const aliases: Aliases = { experiences: new Map(), facts: new Map(), preferences: new Map() };
  const experienceAlias = new Map<string, string>();
  const experiences = snapshot.experiences.map((e, i) => {
    const alias = `e${i + 1}`;
    aliases.experiences.set(alias, e.id);
    experienceAlias.set(e.id, alias);
    const { id: _id, ...fields } = e;
    return { id: alias, ...fields };
  });
  const facts = snapshot.facts.map((f, i) => {
    const alias = `f${i + 1}`;
    aliases.facts.set(alias, f.id);
    return {
      id: alias,
      kind: f.kind,
      statement: f.statement,
      experience: f.workExperienceId ? (experienceAlias.get(f.workExperienceId) ?? null) : null,
    };
  });
  const preferences = snapshot.preferences.map((p, i) => {
    const alias = `p${i + 1}`;
    aliases.preferences.set(alias, p.id);
    return { id: alias, kind: p.kind, dimension: p.dimension, label: p.label, status: p.status };
  });
  return { aliases, view: { profile: snapshot.profile, experiences, facts, preferences } };
}

export function interpretationToChanges(interpretation: Interpretation, aliases: Aliases): ProfileChange[] {
  const changes: ProfileChange[] = [];
  const newRefs = new Set<string>();

  for (const change of interpretation.changes) {
    switch (change.op) {
      case "update_profile": {
        const { op: _op, ...fields } = change;
        const defined = definedFields(fields);
        if (Object.keys(defined).length > 0) changes.push({ op: "update_profile", fields: defined });
        break;
      }
      case "add_experience": {
        const { op: _op, ref, ...raw } = change;
        if (!raw.employer.trim() || !raw.title.trim()) break;
        newRefs.add(ref);
        changes.push({ op: "add_experience", ref, experience: normalizeExperience(raw), origin: "conversation" });
        break;
      }
      case "update_experience": {
        const experienceId = aliases.experiences.get(change.experience);
        if (!experienceId) break;
        const { op: _op, experience: _e, startDate, endDate, isCurrent, ...rest } = change;
        const fields: Partial<ExperienceFields> = definedFields(rest);
        if (startDate !== null) fields.startDate = normalizeDate(startDate);
        if (endDate !== null) {
          fields.endDate = normalizeDate(endDate);
          fields.isCurrent = false;
        }
        if (isCurrent !== null) fields.isCurrent = isCurrent;
        if (isCurrent) fields.endDate = null;
        if (Object.keys(fields).length > 0) changes.push({ op: "update_experience", experienceId, fields });
        break;
      }
      case "remove_experience": {
        const experienceId = aliases.experiences.get(change.experience);
        if (experienceId) changes.push({ op: "remove_experience", experienceId });
        break;
      }
      case "add_fact": {
        if (!change.statement.trim()) break;
        const existing = change.experience ? aliases.experiences.get(change.experience) : undefined;
        const ref = change.experience && newRefs.has(change.experience) ? change.experience : null;
        changes.push({
          op: "add_fact",
          kind: change.kind,
          statement: change.statement.trim(),
          experienceId: existing ?? null,
          experienceRef: ref,
          origin: "conversation",
        });
        break;
      }
      case "update_fact": {
        const factId = aliases.facts.get(change.fact);
        if (!factId || !change.statement.trim()) break;
        changes.push({ op: "update_fact", factId, kind: change.kind, statement: change.statement.trim() });
        break;
      }
      case "remove_fact": {
        const factId = aliases.facts.get(change.fact);
        if (factId) changes.push({ op: "remove_fact", factId });
        break;
      }
      case "add_preference": {
        const { op: _op, replaces, value, ...preference } = change;
        changes.push({
          op: "add_preference",
          preference: { ...preference, value: toPreferenceValue(value) },
          replacesPreferenceId: replaces ? (aliases.preferences.get(replaces) ?? null) : null,
        });
        break;
      }
      case "remove_preference": {
        const preferenceId = aliases.preferences.get(change.preference);
        if (preferenceId) changes.push({ op: "remove_preference", preferenceId });
        break;
      }
    }
  }
  return changes;
}
