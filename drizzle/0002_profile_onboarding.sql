CREATE TYPE "public"."profile_source_kind" AS ENUM('cv', 'linkedin_export', 'pasted_text');--> statement-breakpoint
ALTER TYPE "public"."conversation_flow" ADD VALUE 'profile_edit' BEFORE 'cv_request';--> statement-breakpoint
ALTER TYPE "public"."fact_origin" ADD VALUE 'linkedin_import' BEFORE 'conversation';--> statement-breakpoint
ALTER TYPE "public"."preference_status" ADD VALUE 'retired';--> statement-breakpoint
CREATE TABLE "profile_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "profile_source_kind" NOT NULL,
	"file_ref" text,
	"file_name" text,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "career_profiles" ADD COLUMN "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "profile_sources" ADD CONSTRAINT "profile_sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_sources_user_idx" ON "profile_sources" USING btree ("user_id","created_at");