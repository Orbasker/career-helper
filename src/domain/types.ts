import type { SeniorityLevel, WorkMode, EmploymentType } from "./enums.js";

export type PreferenceValue =
  /** With `between`, the first two places bound a range, e.g. "anywhere from Rehovot to Caesarea". */
  | { type: "location"; places: string[]; between?: boolean; maxCommuteMinutes?: number }
  | { type: "work_mode"; modes: WorkMode[] }
  | { type: "employment_type"; types: EmploymentType[] }
  | { type: "compensation"; currency: string; min?: number; max?: number; period: "month" | "year" }
  | { type: "seniority"; levels: SeniorityLevel[] }
  | { type: "terms"; terms: string[] }
  | { type: "free_text"; text: string };

export interface FitEvidence {
  claim: string;
  careerFactIds: string[];
  workExperienceIds?: string[];
  jobExcerpt?: string;
}

export interface MatchEvidence {
  fitEvidence: FitEvidence[];
  gaps: string[];
  risks: string[];
  transferableSkills: string[];
  adjacencyReasoning?: string;
  failedConstraintIds?: string[];
  matchedTerms?: string[];
}
