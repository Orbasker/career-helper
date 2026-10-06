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
  CV_SECTIONS,
  CV_VERSION_STATUSES,
  DEDUP_METHODS,
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
export const conversationFlow = pgEnum("conversation_flow", CONVERSATION_FLOWS);

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
  openToAdjacentRoles: boolean("open_to_adjacent_roles").notNull().default(true),
  revision: integer("revision").notNull().default(1),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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

export const masterCvs = pgTable("master_cvs", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  originalFileRef: text("original_file_ref"),
  originalText: text("original_text"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const cvVersions = pgTable(
  "cv_versions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    masterCvId: uuid("master_cv_id").references(() => masterCvs.id),
    matchId: uuid("match_id").references(() => matches.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id),
    status: cvVersionStatus("status").notNull().default("requested"),
    applicationNote: text("application_note"),
    profileRevision: integer("profile_revision"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    renderedFileRef: text("rendered_file_ref"),
    failureReason: text("failure_reason"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("cv_versions_user_idx").on(t.userId, t.createdAt),
    uniqueIndex("cv_versions_open_request_uq")
      .on(t.userId, t.matchId)
      .where(sql`${t.status} in ('requested', 'draft')`),
  ],
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
