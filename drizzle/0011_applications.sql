CREATE TYPE "public"."application_event_kind" AS ENUM('status_changed', 'note_added', 'cv_linked');--> statement-breakpoint
CREATE TYPE "public"."application_event_source" AS ENUM('user', 'email', 'system');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('applied', 'screening', 'interviewing', 'offer', 'rejected', 'withdrawn', 'no_response');--> statement-breakpoint
ALTER TYPE "public"."conversation_flow" ADD VALUE 'application';--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"kind" "application_event_kind" NOT NULL,
	"from_status" "application_status",
	"to_status" "application_status",
	"note" text,
	"cv_version_id" uuid,
	"source" "application_event_source" NOT NULL,
	"evidence_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_events_status_chk" CHECK (("application_events"."kind" = 'status_changed') = ("application_events"."to_status" is not null)),
	CONSTRAINT "application_events_note_chk" CHECK (("application_events"."kind" = 'note_added') = ("application_events"."note" is not null))
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"match_id" uuid,
	"duplicate_group_id" uuid,
	"company" text,
	"title" text NOT NULL,
	"normalized_company" text,
	"normalized_title" text,
	"source_url" text,
	"cv_version_id" uuid,
	"status" "application_status" DEFAULT 'applied' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_cv_version_id_cv_versions_id_fk" FOREIGN KEY ("cv_version_id") REFERENCES "public"."cv_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_duplicate_group_id_duplicate_groups_id_fk" FOREIGN KEY ("duplicate_group_id") REFERENCES "public"."duplicate_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_cv_version_id_cv_versions_id_fk" FOREIGN KEY ("cv_version_id") REFERENCES "public"."cv_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_events_application_idx" ON "application_events" USING btree ("application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_user_group_uq" ON "applications" USING btree ("user_id","duplicate_group_id") WHERE "applications"."duplicate_group_id" is not null;--> statement-breakpoint
CREATE INDEX "applications_user_status_idx" ON "applications" USING btree ("user_id","status","last_event_at");--> statement-breakpoint
CREATE INDEX "applications_user_job_key_idx" ON "applications" USING btree ("user_id","normalized_company","normalized_title");