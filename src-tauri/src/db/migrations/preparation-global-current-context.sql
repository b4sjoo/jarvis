PRAGMA foreign_keys = ON;

DROP TRIGGER IF EXISTS preparation_snapshot_selection_for_new_round;
DROP TRIGGER IF EXISTS preparation_snapshot_selection_rejects_identity_mutation;
DROP TRIGGER IF EXISTS preparation_snapshot_selection_before_change;
DROP INDEX IF EXISTS idx_interview_preparation_snapshot_selections_active;

CREATE TABLE interview_preparation_current_context (
    singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
    process_id TEXT,
    round_id TEXT,
    selected_snapshot_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    updated_at INTEGER NOT NULL,
    CHECK(
      (process_id IS NULL AND round_id IS NULL AND selected_snapshot_id IS NULL)
      OR (process_id IS NOT NULL AND round_id IS NOT NULL)
    ),
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE SET NULL,
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE SET NULL,
    FOREIGN KEY (selected_snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE SET NULL
);

CREATE TABLE preparation_current_context_events (
    id TEXT PRIMARY KEY,
    previous_process_id TEXT,
    previous_round_id TEXT,
    previous_snapshot_id TEXT,
    process_id TEXT,
    round_id TEXT,
    selected_snapshot_id TEXT,
    action TEXT NOT NULL CHECK(action IN (
      'current-context-set',
      'context-switched',
      'snapshot-activated',
      'snapshot-deactivated',
      'migration-cleared'
    )),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_preparation_current_context_events_created
ON preparation_current_context_events(created_at DESC, revision DESC);

-- A single unambiguous legacy selection can migrate automatically. Multiple
-- selections preserve their immutable versions and history, but no selection
-- receives runtime authority until the user chooses one.
WITH legacy_selection AS (
  SELECT selection.*,
         CASE WHEN EXISTS (
           SELECT 1
           FROM interview_preparation_snapshots snapshot
           JOIN interview_processes process ON process.id = snapshot.process_id
           JOIN preparation_workspaces workspace ON workspace.id = process.workspace_id
           JOIN interview_rounds round ON round.id = snapshot.round_id
           WHERE snapshot.id = selection.active_snapshot_id
             AND snapshot.process_id = selection.process_id
             AND snapshot.round_id = selection.round_id
             AND snapshot.build_status = 'committed'
             AND workspace.status = 'active'
             AND round.archived_at IS NULL
         ) THEN 1 ELSE 0 END AS is_valid
  FROM interview_preparation_snapshot_selections selection
  WHERE selection.active_snapshot_id IS NOT NULL
)
INSERT INTO interview_preparation_current_context
  (singleton_id, process_id, round_id, selected_snapshot_id, revision, updated_at)
SELECT 1,
       CASE WHEN COUNT(active_snapshot_id) = 1 AND MAX(is_valid) = 1
         THEN MAX(process_id) END,
       CASE WHEN COUNT(active_snapshot_id) = 1 AND MAX(is_valid) = 1
         THEN MAX(round_id) END,
       CASE WHEN COUNT(active_snapshot_id) = 1 AND MAX(is_valid) = 1
         THEN MAX(active_snapshot_id) END,
       0,
       COALESCE(MAX(updated_at), CAST(strftime('%s', 'now') AS INTEGER) * 1000)
FROM legacy_selection;

WITH legacy_selection AS (
  SELECT selection.*,
         CASE WHEN EXISTS (
           SELECT 1
           FROM interview_preparation_snapshots snapshot
           JOIN interview_processes process ON process.id = snapshot.process_id
           JOIN preparation_workspaces workspace ON workspace.id = process.workspace_id
           JOIN interview_rounds round ON round.id = snapshot.round_id
           WHERE snapshot.id = selection.active_snapshot_id
             AND snapshot.process_id = selection.process_id
             AND snapshot.round_id = selection.round_id
             AND snapshot.build_status = 'committed'
             AND workspace.status = 'active'
             AND round.archived_at IS NULL
         ) THEN 1 ELSE 0 END AS is_valid
  FROM interview_preparation_snapshot_selections selection
  WHERE selection.active_snapshot_id IS NOT NULL
)
INSERT INTO preparation_current_context_events
  (id, action, revision, created_at)
SELECT 'migration-17-cleared-ambiguous-selection',
       'migration-cleared',
       0,
       COALESCE(MAX(updated_at), CAST(strftime('%s', 'now') AS INTEGER) * 1000)
FROM legacy_selection
HAVING COUNT(active_snapshot_id) > 1
   OR (COUNT(active_snapshot_id) = 1 AND MAX(is_valid) = 0);

UPDATE interview_preparation_snapshots
SET status = 'superseded'
WHERE build_status = 'committed'
  AND status = 'active'
  AND id IS NOT (
    SELECT selected_snapshot_id
    FROM interview_preparation_current_context
    WHERE singleton_id = 1
  );

DROP INDEX IF EXISTS idx_interview_preparation_snapshots_active;
CREATE UNIQUE INDEX idx_interview_preparation_snapshots_global_active
ON interview_preparation_snapshots(status)
WHERE build_status = 'committed' AND status = 'active';

DROP TABLE interview_preparation_snapshot_selections;

CREATE TRIGGER preparation_current_context_before_change
BEFORE UPDATE OF process_id, round_id, selected_snapshot_id
ON interview_preparation_current_context
WHEN OLD.process_id IS NOT NEW.process_id
  OR OLD.round_id IS NOT NEW.round_id
  OR OLD.selected_snapshot_id IS NOT NEW.selected_snapshot_id
BEGIN
    SELECT CASE
      WHEN NEW.revision <> OLD.revision + 1
      THEN RAISE(ABORT, 'Preparation current context revision must advance once.')
    END;

    SELECT CASE
      WHEN (NEW.process_id IS NULL) <> (NEW.round_id IS NULL)
        OR (NEW.process_id IS NULL AND NEW.selected_snapshot_id IS NOT NULL)
      THEN RAISE(ABORT, 'Preparation current Process and Round must settle together.')
    END;

    SELECT CASE
      WHEN NEW.process_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM interview_processes process
        JOIN preparation_workspaces workspace ON workspace.id = process.workspace_id
        JOIN interview_rounds round ON round.process_id = process.id
        WHERE process.id = NEW.process_id
          AND round.id = NEW.round_id
          AND workspace.status = 'active'
          AND round.archived_at IS NULL
      )
      THEN RAISE(ABORT, 'Preparation current Process or Round is unavailable.')
    END;

    SELECT CASE
      WHEN NEW.selected_snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM interview_preparation_snapshots snapshot
        WHERE snapshot.id = NEW.selected_snapshot_id
          AND snapshot.process_id = NEW.process_id
          AND snapshot.round_id = NEW.round_id
          AND snapshot.build_status = 'committed'
          AND snapshot.status IN ('ready', 'active', 'superseded')
      )
      THEN RAISE(ABORT, 'Preparation current snapshot does not belong to the current Round.')
    END;
