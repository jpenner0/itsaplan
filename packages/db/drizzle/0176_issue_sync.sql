CREATE TABLE "issue_comment_sync_link" (
	"id" serial PRIMARY KEY NOT NULL,
	"activity_id" integer NOT NULL,
	"issue_sync_link_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text NOT NULL,
	"external_author_login" text,
	"synced_hash" text NOT NULL,
	"external_updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issue_comment_sync_link_activity_id_unique" UNIQUE("activity_id"),
	CONSTRAINT "issue_comment_sync_link_external_uq" UNIQUE("issue_sync_link_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "issue_sync_link" (
	"id" serial PRIMARY KEY NOT NULL,
	"issue_id" integer NOT NULL,
	"managed_repository_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"external_number" integer NOT NULL,
	"external_url" text NOT NULL,
	"synced_hash" text NOT NULL,
	"field_hashes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issue_sync_link_issue_id_unique" UNIQUE("issue_id"),
	CONSTRAINT "issue_sync_link_repository_number_uq" UNIQUE("managed_repository_id","external_number")
);
--> statement-breakpoint
ALTER TABLE "git_managed_repository" ADD COLUMN "issues_sync_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "git_managed_repository" ADD COLUMN "new_issues_to_provider" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "git_managed_repository" ADD COLUMN "issues_watermark" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "git_provider_connection" ADD COLUMN "bot_user_id" text;--> statement-breakpoint
ALTER TABLE "issue_comment_sync_link" ADD CONSTRAINT "issue_comment_sync_link_activity_id_issue_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."issue_activity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_comment_sync_link" ADD CONSTRAINT "issue_comment_sync_link_issue_sync_link_id_issue_sync_link_id_fk" FOREIGN KEY ("issue_sync_link_id") REFERENCES "public"."issue_sync_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_sync_link" ADD CONSTRAINT "issue_sync_link_issue_id_issue_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issue"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_sync_link" ADD CONSTRAINT "issue_sync_link_managed_repository_id_git_managed_repository_id_fk" FOREIGN KEY ("managed_repository_id") REFERENCES "public"."git_managed_repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_provider_connection" ADD CONSTRAINT "git_provider_connection_bot_user_id_user_id_fk" FOREIGN KEY ("bot_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_managed_repository_issues_sync_uq" ON "git_managed_repository" USING btree ("connection_id","external_id") WHERE "git_managed_repository"."issues_sync_enabled";--> statement-breakpoint
ALTER TABLE "git_provider_connection" ADD CONSTRAINT "git_provider_connection_bot_user_id_unique" UNIQUE("bot_user_id");--> statement-breakpoint
CREATE TRIGGER issue_sync_link_rev AFTER INSERT OR DELETE ON issue_sync_link
	FOR EACH ROW EXECUTE FUNCTION rev_issue_child('issue_id', 'detail');