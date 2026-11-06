ALTER TABLE "issue_sync_outbox" ADD COLUMN "repository_external_id" text;--> statement-breakpoint
-- The tombstones also copy the repository's provider id, so a push finds the repository
-- again after a rename.
CREATE OR REPLACE FUNCTION issue_sync_link_tombstone() RETURNS trigger AS $$
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
CREATE OR REPLACE FUNCTION issue_comment_sync_link_tombstone() RETURNS trigger AS $$
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