END;

CREATE TRIGGER preparation_current_context_after_change
AFTER UPDATE OF process_id, round_id, selected_snapshot_id
ON interview_preparation_current_context
WHEN OLD.process_id IS NOT NEW.process_id
  OR OLD.round_id IS NOT NEW.round_id
  OR OLD.selected_snapshot_id IS NOT NEW.selected_snapshot_id
BEGIN
    UPDATE interview_preparation_snapshots
    SET status = CASE
          WHEN NEW.selected_snapshot_id IS NULL THEN 'ready'
          ELSE 'superseded'
        END
    WHERE id = OLD.selected_snapshot_id
      AND id IS NOT NEW.selected_snapshot_id
      AND build_status = 'committed'
      AND status = 'active';

    INSERT INTO preparation_current_context_events
      (id, previous_process_id, previous_round_id, previous_snapshot_id,
       process_id, round_id, selected_snapshot_id, action, revision, created_at)
    VALUES
      ('current-context:' || NEW.revision || ':' || NEW.updated_at,
       OLD.process_id, OLD.round_id, OLD.selected_snapshot_id,
       NEW.process_id, NEW.round_id, NEW.selected_snapshot_id,
       CASE
         WHEN NEW.selected_snapshot_id IS NULL AND OLD.selected_snapshot_id IS NOT NULL
           THEN 'snapshot-deactivated'
         WHEN NEW.selected_snapshot_id IS NOT NULL
           THEN 'snapshot-activated'
         WHEN OLD.process_id IS NULL AND NEW.process_id IS NOT NULL
           THEN 'current-context-set'
         WHEN OLD.process_id IS NOT NEW.process_id OR OLD.round_id IS NOT NEW.round_id
           THEN 'context-switched'
         ELSE 'current-context-set'
       END,
       NEW.revision,
       NEW.updated_at);

    INSERT INTO preparation_snapshot_activation_events
      (id, process_id, round_id, snapshot_id, previous_snapshot_id, action, created_at)
    SELECT
      'global-selection:' || NEW.revision || ':' || NEW.updated_at,
      CASE WHEN NEW.selected_snapshot_id IS NULL
        THEN OLD.process_id ELSE NEW.process_id END,
      CASE WHEN NEW.selected_snapshot_id IS NULL
        THEN OLD.round_id ELSE NEW.round_id END,
      COALESCE(NEW.selected_snapshot_id, OLD.selected_snapshot_id),
      OLD.selected_snapshot_id,
      CASE
        WHEN NEW.selected_snapshot_id IS NULL THEN 'deactivated'
        WHEN OLD.selected_snapshot_id IS NOT NULL
          AND OLD.process_id = NEW.process_id
          AND OLD.round_id = NEW.round_id
          AND (SELECT version FROM interview_preparation_snapshots
               WHERE id = NEW.selected_snapshot_id) <
              (SELECT version FROM interview_preparation_snapshots
               WHERE id = OLD.selected_snapshot_id) THEN 'rolled-back'
        WHEN (SELECT activated_at FROM interview_preparation_snapshots
              WHERE id = NEW.selected_snapshot_id) IS NOT NULL THEN 'reactivated'
        ELSE 'activated'
      END,
      NEW.updated_at
    WHERE OLD.selected_snapshot_id IS NOT NEW.selected_snapshot_id
      AND COALESCE(NEW.selected_snapshot_id, OLD.selected_snapshot_id) IS NOT NULL;

    UPDATE interview_preparation_snapshots
    SET status = 'active', activated_at = NEW.updated_at
    WHERE id = NEW.selected_snapshot_id
      AND build_status = 'committed';
