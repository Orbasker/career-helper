import type { EmploymentType, WorkMode } from "../domain/enums.js";

export interface MatchJob {
  title: string;
  company?: string | null;
  description: string;
  location: string | null;
  workMode: WorkMode | null;
  employmentType: EmploymentType | null;
}
