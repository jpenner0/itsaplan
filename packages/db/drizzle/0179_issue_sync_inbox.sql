CREATE TABLE "issue_sync_inbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"managed_repository_id" integer NOT NULL,
	"delivery_id" text,
	"external_number" integer NOT NULL,
	"event" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_sync_inbox_delivery_uq" UNIQUE("managed_repository_id","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "issue_sync_inbox" ADD CONSTRAINT "issue_sync_inbox_managed_repository_id_git_managed_repository_id_fk" FOREIGN KEY ("managed_repository_id") REFERENCES "public"."git_managed_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_sync_inbox_due_idx" ON "issue_sync_inbox" USING btree ("next_attempt_at");