CREATE TABLE "user_teams_bot_account" (
	"user_id" text PRIMARY KEY NOT NULL,
	"teams_user_id" text,
	"display_name" text,
	"service_url" text,
	"conversation_id" text,
	"link_code" text,
	"link_code_expires_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"broken_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_teams_webhook" (
	"user_id" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"host" text NOT NULL,
	"broken_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_delivery" DROP CONSTRAINT "notification_delivery_channel_check";--> statement-breakpoint
ALTER TABLE "user_notification_preference" ADD COLUMN "teams_events" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "user_teams_bot_account" ADD CONSTRAINT "user_teams_bot_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_teams_webhook" ADD CONSTRAINT "user_teams_webhook_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_teams_bot_account_teams_user_id_unique" ON "user_teams_bot_account" USING btree ("teams_user_id") WHERE "user_teams_bot_account"."teams_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_teams_bot_account_link_code_unique" ON "user_teams_bot_account" USING btree ("link_code") WHERE "user_teams_bot_account"."link_code" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_channel_check" CHECK ("notification_delivery"."channel" IN ('email', 'telegram', 'teams'));