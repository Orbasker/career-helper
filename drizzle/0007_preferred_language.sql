CREATE TYPE "public"."conversation_language" AS ENUM('en', 'he');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_language" "conversation_language";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "language_prompted_at" timestamp with time zone;