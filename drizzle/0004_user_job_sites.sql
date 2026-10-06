ALTER TYPE "public"."job_source_kind" ADD VALUE 'web_search';--> statement-breakpoint
CREATE TABLE "user_job_sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_job_sites" ADD CONSTRAINT "user_job_sites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_job_sites_user_domain_uq" ON "user_job_sites" USING btree ("user_id","domain");