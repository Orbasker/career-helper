CREATE TYPE "public"."document_format" AS ENUM('pdf', 'docx', 'doc', 'txt', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('cv', 'linkedin_export');--> statement-breakpoint
CREATE TYPE "public"."document_parse_status" AS ENUM('parsed', 'failed', 'unsupported');--> statement-breakpoint
CREATE TABLE "source_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "document_kind",
	"file_name" text,
	"mime_type" text,
	"format" "document_format" NOT NULL,
	"file_ref" text NOT NULL,
	"size_bytes" integer,
	"language" text,
	"language_confirmed" boolean DEFAULT false NOT NULL,
	"extracted_text" text,
	"parse_status" "document_parse_status" NOT NULL,
	"parse_error" text,
	"label" text,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_documents_parsed_chk" CHECK (("source_documents"."parse_status" = 'parsed') = ("source_documents"."extracted_text" is not null and "source_documents"."kind" is not null)),
	CONSTRAINT "source_documents_error_chk" CHECK (("source_documents"."parse_status" = 'parsed') = ("source_documents"."parse_error" is null)),
	CONSTRAINT "source_documents_language_chk" CHECK (not "source_documents"."language_confirmed" or "source_documents"."language" is not null)
);--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_documents_user_idx" ON "source_documents" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "profile_sources" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "career_facts" ADD COLUMN "source_document_id" uuid;--> statement-breakpoint
ALTER TABLE "cv_versions" ADD COLUMN "source_document_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_sources" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "work_experiences" ADD COLUMN "source_document_id" uuid;--> statement-breakpoint
ALTER TABLE "career_facts" ADD CONSTRAINT "career_facts_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cv_versions" ADD CONSTRAINT "cv_versions_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_sources" ADD CONSTRAINT "profile_sources_document_id_source_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."source_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_experiences" ADD CONSTRAINT "work_experiences_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
INSERT INTO "source_documents" ("id", "user_id", "kind", "file_name", "format", "file_ref", "language", "extracted_text", "parse_status", "created_at", "updated_at")
SELECT ps."id", ps."user_id", ps."kind"::text::"document_kind", ps."file_name",
	CASE
		WHEN lower(ps."file_name") LIKE '%.pdf' THEN 'pdf'
		WHEN lower(ps."file_name") LIKE '%.docx' THEN 'docx'
		WHEN lower(ps."file_name") LIKE '%.doc' THEN 'doc'
		WHEN lower(ps."file_name") LIKE '%.txt' OR lower(ps."file_name") LIKE '%.md' THEN 'txt'
		ELSE 'other'
	END::"document_format",
	ps."file_ref",
	CASE
		WHEN letters."hebrew" > 0.3 * (letters."hebrew" + letters."latin") THEN 'he'
		WHEN letters."latin" > 0 THEN 'en'
	END,
	ps."content", 'parsed', ps."created_at", ps."created_at"
FROM "profile_sources" ps
CROSS JOIN LATERAL (
	SELECT length(regexp_replace(ps."content", '[^א-ת]', '', 'g')) AS "hebrew",
		length(regexp_replace(ps."content", '[^A-Za-z]', '', 'g')) AS "latin"
) letters
WHERE ps."file_ref" IS NOT NULL AND ps."kind" <> 'pasted_text';--> statement-breakpoint
UPDATE "profile_sources" SET "document_id" = "id", "content" = NULL WHERE "file_ref" IS NOT NULL AND "kind" <> 'pasted_text';--> statement-breakpoint
INSERT INTO "source_documents" ("id", "user_id", "kind", "format", "file_ref", "language", "extracted_text", "parse_status", "created_at", "updated_at")
SELECT mc."id", mc."user_id", 'cv', 'other', mc."original_file_ref",
	CASE
		WHEN letters."hebrew" > 0.3 * (letters."hebrew" + letters."latin") THEN 'he'
		WHEN letters."latin" > 0 THEN 'en'
	END,
	mc."original_text", 'parsed', mc."created_at", mc."updated_at"
FROM "master_cvs" mc
CROSS JOIN LATERAL (
	SELECT length(regexp_replace(mc."original_text", '[^א-ת]', '', 'g')) AS "hebrew",
		length(regexp_replace(mc."original_text", '[^A-Za-z]', '', 'g')) AS "latin"
) letters
WHERE mc."original_file_ref" IS NOT NULL AND mc."original_text" IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM "source_documents" d WHERE d."user_id" = mc."user_id" AND d."file_ref" = mc."original_file_ref"
	);--> statement-breakpoint
UPDATE "cv_versions" v SET "source_document_id" = (
	SELECT d."id" FROM "source_documents" d
	WHERE d."user_id" = mc."user_id" AND d."file_ref" = mc."original_file_ref"
	ORDER BY d."created_at" DESC LIMIT 1
)
FROM "master_cvs" mc
WHERE v."master_cv_id" = mc."id";--> statement-breakpoint
CREATE TEMPORARY TABLE "only_documents" AS
SELECT "user_id", "kind", (array_agg("id"))[1] AS "id"
FROM "source_documents"
WHERE "parse_status" = 'parsed'
GROUP BY "user_id", "kind"
HAVING count(*) = 1;--> statement-breakpoint
UPDATE "career_facts" f SET "source_document_id" = d."id"
FROM "only_documents" d
WHERE f."user_id" = d."user_id"
	AND ((f."origin" = 'cv_upload' AND d."kind" = 'cv') OR (f."origin" = 'linkedin_import' AND d."kind" = 'linkedin_export'));--> statement-breakpoint
UPDATE "work_experiences" e SET "source_document_id" = d."id"
FROM "only_documents" d
WHERE e."user_id" = d."user_id"
	AND ((e."origin" = 'cv_upload' AND d."kind" = 'cv') OR (e."origin" = 'linkedin_import' AND d."kind" = 'linkedin_export'));--> statement-breakpoint
DROP TABLE "only_documents";--> statement-breakpoint
ALTER TABLE "cv_versions" DROP CONSTRAINT "cv_versions_master_cv_id_master_cvs_id_fk";--> statement-breakpoint
ALTER TABLE "cv_versions" DROP COLUMN "master_cv_id";--> statement-breakpoint
ALTER TABLE "profile_sources" DROP COLUMN "file_ref";--> statement-breakpoint
ALTER TABLE "profile_sources" DROP COLUMN "file_name";--> statement-breakpoint
DROP TABLE "master_cvs" CASCADE;--> statement-breakpoint
ALTER TABLE "profile_sources" ADD CONSTRAINT "profile_sources_content_chk" CHECK (("profile_sources"."document_id" is null) = ("profile_sources"."content" is not null));
