ALTER TABLE "agent_run" DROP CONSTRAINT "agent_run_trigger_check";--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "intake_item_id" integer;--> statement-breakpoint
ALTER TABLE "intake_item" ADD COLUMN "classification" text;--> statement-breakpoint
ALTER TABLE "intake_item" ADD COLUMN "draft" jsonb;--> statement-breakpoint
ALTER TABLE "intake_item" ADD COLUMN "issue_id" integer;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_intake_item_id_intake_item_id_fk" FOREIGN KEY ("intake_item_id") REFERENCES "public"."intake_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_item" ADD CONSTRAINT "intake_item_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_intake_item_idx" ON "agent_run" USING btree ("intake_item_id") WHERE "agent_run"."intake_item_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_trigger_check" CHECK ("agent_run"."trigger" IN ('mention', 'delegation', 'field', 'schedule', 'manual', 'status', 'event', 'mail_triage'));--> statement-breakpoint
ALTER TABLE "intake_item" ADD CONSTRAINT "intake_item_classification_check" CHECK ("intake_item"."classification" IN ('bug', 'feature', 'question', 'no_ticket', 'spam'));