END;

CREATE TRIGGER preparation_current_context_clears_archived_workspace
AFTER UPDATE OF status ON preparation_workspaces
WHEN NEW.status <> 'active'
  AND EXISTS (
    SELECT 1 FROM interview_processes process
    WHERE process.id = (SELECT process_id FROM interview_preparation_current_context)
      AND process.workspace_id = NEW.id
  )
BEGIN
    UPDATE interview_preparation_current_context
    SET process_id = NULL,
        round_id = NULL,
        selected_snapshot_id = NULL,
        revision = revision + 1,
        updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton_id = 1;
END;

CREATE TRIGGER preparation_current_context_clears_archived_round
AFTER UPDATE OF archived_at ON interview_rounds
WHEN NEW.archived_at IS NOT NULL
  AND NEW.id = (SELECT round_id FROM interview_preparation_current_context)
BEGIN
    UPDATE interview_preparation_current_context
    SET process_id = NULL,
        round_id = NULL,
        selected_snapshot_id = NULL,
        revision = revision + 1,
        updated_at = NEW.updated_at
    WHERE singleton_id = 1;
END;

CREATE TRIGGER preparation_current_context_clears_deleted_process
BEFORE DELETE ON interview_processes
WHEN OLD.id = (SELECT process_id FROM interview_preparation_current_context)
BEGIN
    UPDATE interview_preparation_current_context
    SET process_id = NULL,
        round_id = NULL,
        selected_snapshot_id = NULL,
        revision = revision + 1,
        updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton_id = 1;
END;

CREATE TRIGGER preparation_current_context_clears_deleted_round
BEFORE DELETE ON interview_rounds
WHEN OLD.id = (SELECT round_id FROM interview_preparation_current_context)
BEGIN
    UPDATE interview_preparation_current_context
    SET process_id = NULL,
        round_id = NULL,
        selected_snapshot_id = NULL,
        revision = revision + 1,
        updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE singleton_id = 1;
END;
