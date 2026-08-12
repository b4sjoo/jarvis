PRAGMA foreign_keys = ON;

ALTER TABLE case_statements ADD COLUMN source_status TEXT NOT NULL DEFAULT 'current'
  CHECK (source_status IN ('current', 'stale'));
ALTER TABLE case_statements ADD COLUMN source_stale_reasons_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE case_statements ADD COLUMN commitment_detail_json TEXT;
ALTER TABLE case_statements ADD COLUMN deadline_detail_json TEXT;

CREATE TABLE case_statement_events (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  statement_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created', 'edited', 'review-transition', 'source-stale', 'source-refreshed'
  )),
  from_statement_id TEXT,
  to_statement_id TEXT,
  from_state TEXT,
  to_state TEXT,
  statement_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (statement_id) REFERENCES case_statements(id) ON DELETE CASCADE,
  FOREIGN KEY (from_statement_id) REFERENCES case_statements(id) ON DELETE SET NULL,
  FOREIGN KEY (to_statement_id) REFERENCES case_statements(id) ON DELETE SET NULL
);

CREATE INDEX idx_case_statement_events_statement_time
  ON case_statement_events(statement_id, occurred_at);

ALTER TABLE snapshot_artifacts ADD COLUMN item_refs_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE material_deletion_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  material_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'staged', 'db-deleted', 'restore-failed',
    'finalize-failed', 'restored', 'complete'
  )),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_material_deletion_operations_state
  ON material_deletion_operations(state, updated_at);
