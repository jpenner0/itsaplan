CREATE TABLE "issue_sync_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"issue_id" integer,
	"activity_id" integer,
	"publish" boolean DEFAULT false NOT NULL,
	"connection_id" integer,
	"repository" text,
	"repository_external_id" text,
	"external_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_sync_outbox_issue_uq" ON "issue_sync_outbox" USING btree ("issue_id") WHERE "issue_sync_outbox"."kind" = 'issue';--> statement-breakpoint
CREATE UNIQUE INDEX "issue_sync_outbox_comment_uq" ON "issue_sync_outbox" USING btree ("activity_id") WHERE "issue_sync_outbox"."kind" = 'comment';--> statement-breakpoint
CREATE INDEX "issue_sync_outbox_due_idx" ON "issue_sync_outbox" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "issue_sync_outbox_issue_idx" ON "issue_sync_outbox" USING btree ("issue_id");--> statement-breakpoint
-- A change of a synced field of a linked issue queues its push. Writes of the inbound
-- sync queue one too; the push finds nothing to send for them.
CREATE FUNCTION issue_sync_queue_issue() RETURNS trigger AS $$
DECLARE
  target integer;
BEGIN
  IF TG_TABLE_NAME = 'issue' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.issue_id;
  ELSE
    target := NEW.issue_id;
  END IF;
  INSERT INTO issue_sync_outbox (kind, issue_id)
  SELECT 'issue', target
  WHERE EXISTS (SELECT 1 FROM issue_sync_link WHERE issue_id = target)
  ON CONFLICT (issue_id) WHERE kind = 'issue'
  DO UPDATE SET version = issue_sync_outbox.version + 1, next_attempt_at = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER issue_sync_outbox_issue AFTER UPDATE ON issue
  FOR EACH ROW
  WHEN (OLD.title IS DISTINCT FROM NEW.title
    OR OLD.description IS DISTINCT FROM NEW.description
    OR OLD.column_id IS DISTINCT FROM NEW.column_id
    OR OLD.assignee_user_id IS DISTINCT FROM NEW.assignee_user_id)
  EXECUTE FUNCTION issue_sync_queue_issue();
--> statement-breakpoint
CREATE TRIGGER issue_sync_outbox_label AFTER INSERT OR DELETE ON issue_label
  FOR EACH ROW EXECUTE FUNCTION issue_sync_queue_issue();
--> statement-breakpoint
CREATE FUNCTION issue_sync_queue_comment() RETURNS trigger AS $$
BEGIN
  INSERT INTO issue_sync_outbox (kind, issue_id, activity_id)
  SELECT 'comment', NEW.issue_id, NEW.id
  WHERE EXISTS (SELECT 1 FROM issue_sync_link WHERE issue_id = NEW.issue_id)
  ON CONFLICT (activity_id) WHERE kind = 'comment'
  DO UPDATE SET version = issue_sync_outbox.version + 1, next_attempt_at = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER issue_sync_outbox_comment AFTER INSERT OR UPDATE OF body ON issue_activity
  FOR EACH ROW WHEN (NEW.kind = 'comment') EXECUTE FUNCTION issue_sync_queue_comment();
--> statement-breakpoint
-- Every deleted link leaves a close_issue row with what the push needs. When the
-- repository itself is deleted, its links are gone before their own trigger can read
-- the repository, so the repository's trigger writes the rows for them.
CREATE FUNCTION issue_sync_link_tombstone() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'git_managed_repository' THEN
    INSERT INTO issue_sync_outbox
      (kind, issue_id, connection_id, repository, repository_external_id, external_id)
    SELECT 'close_issue', l.issue_id, OLD.connection_id, OLD.full_name, OLD.external_id,
      l.external_number::text
    FROM issue_sync_link l WHERE l.managed_repository_id = OLD.id;
  ELSE
    INSERT INTO issue_sync_outbox
      (kind, issue_id, connection_id, repository, repository_external_id, external_id)
    SELECT 'close_issue', OLD.issue_id, r.connection_id, r.full_name, r.external_id,
      OLD.external_number::text
    FROM git_managed_repository r WHERE r.id = OLD.managed_repository_id;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER issue_sync_link_tombstone BEFORE DELETE ON issue_sync_link
  FOR EACH ROW EXECUTE FUNCTION issue_sync_link_tombstone();
--> statement-breakpoint
CREATE TRIGGER git_managed_repository_issue_sync_tombstone BEFORE DELETE ON git_managed_repository
  FOR EACH ROW EXECUTE FUNCTION issue_sync_link_tombstone();
--> statement-breakpoint
CREATE FUNCTION issue_comment_sync_link_tombstone() RETURNS trigger AS $$
BEGIN
  INSERT INTO issue_sync_outbox
    (kind, issue_id, activity_id, connection_id, repository, repository_external_id, external_id)
  SELECT 'delete_comment', l.issue_id, OLD.activity_id, r.connection_id, r.full_name,
    r.external_id, OLD.external_id
  FROM issue_sync_link l
  JOIN git_managed_repository r ON r.id = l.managed_repository_id
  WHERE l.id = OLD.issue_sync_link_id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER issue_comment_sync_link_tombstone BEFORE DELETE ON issue_comment_sync_link
  FOR EACH ROW EXECUTE FUNCTION issue_comment_sync_link_tombstone();
--> statement-breakpoint
-- At commit it is known whether the link went with its issue or comment. An issue that
-- still exists was unlinked and stays open. A comment that still exists was unlinked,
-- and the comments of a deleted issue stay on the closed external issue.
CREATE FUNCTION issue_sync_drop_unlinked() RETURNS trigger AS $$
BEGIN
  IF (NEW.kind = 'close_issue' AND EXISTS (SELECT 1 FROM issue WHERE id = NEW.issue_id))
    OR (NEW.kind = 'delete_comment' AND (
      EXISTS (SELECT 1 FROM issue_activity WHERE id = NEW.activity_id)
      OR NOT EXISTS (SELECT 1 FROM issue WHERE id = NEW.issue_id)))
  THEN
    DELETE FROM issue_sync_outbox WHERE id = NEW.id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER issue_sync_outbox_drop_unlinked AFTER INSERT ON issue_sync_outbox
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.kind IN ('close_issue', 'delete_comment'))
  EXECUTE FUNCTION issue_sync_drop_unlinked();
