CREATE TYPE "public"."cv_file_format" AS ENUM('docx', 'pdf');--> statement-breakpoint
CREATE TYPE "public"."cv_language_source" AS ENUM('requested', 'job', 'cv', 'conversation');--> statement-breakpoint
CREATE TABLE "cv_version_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cv_version_id" uuid NOT NULL,
	"format" "cv_file_format" NOT NULL,
	"file_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "cv_versions_open_request_uq";--> statement-breakpoint
ALTER TABLE "cv_versions" ADD COLUMN "language" "conversation_language";--> statement-breakpoint
UPDATE "cv_versions" v SET "language" = CASE
	WHEN letters."hebrew" > 0.3 * (letters."hebrew" + letters."latin") THEN 'he'
	WHEN letters."latin" > 0 THEN 'en'
	ELSE coalesce(letters."preferred_language", 'en')
END::"conversation_language"
FROM (
	SELECT cv."id", u."preferred_language",
		coalesce(sum(length(regexp_replace(i."generated_text", '[^א-ת]', '', 'g'))), 0) AS "hebrew",
		coalesce(sum(length(regexp_replace(i."generated_text", '[^A-Za-z]', '', 'g'))), 0) AS "latin"
	FROM "cv_versions" cv
	JOIN "users" u ON u."id" = cv."user_id"
	LEFT JOIN "cv_version_items" i ON i."cv_version_id" = cv."id"
	GROUP BY cv."id", u."preferred_language"
) letters
WHERE letters."id" = v."id";--> statement-breakpoint
ALTER TABLE "cv_versions" ALTER COLUMN "language" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cv_versions" ADD COLUMN "language_source" "cv_language_source";--> statement-breakpoint
ALTER TABLE "cv_versions" ADD COLUMN "based_on_version_id" uuid;--> statement-breakpoint
ALTER TABLE "cv_version_files" ADD CONSTRAINT "cv_version_files_cv_version_id_cv_versions_id_fk" FOREIGN KEY ("cv_version_id") REFERENCES "public"."cv_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cv_version_files_format_uq" ON "cv_version_files" USING btree ("cv_version_id","format");--> statement-breakpoint
ALTER TABLE "cv_versions" ADD CONSTRAINT "cv_versions_based_on_version_id_cv_versions_id_fk" FOREIGN KEY ("based_on_version_id") REFERENCES "public"."cv_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cv_versions_open_request_uq" ON "cv_versions" USING btree ("user_id","match_id","language") WHERE "cv_versions"."status" in ('requested', 'draft');--> statement-breakpoint
INSERT INTO "cv_version_files" ("cv_version_id", "format", "file_ref")
SELECT "id", 'docx', "rendered_file_ref" FROM "cv_versions" WHERE "rendered_file_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "cv_versions" DROP COLUMN "rendered_file_ref";