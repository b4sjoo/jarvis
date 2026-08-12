PRAGMA foreign_keys = ON;

DROP INDEX idx_case_deletion_operations_state;
ALTER TABLE case_deletion_operations RENAME TO case_deletion_operations_v1;

CREATE TABLE case_deletion_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  case_id_hash TEXT NOT NULL,
  linked_session_ids_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'staged', 'db-deleted', 'restore-failed',
    'finalize-failed', 'restored', 'complete'
  )),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO case_deletion_operations (
  operation_id, case_id, case_id_hash, linked_session_ids_json,
  state, error, created_at, updated_at
)
SELECT operation_id, case_id, case_id_hash, linked_session_ids_json,
  CASE WHEN state = 'failed' THEN 'restore-failed' ELSE state END,
  error, created_at, updated_at
FROM case_deletion_operations_v1;

DROP TABLE case_deletion_operations_v1;

CREATE INDEX idx_case_deletion_operations_state
  ON case_deletion_operations(state, updated_at);
