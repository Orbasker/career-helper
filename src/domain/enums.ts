export const WORK_MODES = ["onsite", "hybrid", "remote"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "contract",
  "temporary",
  "internship",
  "freelance",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const SENIORITY_LEVELS = [
  "entry",
  "junior",
  "mid",
  "senior",
  "lead",
  "manager",
  "director",
  "executive",
] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

export const PROFILE_STATUSES = ["draft", "confirmed"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const VERIFICATION_STATUSES = ["unverified", "verified", "rejected"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const FACT_ORIGINS = ["cv_upload", "linkedin_import", "conversation", "manual_edit"] as const;
export type FactOrigin = (typeof FACT_ORIGINS)[number];

export const CAREER_FACT_KINDS = [
  "responsibility",
  "achievement",
  "skill",
  "education",
  "certification",
  "language",
  "other",
] as const;
export type CareerFactKind = (typeof CAREER_FACT_KINDS)[number];

export const PROFILE_SOURCE_KINDS = ["cv", "linkedin_export", "pasted_text"] as const;
export type ProfileSourceKind = (typeof PROFILE_SOURCE_KINDS)[number];

export const DOCUMENT_KINDS = ["cv", "linkedin_export"] as const satisfies readonly ProfileSourceKind[];
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_FORMATS = ["pdf", "docx", "doc", "txt", "other"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const DOCUMENT_PARSE_STATUSES = ["parsed", "failed", "unsupported"] as const;
export type DocumentParseStatus = (typeof DOCUMENT_PARSE_STATUSES)[number];

export const PREFERENCE_KINDS = ["hard_constraint", "soft_preference", "dislike", "target_role"] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

export const PREFERENCE_DIMENSIONS = [
  "location",
  "commute",
  "work_mode",
  "employment_type",
  "compensation",
  "role",
  "industry",
  "company",
  "seniority",
  "other",
] as const;
export type PreferenceDimension = (typeof PREFERENCE_DIMENSIONS)[number];

export const PREFERENCE_STATUSES = ["proposed", "active", "rejected", "superseded", "retired"] as const;
export type PreferenceStatus = (typeof PREFERENCE_STATUSES)[number];

export const PREFERENCE_ORIGINS = ["onboarding", "user_stated", "inferred_from_feedback"] as const;
export type PreferenceOrigin = (typeof PREFERENCE_ORIGINS)[number];

export const JOB_SOURCE_KINDS = ["api", "rss", "scraper", "manual", "web_search"] as const;
export type JobSourceKind = (typeof JOB_SOURCE_KINDS)[number];

export const DEDUP_METHODS = ["deterministic_key", "similarity", "manual"] as const;
export type DedupMethod = (typeof DEDUP_METHODS)[number];

export const MATCH_STAGES = ["hard_filter", "cheap_relevance", "deep_match"] as const;
export type MatchStage = (typeof MATCH_STAGES)[number];

export const STAGE_OUTCOMES = ["passed", "rejected"] as const;
export type StageOutcome = (typeof STAGE_OUTCOMES)[number];

export const MATCH_STATUSES = ["pending", "filtered_out", "ready", "notified", "dismissed"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const MATCH_RECOMMENDATIONS = ["strong_fit", "good_fit", "stretch", "not_recommended"] as const;
export type MatchRecommendation = (typeof MATCH_RECOMMENDATIONS)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const FEEDBACK_VERDICTS = ["interested", "not_interested"] as const;
export type FeedbackVerdict = (typeof FEEDBACK_VERDICTS)[number];

export const CV_VERSION_STATUSES = ["requested", "draft", "approved", "rejected", "failed"] as const;
export type CvVersionStatus = (typeof CV_VERSION_STATUSES)[number];

export const CV_SECTIONS = ["summary", "experience", "skills", "education", "certifications", "languages", "other"] as const;
export type CvSection = (typeof CV_SECTIONS)[number];

export const CV_LANGUAGE_SOURCES = ["requested", "job", "cv", "conversation"] as const;
export type CvLanguageSource = (typeof CV_LANGUAGE_SOURCES)[number];

export const CV_FILE_FORMATS = ["docx", "pdf"] as const;
export type CvFileFormat = (typeof CV_FILE_FORMATS)[number];

export const CONVERSATION_FLOWS = ["idle", "onboarding", "preference_update", "profile_edit", "cv_request"] as const;
export type ConversationFlow = (typeof CONVERSATION_FLOWS)[number];

export const CONVERSATION_LANGUAGES = ["en", "he"] as const;
export type ConversationLanguage = (typeof CONVERSATION_LANGUAGES)[number];
