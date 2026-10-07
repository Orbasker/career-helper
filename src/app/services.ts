import type {
  CareerFactKind,
  ConfidenceLevel,
  ConversationLanguage,
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
import type { Contact } from "../connections/lookup.js";
import type { EmployerRelation } from "../matching/employer.js";

export interface TelegramIdentity {
  telegramUserId: number;
  chatId: number;
  displayName?: string;
  locale?: string;
}

export interface UserSession {
  userId: string;
  hasProfile: boolean;
  /** Null until the user picks a language. */
  language: ConversationLanguage | null;
  /** True for an onboarded user who never picked a language and was not asked yet. */
  languagePromptDue: boolean;
}

export interface MatchSummary {
  matchId: string;
  title: string;
  company: string | null;
  location: string | null;
  recommendation: MatchRecommendation | null;
  explanation: string | null;
  employerRelation: EmployerRelation | null;
  /** How many of the user's contacts work at the company. */
  connectionCount: number;
}

/** How a job reached us, from the user's point of view; another user's saved sites count as web search. */
export type JobOrigin = "board" | "user_site" | "web_search" | "user_link";

export interface JobProvenance {
  origin: JobOrigin;
  /** The board source's name, e.g. "Greenhouse job boards". */
  sourceName: string;
  /** When any copy of the job was first collected. */
  firstCollectedAt: Date;
  /** Other URLs where the same job is posted. */
  otherUrls: string[];
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
  /** The most relevant contacts at the company, best first. */
  contacts: Contact[];
  connectionsImportedAt: Date | null;
  provenance: JobProvenance;
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
  | { kind: "ask_language" }
  | { kind: "language_saved"; language: ConversationLanguage }
  | { kind: "onboarding_welcome" }
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

export type CvRequestOutcome =
  | { kind: "requested"; versionId: string }
  | { kind: "in_progress" }
  | { kind: "draft"; versionId: string }
  | { kind: "not_found" };

export interface CvDraftView {
  versionId: string;
  jobTitle: string;
  company: string | null;
  summary: string[];
  experiences: { title: string; employer: string; startDate: string | null; endDate: string | null; isCurrent: boolean; bullets: string[] }[];
  skills: string[];
  education: string[];
  certifications: string[];
  languages: string[];
  other: string[];
  applicationNote: string | null;
}

export type CvDocumentFile =
  | { kind: "cached"; fileRef: string; fileName: string }
  | { kind: "rendered"; data: Uint8Array; fileName: string };

export type CvTailorOutcome = { kind: "draft"; draft: CvDraftView } | { kind: "failed" } | { kind: "not_found" };
export type CvDecision = "approved" | "discarded" | "not_found";

export interface UserService {
  ensureUser(identity: TelegramIdentity): Promise<UserSession>;
  /** Records that the user was asked for a language; false when they were asked before or already chose one. */
  claimLanguagePrompt(userId: string): Promise<boolean>;
}

export interface OnboardingService {
  start(userId: string): Promise<ProfileReply[]>;
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
  /** Opens a CV request for the match, or reports the open one; a request stuck for too long is failed and replaced. */
  requestTailored(userId: string, matchId: string): Promise<CvRequestOutcome>;
  /** Generates the tailored draft for a `requested` version. */
  tailor(userId: string, versionId: string): Promise<CvTailorOutcome>;
  draft(userId: string, versionId: string): Promise<CvDraftView | null>;
  decide(userId: string, versionId: string, approve: boolean): Promise<CvDecision>;
  /** The approved version as a DOCX: the stored Telegram file when it was sent before, otherwise freshly rendered. */
  document(userId: string, versionId: string): Promise<CvDocumentFile | null>;
  /** Remembers the Telegram file of a sent document so it is reused instead of re-rendered. */
  saveDocumentRef(userId: string, versionId: string, fileRef: string): Promise<void>;
}

export interface ConversationService {
  handleText(userId: string, text: string): Promise<ProfileReply[]>;
  applyEdit(userId: string, token: string): Promise<ProfileReply>;
  cancelEdit(userId: string, token: string): Promise<ProfileReply>;
  showProfile(userId: string): Promise<ProfileReply>;
  /** Saves the default conversation language without touching the profile, and resumes onboarding when it was waiting for it. */
  setLanguage(userId: string, language: ConversationLanguage): Promise<ProfileReply[]>;
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

export interface JobSiteView {
  id: string;
  domain: string;
  url: string;
}

export type AddSiteOutcome =
  | { kind: "added"; site: JobSiteView }
  | { kind: "exists"; site: JobSiteView }
  | { kind: "board"; board: string }
  | { kind: "invalid" }
  | { kind: "limit" };

export interface SiteService {
  list(userId: string): Promise<JobSiteView[]>;
  /** Saves a site to search; a supported ATS board link is added as a basic board source instead. */
  add(userId: string, input: string): Promise<AddSiteOutcome>;
  remove(userId: string, siteId: string): Promise<boolean>;
}

export interface SourceCoverage {
  jobs: number;
  /** Companies with no job collected before the window. */
  newCompanies: number;
}

export interface BoardSourceView {
  name: string;
  enabled: boolean;
  /** Company name, or the board token when the company is unknown. */
  boards: string[];
  lastCollectedAt: Date | null;
}

export type SourceIssue =
  | { kind: "turned_off"; source: string }
  | { kind: "unreachable_boards"; source: string; boards: string[] }
  | { kind: "collection_failed"; source: string }
  | { kind: "search_failed" }
  | { kind: "user_search_failed" };

export interface SourcesOverview {
  coverageDays: number;
  boardSources: BoardSourceView[];
  boardCoverage: SourceCoverage;
  webSearch: { enabled: boolean; lastSearchedAt: Date | null; coverage: SourceCoverage };
  sites: JobSiteView[];
  siteCoverage: SourceCoverage;
  /** Problems seen in the latest finished pipeline run, plus sources that are turned off. */
  issues: SourceIssue[];
}

export interface SourceService {
  overview(userId: string): Promise<SourcesOverview>;
}

export type ConnectionImport =
  | { kind: "imported"; contacts: number; companies: number; skipped: number }
  | { kind: "not_connections" }
  | { kind: "empty" };

export interface ConnectionSummary {
  contacts: number;
  companies: number;
  importedAt: Date;
}

export interface ConnectionService {
  /** Replaces the user's contacts with those in a LinkedIn Connections.csv or export ZIP. */
  import(userId: string, file: { data: Uint8Array; fileName: string | null }): Promise<ConnectionImport>;
  summary(userId: string): Promise<ConnectionSummary | null>;
  /** Deletes all of the user's contacts; returns how many were deleted. */
  forget(userId: string): Promise<number>;
}

export interface StatsService {
  /** Operator report for the last `days` days, formatted for Telegram. */
  report(days: number): Promise<string>;
}

export interface AppServices {
  users: UserService;
  onboarding: OnboardingService;
  matches: MatchService;
  feedback: FeedbackService;
  cv: CvService;
  conversation: ConversationService;
  sites: SiteService;
  sources: SourceService;
  stats: StatsService;
  connections: ConnectionService;
}
