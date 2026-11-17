ALTER TABLE "issue_moves" ADD COLUMN "leased_by" text;--> statement-breakpoint
ALTER TABLE "issue_moves" ADD COLUMN "leased_until" timestamp with time zone;