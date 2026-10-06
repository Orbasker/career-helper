import type { ConfidenceLevel, EmploymentType, FeedbackVerdict, MatchRecommendation, WorkMode } from "../domain/enums.js";

export interface TelegramIdentity {
  telegramUserId: number;
  chatId: number;
  displayName?: string;
  locale?: string;
}

export interface UserSession {
  userId: string;
  hasProfile: boolean;
}

export interface MatchSummary {
  matchId: string;
  title: string;
  company: string | null;
  location: string | null;
  recommendation: MatchRecommendation | null;
  explanation: string | null;
}

export interface MatchDetails extends MatchSummary {
  description: string;
  sourceUrl: string;
  workMode: WorkMode | null;
  employmentType: EmploymentType | null;
  confidence: ConfidenceLevel | null;
  fitEvidence: string[];
  gaps: string[];
  transferableSkills: string[];
  feedback: FeedbackVerdict | null;
}

export type OnboardingStep = { done: false; question: string } | { done: true };

export type TextOutcome = { kind: "onboarding"; step: OnboardingStep } | { kind: "preference_noted" };

export type CvRequestOutcome = "requested" | "already_requested" | "not_found";

export interface UserService {
  ensureUser(identity: TelegramIdentity): Promise<UserSession>;
}

export interface OnboardingService {
  start(userId: string): Promise<OnboardingStep>;
}

export interface MatchService {
  latest(userId: string, limit: number): Promise<MatchSummary[]>;
  details(userId: string, matchId: string): Promise<MatchDetails | null>;
}

export interface FeedbackService {
  record(userId: string, matchId: string, verdict: FeedbackVerdict): Promise<boolean>;
}

export interface CvService {
  requestTailored(userId: string, matchId: string): Promise<CvRequestOutcome>;
}

export interface ConversationService {
  handleText(userId: string, text: string): Promise<TextOutcome>;
}

export interface AppServices {
  users: UserService;
  onboarding: OnboardingService;
  matches: MatchService;
  feedback: FeedbackService;
  cv: CvService;
  conversation: ConversationService;
}
