import type {
  CareerFactKind,
  FactOrigin,
  PreferenceDimension,
  PreferenceKind,
  PreferenceStatus,
  SeniorityLevel,
} from "./enums.js";
import type { PreferenceValue } from "./types.js";

export interface ProfileFields {
  headline: string | null;
  summary: string | null;
  currentSeniority: SeniorityLevel | null;
  managementScope: string | null;
  openToAdjacentRoles: boolean;
}

export interface ExperienceFields {
  employer: string;
  title: string;
  industry: string | null;
  location: string | null;
  seniority: SeniorityLevel | null;
  managedHeadcount: number | null;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
}

export interface NewPreference {
  kind: PreferenceKind;
  dimension: PreferenceDimension;
  label: string;
  value: PreferenceValue;
}

export type ProfileChange =
  | { op: "update_profile"; fields: Partial<ProfileFields> }
  | {
      op: "add_experience";
      ref: string;
      experience: ExperienceFields;
      origin: FactOrigin;
      sourceDocumentId?: string | null;
    }
  | { op: "update_experience"; experienceId: string; fields: Partial<ExperienceFields> }
  | { op: "remove_experience"; experienceId: string }
  | {
      op: "add_fact";
      kind: CareerFactKind;
      statement: string;
      experienceId: string | null;
      experienceRef: string | null;
      origin: FactOrigin;
      sourceDocumentId?: string | null;
    }
  | { op: "update_fact"; factId: string; kind: CareerFactKind | null; statement: string }
  | { op: "remove_fact"; factId: string }
  | { op: "add_preference"; preference: NewPreference; replacesPreferenceId: string | null }
  | { op: "remove_preference"; preferenceId: string };

export interface ExperienceSnapshot extends ExperienceFields {
  id: string;
}

export interface FactSnapshot {
  id: string;
  kind: CareerFactKind;
  statement: string;
  workExperienceId: string | null;
}

export interface PreferenceSnapshot extends NewPreference {
  id: string;
  status: PreferenceStatus;
}

export interface ProfileSnapshot {
  profile: ProfileFields & { linkedinUrl: string | null };
  experiences: ExperienceSnapshot[];
  facts: FactSnapshot[];
  preferences: PreferenceSnapshot[];
}
