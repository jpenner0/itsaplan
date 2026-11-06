CREATE TABLE "intake_item" (
	"id" serial PRIMARY KEY NOT NULL,
	"folder_id" integer NOT NULL,
	"message_id" text NOT NULL,
	"in_reply_to" text,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"from_name" text DEFAULT '' NOT NULL,
	"from_address" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"sent_at" timestamp with time zone,
	"body" text DEFAULT '' NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"classification" text,
	"draft" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"issue_id" integer,
	"reply_to_issue_id" integer,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_item_folder_id_message_id_unique" UNIQUE("folder_id","message_id"),
	CONSTRAINT "intake_item_status_check" CHECK ("intake_item"."status" IN ('new', 'accepted', 'rejected')),
	CONSTRAINT "intake_item_classification_check" CHECK ("intake_item"."classification" IN ('bug', 'feature', 'question', 'no_ticket', 'spam'))
);
--> statement-breakpoint
CREATE TABLE "mailbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 993 NOT NULL,
	"secure" boolean DEFAULT true NOT NULL,
	"auth" text DEFAULT 'password' NOT NULL,
	"username" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"redacted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_auth_check" CHECK ("mailbox"."auth" IN ('password', 'microsoft365'))
);
--> statement-breakpoint
CREATE TABLE "mailbox_folder" (
	"id" serial PRIMARY KEY NOT NULL,
	"mailbox_id" integer NOT NULL,
	"name" text NOT NULL,
	"team_id" integer NOT NULL,
	"agent_id" integer NOT NULL,
	"uid_validity" bigint,
	"last_uid" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_folder_mailbox_id_name_unique" UNIQUE("mailbox_id","name"),
	CONSTRAINT "mailbox_folder_status_check" CHECK ("mailbox_folder"."status" IN ('active', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "agent_run" DROP CONSTRAINT "agent_run_trigger_check";--> statement-breakpoint
ALTER TABLE "agent_run" ADD COLUMN "intake_item_id" integer;--> statement-breakpoint
ALTER TABLE "intake_item" ADD CONSTRAINT "intake_item_folder_id_mailbox_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."mailbox_folder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_item" ADD CONSTRAINT "intake_item_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox" ADD CONSTRAINT "mailbox_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_folder" ADD CONSTRAINT "mailbox_folder_mailbox_id_mailbox_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_folder" ADD CONSTRAINT "mailbox_folder_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_folder" ADD CONSTRAINT "mailbox_folder_agent_id_ai_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_item_reply_idx" ON "intake_item" USING btree ("id") WHERE "intake_item"."reply_to_issue_id" IS NOT NULL AND "intake_item"."status" = 'new';--> statement-breakpoint
CREATE INDEX "intake_item_message_idx" ON "intake_item" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "mailbox_user_idx" ON "mailbox" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mailbox_folder_due_idx" ON "mailbox_folder" USING btree ("status","next_poll_at");--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_intake_item_id_intake_item_id_fk" FOREIGN KEY ("intake_item_id") REFERENCES "public"."intake_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_intake_item_idx" ON "agent_run" USING btree ("intake_item_id") WHERE "agent_run"."intake_item_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_trigger_check" CHECK ("agent_run"."trigger" IN ('mention', 'delegation', 'field', 'schedule', 'manual', 'status', 'event', 'mail_triage'));