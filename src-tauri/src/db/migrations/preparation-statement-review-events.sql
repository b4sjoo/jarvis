PRAGMA foreign_keys = ON;

DROP TRIGGER IF EXISTS preparation_statement_updated_event;

CREATE TRIGGER preparation_statement_updated_event
AFTER UPDATE OF revision ON preparation_statements
WHEN NEW.revision <> OLD.revision
BEGIN
    -- A save that edits reviewed fields and applies a review decision advances
    -- two revisions atomically. The intermediate revision records the edit
    -- without pretending the status had already changed.
    INSERT INTO preparation_statement_review_events
      (id, process_id, statement_id, statement_revision, action, actor,
       previous_status, next_status, created_at)
    SELECT
      NEW.id || ':' || (OLD.revision + 1),
      NEW.process_id,
      NEW.id,
      OLD.revision + 1,
      'edited',
      NEW.last_review_actor,
      OLD.status,
      OLD.status,
      NEW.updated_at
    WHERE NEW.revision = OLD.revision + 2;

    INSERT INTO preparation_statement_review_events
      (id, process_id, statement_id, statement_revision, action, actor,
       previous_status, next_status, created_at)
    VALUES
      (NEW.id || ':' || NEW.revision, NEW.process_id, NEW.id, NEW.revision,
       NEW.last_review_action, NEW.last_review_actor, OLD.status, NEW.status,
       NEW.updated_at);

    -- Keep one authority source per user operation. It points at the final
    -- revision even when the operation also emitted an intermediate edit event.
    INSERT OR IGNORE INTO preparation_statement_sources
      (id, statement_id, source_type, source_id, title, created_at)
    SELECT
      NEW.id || ':user-confirmation:' || NEW.revision,
      NEW.id,
      'user-confirmation',
      NEW.id || ':' || NEW.revision,
      'User confirmation',
      NEW.updated_at
    WHERE NEW.last_review_actor = 'user'
      AND (
        NEW.last_review_action = 'confirmed'
        OR NEW.revision = OLD.revision + 2
      );
END;
