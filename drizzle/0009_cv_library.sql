ALTER TYPE "public"."conversation_flow" ADD VALUE 'cv_library';--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "source_documents" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "source_documents_default_uq" ON "source_documents" USING btree ("user_id","language") WHERE "source_documents"."is_default";--> statement-breakpoint
ALTER TABLE "source_documents" ADD CONSTRAINT "source_documents_default_chk" CHECK (not "source_documents"."is_default" or ("source_documents"."kind" = 'cv' and "source_documents"."language" is not null and "source_documents"."removed_at" is null));