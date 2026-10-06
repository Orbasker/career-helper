import type {
  CareerFactKind,
  ConfidenceLevel,
  EmploymentType,
  FeedbackVerdict,
  MatchRecommendation,
  PreferenceKind,
  ProfileSourceKind,
  SeniorityLevel,
  WorkMode,
} from "../domain/enums.js";
import type { ProfileChange, ProfileSnapshot } from "../domain/profile.js";
import type { FeedbackReasonTag } from "../learning/infer.js";

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

export interface ProfileView {
  headline: string | null;
  summary: string | null;
  currentSeniority: SeniorityLevel | null;
  managementScope: string | null;
  openToAdjacentRoles: boolean;
  linkedinUrl: string | null;
  experiences: {
    title: string;
    employer: string;
    industry: string | null;
    location: string | null;
    managedHeadcount: number | null;
    startDate: string | null;
    endDate: string | null;
    isCurrent: boolean;
    facts: string[];
  }[];
  otherFacts: { kind: CareerFactKind; statement: string }[];
  preferences: { kind: PreferenceKind; label: string }[];
}

export interface IncomingDocument {
  fileRef: string;
  fileName: string | null;
  mimeType: string | null;
  data: Uint8Array;
}

export type ProfileReply =
  | { kind: "ask_linkedin" }
  | { kind: "ask_documents"; linkedinSaved: boolean }
  | { kind: "source_received"; source: ProfileSourceKind; fileName: string | null }
  | { kind: "unreadable_document" }
  | { kind: "need_source" }
  | { kind: "analysis_failed" }
  | { kind: "busy" }
  | { kind: "question"; text: string; position: number; total: number }
  | { kind: "review"; profile: ProfileView; note: string | null }
  | { kind: "onboarding_done" }
  | { kind: "profile"; profile: ProfileView }
  | { kind: "edit_proposed"; token: string; changes: string[] }
  | { kind: "edit_applied" }
  | { kind: "edit_cancelled" }
  | { kind: "expired" }
  | { kind: "document_not_expected" }
  | { kind: "no_change"; reply: string | null }
  | { kind: "not_onboarded" };

export type CvRequestOutcome = "requested" | "already_requested" | "not_found";

export interface UserService {
  ensureUser(identity: TelegramIdentity): Promise<UserSession>;
}

export interface OnboardingService {
  start(userId: string): Promise<ProfileReply>;
  addDocument(userId: string, document: IncomingDocument): Promise<ProfileReply>;
  analyze(userId: string): Promise<ProfileReply>;
  confirm(userId: string): Promise<ProfileReply>;
}

export interface MatchService {
  /** Unseen matches first, best recommendation first, then delivered ones; returned unseen matches count as delivered. */
  whatsNew(userId: string, limit: number): Promise<MatchSummary[]>;
  details(userId: string, matchId: string): Promise<MatchDetails | null>;
}

export interface PreferenceProposalView {
  preferenceId: string;
  kind: PreferenceKind;
  label: string;
  rationale: string;
}

export type ProposalDecision = "accepted" | "rejected" | "not_found";

export interface FeedbackService {
  /** Returns the feedback id, or null when the match is not the user's; repeating the latest verdict is a no-op. */
  record(userId: string, matchId: string, verdict: FeedbackVerdict): Promise<{ feedbackId: string } | null>;
  addReasonTag(userId: string, feedbackId: string, tag: FeedbackReasonTag): Promise<boolean>;
  /** Makes the user's next text message the free-text reason for this feedback, for a short while. */
  awaitReasonText(userId: string, feedbackId: string): Promise<boolean>;
  /** Stores `text` as the awaited reason; false when no reason is awaited, so the text is handled normally. */
  takeReasonText(userId: string, text: string): Promise<boolean>;
  /** Turns repeated feedback into new proposed preferences for the user to confirm. */
  learn(userId: string): Promise<PreferenceProposalView[]>;
  decideProposal(userId: string, preferenceId: string, accept: boolean): Promise<ProposalDecision>;
}

export interface CvService {
  requestTailored(userId: string, matchId: string): Promise<CvRequestOutcome>;
}

export interface ConversationService {
  handleText(userId: string, text: string): Promise<ProfileReply[]>;
  applyEdit(userId: string, token: string): Promise<ProfileReply>;
  cancelEdit(userId: string, token: string): Promise<ProfileReply>;
  showProfile(userId: string): Promise<ProfileReply>;
}

export interface ProfileSourceText {
  kind: ProfileSourceKind;
  content: string;
}

export interface ProfileExtraction {
  changes: ProfileChange[];
  followUpQuestions: string[];
}

export interface ProfileInterpretation {
  changes: ProfileChange[];
  reply: string | null;
}

export interface ProfileAssistant {
  extract(input: { linkedinUrl: string | null; sources: ProfileSourceText[] }): Promise<ProfileExtraction>;
  interpret(input: { snapshot: ProfileSnapshot; message: string; question: string | null }): Promise<ProfileInterpretation>;
}

export interface AppServices {
  users: UserService;
  onboarding: OnboardingService;
  matches: MatchService;
  feedback: FeedbackService;
  cv: CvService;
  conversation: ConversationService;
}
