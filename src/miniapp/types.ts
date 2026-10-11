import type { ConversationLanguage, EmploymentType, FeedbackVerdict, MatchRecommendation, WorkMode } from "../domain/enums.js";

/** Where a job sits for the user: approved, held back by the AI, blocked by a must-have, still being assessed, or hidden by them. */
export type ExploreTab = "matches" | "close" | "blocked" | "waiting" | "hidden";

/** Why a job was held back from the user's matches. */
export type HoldReason =
  | { kind: "must_have"; label: string }
  | { kind: "dislike"; label: string }
  | { kind: "outside_path" }
  | { kind: "not_a_fit" }
  | { kind: "low_relevance" };

export interface ExploreItem {
  matchId: string;
  tab: ExploreTab;
  title: string;
  company: string | null;
  location: string | null;
  sourceName: string;
  /** Cheap relevance in [0, 1]; null for jobs scored before blocked jobs were scored too. */
  score: number | null;
  recommendation: MatchRecommendation | null;
  /** The AI's explanation, in the user's language, once a job was assessed. */
  explanation: string | null;
  reasons: HoldReason[];
  feedback: FeedbackVerdict | null;
  applied: boolean;
  /** ISO timestamp of when the job was first matched for the user. */
  foundAt: string;
}

export interface ExploreData {
  language: ConversationLanguage;
  items: ExploreItem[];
}

export interface ExploreDetails {
  matchId: string;
  url: string;
  description: string;
  workMode: WorkMode | null;
  employmentType: EmploymentType | null;
  fitEvidence: string[];
  gaps: string[];
  transferableSkills: string[];
}

export const EXPLORE_ACTIONS = ["interested", "not_interested", "applied"] as const;
export type ExploreAction = (typeof EXPLORE_ACTIONS)[number];

export const INIT_DATA_HEADER = "x-telegram-init-data";
