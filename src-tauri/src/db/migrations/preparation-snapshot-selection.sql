PRAGMA foreign_keys = ON;

DROP TRIGGER IF EXISTS preparation_snapshot_before_activation;
DROP INDEX IF EXISTS idx_preparation_snapshot_activation_events_round;

ALTER TABLE preparation_snapshot_activation_events
RENAME TO preparation_snapshot_activation_events_legacy;

CREATE TABLE preparation_snapshot_activation_events (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    previous_snapshot_id TEXT,
    action TEXT NOT NULL CHECK(action IN (
        'activated', 'reactivated', 'deactivated', 'rolled-back'
    )),
    created_at INTEGER NOT NULL,
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE,
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE CASCADE,
    FOREIGN KEY (snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY (previous_snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE SET NULL
);

INSERT INTO preparation_snapshot_activation_events
  (id, process_id, round_id, snapshot_id, previous_snapshot_id, action, created_at)
SELECT id, process_id, round_id, snapshot_id, previous_snapshot_id, action, created_at
FROM preparation_snapshot_activation_events_legacy;

DROP TABLE preparation_snapshot_activation_events_legacy;

CREATE INDEX idx_preparation_snapshot_activation_events_round
ON preparation_snapshot_activation_events(process_id, round_id, created_at DESC);

CREATE TABLE interview_preparation_snapshot_selections (
    process_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    active_snapshot_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (process_id, round_id),
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE,
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE CASCADE,
    FOREIGN KEY (active_snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE SET NULL
);

CREATE INDEX idx_interview_preparation_snapshot_selections_active
ON interview_preparation_snapshot_selections(active_snapshot_id);

INSERT INTO interview_preparation_snapshot_selections
  (process_id, round_id, active_snapshot_id, revision, updated_at)
SELECT round.process_id,
       round.id,
       active.id,
       CASE WHEN active.id IS NULL THEN 0 ELSE 1 END,
       COALESCE(active.activated_at, round.updated_at)
FROM interview_rounds round
LEFT JOIN interview_preparation_snapshots active
  ON active.process_id = round.process_id
 AND active.round_id = round.id
 AND active.build_status = 'committed'
 AND active.status = 'active';

CREATE TRIGGER preparation_snapshot_selection_for_new_round
AFTER INSERT ON interview_rounds
BEGIN
    INSERT OR IGNORE INTO interview_preparation_snapshot_selections
      (process_id, round_id, active_snapshot_id, revision, updated_at)
    VALUES (NEW.process_id, NEW.id, NULL, 0, NEW.created_at);
END;

CREATE TRIGGER preparation_snapshot_selection_rejects_identity_mutation
BEFORE UPDATE OF process_id, round_id ON interview_preparation_snapshot_selections
BEGIN
    SELECT RAISE(ABORT, 'Preparation snapshot selection identity is immutable.');
END;

CREATE TRIGGER preparation_snapshot_selection_before_change
BEFORE UPDATE OF active_snapshot_id ON interview_preparation_snapshot_selections
WHEN OLD.active_snapshot_id IS NOT NEW.active_snapshot_id
BEGIN
    SELECT CASE
      WHEN NEW.revision <> OLD.revision + 1
      THEN RAISE(ABORT, 'Preparation snapshot selection revision must advance once.')
    END;

    SELECT CASE
      WHEN NEW.active_snapshot_id IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM interview_preparation_snapshots snapshot
        WHERE snapshot.id = NEW.active_snapshot_id
          AND snapshot.process_id = NEW.process_id
          AND snapshot.round_id = NEW.round_id
          AND snapshot.build_status = 'committed'
          AND snapshot.status IN ('ready', 'active', 'superseded')
      )
      THEN RAISE(ABORT, 'Preparation snapshot selection target is invalid.')
    END;

    INSERT INTO preparation_snapshot_activation_events
      (id, process_id, round_id, snapshot_id, previous_snapshot_id, action, created_at)
    VALUES
      (NEW.process_id || ':' || NEW.round_id || ':' || NEW.revision || ':' || NEW.updated_at,
       NEW.process_id,
       NEW.round_id,
       COALESCE(NEW.active_snapshot_id, OLD.active_snapshot_id),
       OLD.active_snapshot_id,
       CASE
         WHEN NEW.active_snapshot_id IS NULL THEN 'deactivated'
         WHEN OLD.active_snapshot_id IS NULL AND
              (SELECT activated_at FROM interview_preparation_snapshots
               WHERE id = NEW.active_snapshot_id) IS NOT NULL THEN 'reactivated'
         WHEN OLD.active_snapshot_id IS NULL THEN 'activated'
         WHEN (SELECT version FROM interview_preparation_snapshots
               WHERE id = NEW.active_snapshot_id) <
              (SELECT version FROM interview_preparation_snapshots
               WHERE id = OLD.active_snapshot_id) THEN 'rolled-back'
         WHEN (SELECT status FROM interview_preparation_snapshots
               WHERE id = NEW.active_snapshot_id) = 'superseded' THEN 'reactivated'
         ELSE 'activated'
       END,
       NEW.updated_at);

    UPDATE interview_preparation_snapshots
    SET status = CASE
          WHEN NEW.active_snapshot_id IS NULL THEN 'ready'
          ELSE 'superseded'
        END
    WHERE id = OLD.active_snapshot_id
      AND build_status = 'committed'
      AND status = 'active';

    UPDATE interview_preparation_snapshots
    SET status = 'active', activated_at = NEW.updated_at
    WHERE id = NEW.active_snapshot_id
      AND build_status = 'committed';
END;
