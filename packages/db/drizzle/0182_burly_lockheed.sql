-- Rows of the old per-user intake cannot be moved to a team mailbox. agent_run.intake_item_id
-- is ON DELETE CASCADE, so triage runs go with the items; issues stay.
DELETE FROM "intake_item";--> statement-breakpoint
CREATE TABLE "team_mailbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"team_id" integer NOT NULL,
	"agent_id" integer NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 993 NOT NULL,
	"secure" boolean DEFAULT true NOT NULL,
	"auth" text DEFAULT 'password' NOT NULL,
	"username" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"redacted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_senders" text[] DEFAULT '{}'::text[] NOT NULL,
	"uid_validity" bigint,
	"last_uid" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_poll_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_polled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_mailbox_team_id_unique" UNIQUE("team_id"),
	CONSTRAINT "team_mailbox_auth_check" CHECK ("team_mailbox"."auth" IN ('password', 'microsoft365')),
	CONSTRAINT "team_mailbox_status_check" CHECK ("team_mailbox"."status" IN ('active', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "mailbox" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mailbox_folder" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "mailbox" CASCADE;--> statement-breakpoint
DROP TABLE "mailbox_folder" CASCADE;--> statement-breakpoint
ALTER TABLE "intake_item" DROP CONSTRAINT "intake_item_folder_id_message_id_unique";--> statement-breakpoint
--> statement-breakpoint
ALTER TABLE "intake_item" ADD COLUMN "team_mailbox_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "team_mailbox" ADD CONSTRAINT "team_mailbox_team_id_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_mailbox" ADD CONSTRAINT "team_mailbox_agent_id_ai_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."ai_agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_mailbox_due_idx" ON "team_mailbox" USING btree ("status","next_poll_at");--> statement-breakpoint
ALTER TABLE "intake_item" ADD CONSTRAINT "intake_item_team_mailbox_id_team_mailbox_id_fk" FOREIGN KEY ("team_mailbox_id") REFERENCES "public"."team_mailbox"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_item" DROP COLUMN "folder_id";--> statement-breakpoint
ALTER TABLE "intake_item" ADD CONSTRAINT "intake_item_team_mailbox_id_message_id_unique" UNIQUE("team_mailbox_id","message_id");