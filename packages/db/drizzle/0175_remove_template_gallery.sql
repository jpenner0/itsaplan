DROP TABLE "template_publisher" CASCADE;--> statement-breakpoint
ALTER TABLE "project_template" DROP COLUMN "publication_id";--> statement-breakpoint
ALTER TABLE "project_template" DROP COLUMN "publication_url";--> statement-breakpoint
ALTER TABLE "project_template" DROP COLUMN "published_at";