import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  CAREER_FACT_KINDS,
  CONFIDENCE_LEVELS,
  CONVERSATION_FLOWS,
  CONVERSATION_LANGUAGES,
  CV_FILE_FORMATS,
  CV_LANGUAGE_SOURCES,
  CV_SECTIONS,
  CV_VERSION_STATUSES,
  DEDUP_METHODS,
  DOCUMENT_FORMATS,
  DOCUMENT_KINDS,
  DOCUMENT_PARSE_STATUSES,
  EMPLOYMENT_TYPES,
  FACT_ORIGINS,
  FEEDBACK_VERDICTS,
  JOB_SOURCE_KINDS,
  MATCH_RECOMMENDATIONS,
  MATCH_STAGES,
  MATCH_STATUSES,
  PREFERENCE_DIMENSIONS,
  PREFERENCE_KINDS,
  PREFERENCE_ORIGINS,
  PREFERENCE_STATUSES,
  PROFILE_SOURCE_KINDS,
  PROFILE_STATUSES,
  SENIORITY_LEVELS,
  STAGE_OUTCOMES,
  VERIFICATION_STATUSES,
  WORK_MODES,
} from "../domain/enums.js";
import type { MatchEvidence, PreferenceValue } from "../domain/types.js";

export const workMode = pgEnum("work_mode", WORK_MODES);
export const employmentType = pgEnum("employment_type", EMPLOYMENT_TYPES);
export const seniorityLevel = pgEnum("seniority_level", SENIORITY_LEVELS);
export const profileStatus = pgEnum("profile_status", PROFILE_STATUSES);
export const profileSourceKind = pgEnum("profile_source_kind", PROFILE_SOURCE_KINDS);
export const documentKind = pgEnum("document_kind", DOCUMENT_KINDS);
export const documentFormat = pgEnum("document_format", DOCUMENT_FORMATS);
export const documentParseStatus = pgEnum("document_parse_status", DOCUMENT_PARSE_STATUSES);
export const verificationStatus = pgEnum("verification_status", VERIFICATION_STATUSES);
export const factOrigin = pgEnum("fact_origin", FACT_ORIGINS);
export const careerFactKind = pgEnum("career_fact_kind", CAREER_FACT_KINDS);
export const preferenceKind = pgEnum("preference_kind", PREFERENCE_KINDS);
export const preferenceDimension = pgEnum("preference_dimension", PREFERENCE_DIMENSIONS);
export const preferenceStatus = pgEnum("preference_status", PREFERENCE_STATUSES);
export const preferenceOrigin = pgEnum("preference_origin", PREFERENCE_ORIGINS);
export const jobSourceKind = pgEnum("job_source_kind", JOB_SOURCE_KINDS);
export const dedupMethod = pgEnum("dedup_method", DEDUP_METHODS);
export const matchStage = pgEnum("match_stage", MATCH_STAGES);
export const stageOutcome = pgEnum("stage_outcome", STAGE_OUTCOMES);
export const matchStatus = pgEnum("match_status", MATCH_STATUSES);
export const matchRecommendation = pgEnum("match_recommendation", MATCH_RECOMMENDATIONS);
export const confidenceLevel = pgEnum("confidence_level", CONFIDENCE_LEVELS);
export const feedbackVerdict = pgEnum("feedback_verdict", FEEDBACK_VERDICTS);
export const cvVersionStatus = pgEnum("cv_version_status", CV_VERSION_STATUSES);
export const cvSection = pgEnum("cv_section", CV_SECTIONS);
export const cvLanguageSource = pgEnum("cv_language_source", CV_LANGUAGE_SOURCES);
export const cvFileFormat = pgEnum("cv_file_format", CV_FILE_FORMATS);
export const conversationFlow = pgEnum("conversation_flow", CONVERSATION_FLOWS);
export const conversationLanguage = pgEnum("conversation_language", CONVERSATION_LANGUAGES);

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const users = pgTable("users", {
  id: id(),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull().unique(),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
  displayName: text("display_name"),
  locale: text("locale"),
  /** Null until the user picks a language; the bot then uses English. */
  preferredLanguage: conversationLanguage("preferred_language"),
  languagePromptedAt: timestamp("language_prompted_at", { withTimezone: true }),
  timezone: text("timezone").notNull().default("Asia/Jerusalem"),
  notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const careerProfiles = pgTable("career_profiles", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  status: profileStatus("status").notNull().default("draft"),
  headline: text("headline"),
  summary: text("summary"),
  currentSeniority: seniorityLevel("current_seniority"),
  managementScope: text("management_scope"),
  linkedinUrl: text("linkedin_url"),
  openToAdjacentRoles: boolean("open_to_adjacent_roles").notNull().default(true),
  revision: integer("revision").notNull().default(1),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sourceDocuments = pgTable(
  "source_documents",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: documentKind("kind"),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    format: documentFormat("format").notNull(),
    fileRef: text("file_ref").notNull(),
    sizeBytes: integer("size_bytes"),
    language: text("language"),
    languageConfirmed: boolean("language_confirmed").notNull().default(false),
    extractedText: text("extracted_text"),
    parseStatus: documentParseStatus("parse_status").notNull(),
    parseError: text("parse_error"),
    label: text("label"),
    version: integer("version"),
    /** The user's chosen default CV for its language; without one the newest CV in that language is used. */
    isDefault: boolean("is_default").notNull().default(false),
    /** Removed documents are hidden from the user but kept, so facts and CVs can still cite them. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("source_documents_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("source_documents_default_uq").on(t.userId, t.language).where(sql`${t.isDefault}`),
    check(
      "source_documents_default_chk",
      sql`not ${t.isDefault} or (${t.kind} = 'cv' and ${t.language} is not null and ${t.removedAt} is null)`,
    ),
    check(
      "source_documents_parsed_chk",
      sql`(${t.parseStatus} = 'parsed') = (${t.extractedText} is not null and ${t.kind} is not null)`,
    ),
    check("source_documents_error_chk", sql`(${t.parseStatus} = 'parsed') = (${t.parseError} is null)`),
    check("source_documents_language_chk", sql`not ${t.languageConfirmed} or ${t.language} is not null`),
  ],
);

export const profileSources = pgTable(
  "profile_sources",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: profileSourceKind("kind").notNull(),
    documentId: uuid("document_id").references(() => sourceDocuments.id, { onDelete: "cascade" }),
    content: text("content"),
    createdAt: createdAt(),
  },
  (t) => [
    index("profile_sources_user_idx").on(t.userId, t.createdAt),
    check("profile_sources_content_chk", sql`(${t.documentId} is null) = (${t.content} is not null)`),
  ],
);

export const workExperiences = pgTable(
  "work_experiences",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    employer: text("employer").notNull(),
    title: text("title").notNull(),
    industry: text("industry"),
    location: text("location"),
    seniority: seniorityLevel("seniority"),
    managedHeadcount: integer("managed_headcount"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    isCurrent: boolean("is_current").notNull().default(false),
    verificationStatus: verificationStatus("verification_status").notNull().default("unverified"),
    origin: factOrigin("origin").notNull(),
    sourceReference: text("source_reference"),
    sourceDocumentId: uuid("source_document_id").references(() => sourceDocuments.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("work_experiences_user_idx").on(t.userId),
    check("work_experiences_dates_chk", sql`${t.endDate} is null or ${t.startDate} is null or ${t.endDate} >= ${t.startDate}`),
    check("work_experiences_current_chk", sql`not (${t.isCurrent} and ${t.endDate} is not null)`),
    check(
      "work_experiences_verified_at_chk",
      sql`(${t.verificationStatus} = 'verified') = (${t.verifiedAt} is not null)`,
    ),
  ],
);

export const careerFacts = pgTable(
  "career_facts",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workExperienceId: uuid("work_experience_id").references(() => workExperiences.id, { onDelete: "cascade" }),
    kind: careerFactKind("kind").notNull(),
    statement: text("statement").notNull(),
    metrics: jsonb("metrics").$type<Record<string, string | number>>(),
    verificationStatus: verificationStatus("verification_status").notNull().default("unverified"),
    origin: factOrigin("origin").notNull(),
    sourceReference: text("source_reference"),
    sourceDocumentId: uuid("source_document_id").references(() => sourceDocuments.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("career_facts_user_idx").on(t.userId, t.verificationStatus),
    index("career_facts_work_experience_idx").on(t.workExperienceId),
    check("career_facts_verified_at_chk", sql`(${t.verificationStatus} = 'verified') = (${t.verifiedAt} is not null)`),
  ],
);

export const preferences = pgTable(
  "preferences",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: preferenceKind("kind").notNull(),
    dimension: preferenceDimension("dimension").notNull(),
    value: jsonb("value").$type<PreferenceValue>().notNull(),
    label: text("label").notNull(),
    weight: smallint("weight").notNull().default(1),
    status: preferenceStatus("status").notNull().default("proposed"),
    origin: preferenceOrigin("origin").notNull(),
    rationale: text("rationale"),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => preferences.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("preferences_user_status_idx").on(t.userId, t.status),
    check("preferences_weight_chk", sql`${t.weight} between -3 and 3`),
    check(
      "preferences_inferred_requires_confirmation_chk",
      sql`not (${t.origin} = 'inferred_from_feedback' and ${t.status} = 'active' and ${t.decidedAt} is null)`,
    ),
  ],
);

export const jobSources = pgTable("job_sources", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  kind: jobSourceKind("kind").notNull(),
  baseUrl: text("base_url"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  lastCollectedAt: timestamp("last_collected_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const userJobSites = pgTable(
  "user_job_sites",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    url: text("url").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("user_job_sites_user_domain_uq").on(t.userId, t.domain)],
);

export const connections = pgTable(
  "connections",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    profileUrl: text("profile_url"),
    company: text("company"),
    normalizedCompany: text("normalized_company"),
    position: text("position"),
    connectedOn: date("connected_on"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("connections_user_company_idx").on(t.userId, t.normalizedCompany)],
);

export const rawJobRecords = pgTable(
  "raw_job_records",
  {
    id: id(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => jobSources.id),
    externalId: text("external_id"),
    sourceUrl: text("source_url").notNull(),
    contentHash: text("content_hash").notNull(),
    payload: jsonb("payload").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("raw_job_records_source_hash_uq").on(t.sourceId, t.contentHash)],
);

export const duplicateGroups = pgTable("duplicate_groups", {
  id: id(),
  dedupKey: text("dedup_key").unique(),
  canonicalJobId: uuid("canonical_job_id").references((): AnyPgColumn => jobs.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => jobSources.id),
    rawRecordId: uuid("raw_record_id")
      .notNull()
      .references(() => rawJobRecords.id),
    externalId: text("external_id"),
    sourceUrl: text("source_url").notNull(),
    title: text("title").notNull(),
    company: text("company"),
    description: text("description").notNull(),
    location: text("location"),
    workMode: workMode("work_mode"),
    employmentType: employmentType("employment_type"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    collectedAt: timestamp("collected_at", { withTimezone: true }).notNull(),
    normalizedTitle: text("normalized_title"),
    normalizedCompany: text("normalized_company"),
    normalizedLocation: text("normalized_location"),
    duplicateGroupId: uuid("duplicate_group_id").references(() => duplicateGroups.id),
    dedupMethod: dedupMethod("dedup_method"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("jobs_source_external_uq")
      .on(t.sourceId, t.externalId)
      .where(sql`${t.externalId} is not null`),
    uniqueIndex("jobs_source_url_uq").on(t.sourceId, t.sourceUrl),
    index("jobs_duplicate_group_idx").on(t.duplicateGroupId),
    index("jobs_collected_at_idx").on(t.collectedAt),
    index("jobs_normalized_key_idx").on(t.normalizedCompany, t.normalizedTitle, t.normalizedLocation),
    check("jobs_dedup_consistency_chk", sql`(${t.duplicateGroupId} is null) = (${t.dedupMethod} is null)`),
  ],
);

export const matches = pgTable(
  "matches",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    duplicateGroupId: uuid("duplicate_group_id")
      .notNull()
      .references(() => duplicateGroups.id),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id),
    status: matchStatus("status").notNull().default("pending"),
    stageReached: matchStage("stage_reached"),
    relevanceScore: real("relevance_score"),
    recommendation: matchRecommendation("recommendation"),
    confidence: confidenceLevel("confidence"),
    explanation: text("explanation"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("matches_user_group_uq").on(t.userId, t.duplicateGroupId),
    index("matches_user_status_idx").on(t.userId, t.status, t.createdAt),
    check("matches_notified_chk", sql`${t.status} <> 'notified' or ${t.notifiedAt} is not null`),
  ],
);

export const matchEvaluations = pgTable(
  "match_evaluations",
  {
    id: id(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    stage: matchStage("stage").notNull(),
    outcome: stageOutcome("outcome").notNull(),
    score: real("score"),
    recommendation: matchRecommendation("recommendation"),
    confidence: confidenceLevel("confidence"),
    explanation: text("explanation"),
    evidence: jsonb("evidence").$type<MatchEvidence>(),
    profileRevision: integer("profile_revision").notNull(),
    model: text("model"),
    promptVersion: text("prompt_version"),
    createdAt: createdAt(),
  },
  (t) => [index("match_evaluations_match_idx").on(t.matchId, t.createdAt)],
);

export const feedback = pgTable(
  "feedback",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    verdict: feedbackVerdict("verdict").notNull(),
    reason: text("reason"),
    reasonTags: text("reason_tags").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [index("feedback_user_idx").on(t.userId, t.createdAt), index("feedback_match_idx").on(t.matchId)],
);

export const preferenceEvidence = pgTable(
  "preference_evidence",
  {
    preferenceId: uuid("preference_id")
      .notNull()
      .references(() => preferences.id, { onDelete: "cascade" }),
    feedbackId: uuid("feedback_id")
      .notNull()
      .references(() => feedback.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.preferenceId, t.feedbackId] })],
);

export const cvVersions = pgTable(
  "cv_versions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceDocumentId: uuid("source_document_id").references(() => sourceDocuments.id, { onDelete: "set null" }),
    matchId: uuid("match_id").references(() => matches.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id),
    language: conversationLanguage("language").notNull(),
    /** Why `language` was chosen; null for versions created before languages were chosen. */
    languageSource: cvLanguageSource("language_source"),
    /** The version whose selection of facts this one keeps, when it was requested as another language of it. */
    basedOnVersionId: uuid("based_on_version_id").references((): AnyPgColumn => cvVersions.id, { onDelete: "set null" }),
    status: cvVersionStatus("status").notNull().default("requested"),
    applicationNote: text("application_note"),
    profileRevision: integer("profile_revision"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    failureReason: text("failure_reason"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("cv_versions_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("cv_versions_open_request_uq")
      .on(t.userId, t.matchId, t.language)
      .where(sql`${t.status} in ('requested', 'draft')`),
  ],
);

/** A rendered file of an approved version, stored as the Telegram file it was sent as so it is never rendered twice. */
export const cvVersionFiles = pgTable(
  "cv_version_files",
  {
    id: id(),
    cvVersionId: uuid("cv_version_id")
      .notNull()
      .references(() => cvVersions.id, { onDelete: "cascade" }),
    format: cvFileFormat("format").notNull(),
    fileRef: text("file_ref").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("cv_version_files_format_uq").on(t.cvVersionId, t.format)],
);

export const cvVersionItems = pgTable(
  "cv_version_items",
  {
    id: id(),
    cvVersionId: uuid("cv_version_id")
      .notNull()
      .references(() => cvVersions.id, { onDelete: "cascade" }),
    careerFactId: uuid("career_fact_id")
      .notNull()
      .references(() => careerFacts.id),
    section: cvSection("section").notNull(),
    position: integer("position").notNull(),
    generatedText: text("generated_text").notNull(),
  },
  (t) => [uniqueIndex("cv_version_items_position_uq").on(t.cvVersionId, t.section, t.position)],
);

export const modelCalls = pgTable(
  "model_calls",
  {
    id: id(),
    purpose: text("purpose").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms").notNull(),
    ok: boolean("ok").notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("model_calls_created_idx").on(t.createdAt, t.purpose)],
);

export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: id(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    failed: boolean("failed"),
    report: jsonb("report").$type<Record<string, unknown>>(),
  },
  (t) => [index("pipeline_runs_started_idx").on(t.startedAt)],
);

export const conversationStates = pgTable("conversation_states", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  flow: conversationFlow("flow").notNull().default("idle"),
  step: text("step"),
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});
