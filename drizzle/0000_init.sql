CREATE TYPE "public"."career_fact_kind" AS ENUM('responsibility', 'achievement', 'skill', 'education', 'certification', 'language', 'other');--> statement-breakpoint
CREATE TYPE "public"."confidence_level" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."conversation_flow" AS ENUM('idle', 'onboarding', 'preference_update', 'cv_request');--> statement-breakpoint
CREATE TYPE "public"."cv_section" AS ENUM('summary', 'experience', 'skills', 'education', 'certifications', 'languages', 'other');--> statement-breakpoint
CREATE TYPE "public"."cv_version_status" AS ENUM('requested', 'draft', 'approved', 'rejected', 'failed');--> statement-breakpoint
CREATE TYPE "public"."dedup_method" AS ENUM('deterministic_key', 'similarity', 'manual');--> statement-breakpoint
CREATE TYPE "public"."employment_type" AS ENUM('full_time', 'part_time', 'contract', 'temporary', 'internship', 'freelance');--> statement-breakpoint
CREATE TYPE "public"."fact_origin" AS ENUM('cv_upload', 'conversation', 'manual_edit');--> statement-breakpoint
CREATE TYPE "public"."feedback_verdict" AS ENUM('interested', 'not_interested');--> statement-breakpoint
CREATE TYPE "public"."job_source_kind" AS ENUM('api', 'rss', 'scraper', 'manual');--> statement-breakpoint
CREATE TYPE "public"."match_recommendation" AS ENUM('strong_fit', 'good_fit', 'stretch', 'not_recommended');--> statement-breakpoint
CREATE TYPE "public"."match_stage" AS ENUM('hard_filter', 'cheap_relevance', 'deep_match');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('pending', 'filtered_out', 'ready', 'notified', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."preference_dimension" AS ENUM('location', 'commute', 'work_mode', 'employment_type', 'compensation', 'role', 'industry', 'company', 'seniority', 'other');--> statement-breakpoint
CREATE TYPE "public"."preference_kind" AS ENUM('hard_constraint', 'soft_preference', 'dislike', 'target_role');--> statement-breakpoint
CREATE TYPE "public"."preference_origin" AS ENUM('onboarding', 'user_stated', 'inferred_from_feedback');--> statement-breakpoint
CREATE TYPE "public"."preference_status" AS ENUM('proposed', 'active', 'rejected', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('draft', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."seniority_level" AS ENUM('entry', 'junior', 'mid', 'senior', 'lead', 'manager', 'director', 'executive');--> statement-breakpoint
CREATE TYPE "public"."stage_outcome" AS ENUM('passed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('unverified', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."work_mode" AS ENUM('onsite', 'hybrid', 'remote');--> statement-breakpoint
CREATE TABLE "career_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"work_experience_id" uuid,
	"kind" "career_fact_kind" NOT NULL,
	"statement" text NOT NULL,
	"metrics" jsonb,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"origin" "fact_origin" NOT NULL,
	"source_reference" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_facts_verified_at_chk" CHECK (("career_facts"."verification_status" = 'verified') = ("career_facts"."verified_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "career_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "profile_status" DEFAULT 'draft' NOT NULL,
	"headline" text,
	"summary" text,
	"current_seniority" "seniority_level",
	"management_scope" text,
	"open_to_adjacent_roles" boolean DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "career_profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_states" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"flow" "conversation_flow" DEFAULT 'idle' NOT NULL,
	"step" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cv_version_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cv_version_id" uuid NOT NULL,
	"career_fact_id" uuid NOT NULL,
	"section" "cv_section" NOT NULL,
	"position" integer NOT NULL,
	"generated_text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cv_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"master_cv_id" uuid,
	"match_id" uuid,
	"job_id" uuid,
	"status" "cv_version_status" DEFAULT 'requested' NOT NULL,
	"application_note" text,
	"profile_revision" integer,
	"model" text,
	"prompt_version" text,
	"rendered_file_ref" text,
	"failure_reason" text,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duplicate_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedup_key" text,
	"canonical_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "duplicate_groups_dedup_key_unique" UNIQUE("dedup_key")
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"match_id" uuid NOT NULL,
	"verdict" "feedback_verdict" NOT NULL,
	"reason" text,
	"reason_tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" "job_source_kind" NOT NULL,
	"base_url" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_collected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_sources_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"raw_record_id" uuid NOT NULL,
	"external_id" text,
	"source_url" text NOT NULL,
	"title" text NOT NULL,
	"company" text,
	"description" text NOT NULL,
	"location" text,
	"work_mode" "work_mode",
	"employment_type" "employment_type",
	"published_at" timestamp with time zone,
	"collected_at" timestamp with time zone NOT NULL,
	"normalized_title" text,
	"normalized_company" text,
	"normalized_location" text,
	"duplicate_group_id" uuid,
	"dedup_method" "dedup_method",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_dedup_consistency_chk" CHECK (("jobs"."duplicate_group_id" is null) = ("jobs"."dedup_method" is null))
);
--> statement-breakpoint
CREATE TABLE "master_cvs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"original_file_ref" text,
	"original_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "master_cvs_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "match_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"stage" "match_stage" NOT NULL,
	"outcome" "stage_outcome" NOT NULL,
	"score" real,
	"recommendation" "match_recommendation",
	"confidence" "confidence_level",
	"explanation" text,
	"evidence" jsonb,
	"profile_revision" integer NOT NULL,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"duplicate_group_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"status" "match_status" DEFAULT 'pending' NOT NULL,
	"stage_reached" "match_stage",
	"relevance_score" real,
	"recommendation" "match_recommendation",
	"confidence" "confidence_level",
	"explanation" text,
	"notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_notified_chk" CHECK ("matches"."status" <> 'notified' or "matches"."notified_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "preference_evidence" (
	"preference_id" uuid NOT NULL,
	"feedback_id" uuid NOT NULL,
	CONSTRAINT "preference_evidence_preference_id_feedback_id_pk" PRIMARY KEY("preference_id","feedback_id")
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "preference_kind" NOT NULL,
	"dimension" "preference_dimension" NOT NULL,
	"value" jsonb NOT NULL,
	"label" text NOT NULL,
	"weight" smallint DEFAULT 1 NOT NULL,
	"status" "preference_status" DEFAULT 'proposed' NOT NULL,
	"origin" "preference_origin" NOT NULL,
	"rationale" text,
	"supersedes_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preferences_weight_chk" CHECK ("preferences"."weight" between -3 and 3),
	CONSTRAINT "preferences_inferred_requires_confirmation_chk" CHECK (not ("preferences"."origin" = 'inferred_from_feedback' and "preferences"."status" = 'active' and "preferences"."decided_at" is null))
);
--> statement-breakpoint
CREATE TABLE "raw_job_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text,
	"source_url" text NOT NULL,
	"content_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"telegram_chat_id" bigint NOT NULL,
	"display_name" text,
	"locale" text,
	"timezone" text DEFAULT 'Asia/Jerusalem' NOT NULL,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_telegram_user_id_unique" UNIQUE("telegram_user_id")
);
--> statement-breakpoint
CREATE TABLE "work_experiences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"employer" text NOT NULL,
	"title" text NOT NULL,
	"industry" text,
	"location" text,
	"seniority" "seniority_level",
	"managed_headcount" integer,
	"start_date" date,
	"end_date" date,
	"is_current" boolean DEFAULT false NOT NULL,
	"verification_status" "verification_status" DEFAULT 'unverified' NOT NULL,
	"origin" "fact_origin" NOT NULL,
	"source_reference" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_experiences_dates_chk" CHECK ("work_experiences"."end_date" is null or "work_experiences"."start_date" is null or "work_experiences"."end_date" >= "work_experiences"."start_date"),
	CONSTRAINT "work_experiences_current_chk" CHECK (not ("work_experiences"."is_current" and "work_experiences"."end_date" is not null)),
	CONSTRAINT "work_experiences_verified_at_chk" CHECK (("work_experiences"."verification_status" = 'verified') = ("work_experiences"."verified_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "career_facts" ADD CONSTRAINT "career_facts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_facts" ADD CONSTRAINT "career_facts_work_experience_id_work_experiences_id_fk" FOREIGN KEY ("work_experience_id") REFERENCES "public"."work_experiences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_profiles" ADD CONSTRAINT "career_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_states" ADD CONSTRAINT "conversation_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_version_items" ADD CONSTRAINT "cv_version_items_cv_version_id_cv_versions_id_fk" FOREIGN KEY ("cv_version_id") REFERENCES "public"."cv_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_version_items" ADD CONSTRAINT "cv_version_items_career_fact_id_career_facts_id_fk" FOREIGN KEY ("career_fact_id") REFERENCES "public"."career_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_versions" ADD CONSTRAINT "cv_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_versions" ADD CONSTRAINT "cv_versions_master_cv_id_master_cvs_id_fk" FOREIGN KEY ("master_cv_id") REFERENCES "public"."master_cvs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_versions" ADD CONSTRAINT "cv_versions_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_versions" ADD CONSTRAINT "cv_versions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_groups" ADD CONSTRAINT "duplicate_groups_canonical_job_id_jobs_id_fk" FOREIGN KEY ("canonical_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_raw_record_id_raw_job_records_id_fk" FOREIGN KEY ("raw_record_id") REFERENCES "public"."raw_job_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_duplicate_group_id_duplicate_groups_id_fk" FOREIGN KEY ("duplicate_group_id") REFERENCES "public"."duplicate_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "master_cvs" ADD CONSTRAINT "master_cvs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_evaluations" ADD CONSTRAINT "match_evaluations_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_duplicate_group_id_duplicate_groups_id_fk" FOREIGN KEY ("duplicate_group_id") REFERENCES "public"."duplicate_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_evidence" ADD CONSTRAINT "preference_evidence_preference_id_preferences_id_fk" FOREIGN KEY ("preference_id") REFERENCES "public"."preferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preference_evidence" ADD CONSTRAINT "preference_evidence_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "public"."feedback"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_supersedes_id_preferences_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."preferences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_job_records" ADD CONSTRAINT "raw_job_records_source_id_job_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."job_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_experiences" ADD CONSTRAINT "work_experiences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "career_facts_user_idx" ON "career_facts" USING btree ("user_id","verification_status");--> statement-breakpoint
CREATE INDEX "career_facts_work_experience_idx" ON "career_facts" USING btree ("work_experience_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cv_version_items_position_uq" ON "cv_version_items" USING btree ("cv_version_id","section","position");--> statement-breakpoint
CREATE INDEX "cv_versions_user_idx" ON "cv_versions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cv_versions_open_request_uq" ON "cv_versions" USING btree ("user_id","match_id") WHERE "cv_versions"."status" in ('requested', 'draft');--> statement-breakpoint
CREATE INDEX "feedback_user_idx" ON "feedback" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_match_idx" ON "feedback" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_external_uq" ON "jobs" USING btree ("source_id","external_id") WHERE "jobs"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_source_url_uq" ON "jobs" USING btree ("source_id","source_url");--> statement-breakpoint
CREATE INDEX "jobs_duplicate_group_idx" ON "jobs" USING btree ("duplicate_group_id");--> statement-breakpoint
CREATE INDEX "jobs_collected_at_idx" ON "jobs" USING btree ("collected_at");--> statement-breakpoint
CREATE INDEX "match_evaluations_match_idx" ON "match_evaluations" USING btree ("match_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_user_group_uq" ON "matches" USING btree ("user_id","duplicate_group_id");--> statement-breakpoint
CREATE INDEX "matches_user_status_idx" ON "matches" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "preferences_user_status_idx" ON "preferences" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_job_records_source_hash_uq" ON "raw_job_records" USING btree ("source_id","content_hash");--> statement-breakpoint
CREATE INDEX "work_experiences_user_idx" ON "work_experiences" USING btree ("user_id");