PRAGMA foreign_keys = ON;

ALTER TABLE cases ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'active'
  CHECK (deletion_state IN ('active', 'deleting'));

ALTER TABLE preparation_human_evaluations
  RENAME TO preparation_human_evaluations_v2;

CREATE TABLE preparation_human_evaluations (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  call_session_id TEXT,
  snapshot_id TEXT,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN (
    'complete', 'partial', 'wrong', 'unreadable',
    'helpful', 'irrelevant', 'missing', 'polluting',
    'correct', 'needs-edit', 'unsupported', 'duplicate',
    'over-constraining', 'incorrect', 'missed',
    'wrong-party', 'wrong-condition', 'wrong-date'
  )),
  note TEXT,
  source TEXT NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit', 'derived')),
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (call_session_id) REFERENCES call_runtime_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id) REFERENCES call_preparation_snapshots(id) ON DELETE SET NULL
);

INSERT INTO preparation_human_evaluations (
  id, case_id, call_session_id, snapshot_id, subject_kind,
  subject_id, label, note, source, occurred_at
)
SELECT
  id, case_id, call_session_id, snapshot_id, subject_kind,
  subject_id, label, note, 'explicit', occurred_at
FROM preparation_human_evaluations_v2;

DROP TABLE preparation_human_evaluations_v2;

CREATE INDEX idx_preparation_evaluations_case_time
  ON preparation_human_evaluations(case_id, occurred_at DESC);

CREATE INDEX idx_preparation_evaluations_subject_time
  ON preparation_human_evaluations(subject_kind, subject_id, occurred_at DESC);

CREATE TABLE case_deletion_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  case_id_hash TEXT NOT NULL,
  linked_session_ids_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN (
    'prepared', 'staged', 'db-deleted', 'complete', 'failed'
  )),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_case_deletion_operations_state
  ON case_deletion_operations(state, updated_at);

CREATE TABLE case_privacy_audits (
  id TEXT PRIMARY KEY NOT NULL,
  case_id_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('export', 'delete', 'recovery')),
  status TEXT NOT NULL CHECK (status IN ('started', 'complete', 'failed')),
  item_counts_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL
);

CREATE INDEX idx_case_privacy_audits_operation
  ON case_privacy_audits(operation_id, occurred_at);

CREATE TRIGGER trg_material_call_plan_case_insert
BEFORE INSERT ON case_materials
WHEN NEW.call_plan_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM call_plans
    WHERE id = NEW.call_plan_id AND case_id = NEW.case_id
  ) THEN RAISE(ABORT, 'material call plan must belong to the same case') END;
END;

CREATE TRIGGER trg_material_call_plan_case_update
BEFORE UPDATE OF case_id, call_plan_id ON case_materials
WHEN NEW.call_plan_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM call_plans
    WHERE id = NEW.call_plan_id AND case_id = NEW.case_id
  ) THEN RAISE(ABORT, 'material call plan must belong to the same case') END;
END;

CREATE TRIGGER trg_conversation_call_plan_case_insert
BEFORE INSERT ON preparation_conversations
WHEN NEW.call_plan_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM call_plans
    WHERE id = NEW.call_plan_id AND case_id = NEW.case_id
  ) THEN RAISE(ABORT, 'conversation call plan must belong to the same case') END;
END;

CREATE TRIGGER trg_conversation_call_plan_case_update
BEFORE UPDATE OF case_id, call_plan_id ON preparation_conversations
WHEN NEW.call_plan_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM call_plans
    WHERE id = NEW.call_plan_id AND case_id = NEW.case_id
  ) THEN RAISE(ABORT, 'conversation call plan must belong to the same case') END;
END;

CREATE TRIGGER trg_snapshot_source_scope_insert
BEFORE INSERT ON call_preparation_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM case_revisions
    WHERE id = NEW.case_revision_id AND case_id = NEW.case_id
  ) THEN RAISE(ABORT, 'snapshot revision must belong to the same case') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM call_plans
    WHERE id = NEW.call_plan_id AND case_id = NEW.case_id
  ) THEN RAISE(ABORT, 'snapshot call plan must belong to the same case') END;
END;

CREATE TRIGGER trg_snapshot_source_scope_update
BEFORE UPDATE OF case_id, case_revision_id, call_plan_id ON call_preparation_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM case_revisions
    WHERE id = NEW.case_revision_id AND case_id = NEW.case_id
  ) THEN RAISE(ABORT, 'snapshot revision must belong to the same case') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM call_plans
    WHERE id = NEW.call_plan_id AND case_id = NEW.case_id
  ) THEN RAISE(ABORT, 'snapshot call plan must belong to the same case') END;
END;

CREATE TRIGGER trg_prepared_binding_scope_insert
BEFORE INSERT ON call_session_preparation_bindings
WHEN NEW.mode = 'prepared'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM call_preparation_snapshots snapshot
    WHERE snapshot.id = NEW.snapshot_id
      AND snapshot.case_id = NEW.case_id
      AND snapshot.case_revision_id = NEW.case_revision_id
      AND snapshot.call_plan_id = NEW.call_plan_id
      AND snapshot.content_hash = NEW.snapshot_content_hash
  ) THEN RAISE(ABORT, 'prepared binding sources must belong to one case snapshot') END;
END;

CREATE TRIGGER trg_neutral_binding_scope_insert
BEFORE INSERT ON call_session_preparation_bindings
WHEN NEW.mode = 'neutral'
BEGIN
  SELECT CASE WHEN
    NEW.case_id IS NOT NULL OR NEW.case_revision_id IS NOT NULL OR
    NEW.call_plan_id IS NOT NULL OR NEW.snapshot_id IS NOT NULL OR
    NEW.snapshot_content_hash IS NOT NULL
  THEN RAISE(ABORT, 'neutral binding cannot contain prepared sources') END;
END;

CREATE TRIGGER trg_pending_update_session_scope_insert
BEFORE INSERT ON pending_case_updates
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM call_session_preparation_bindings binding
    WHERE binding.call_session_id = NEW.call_session_id
      AND binding.mode = 'prepared'
      AND binding.case_id = NEW.case_id
  ) THEN RAISE(ABORT, 'pending update session must be prepared for the same case') END;
END;

CREATE TRIGGER trg_artifact_receipt_snapshot_scope_insert
BEFORE INSERT ON snapshot_artifact_receipts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM snapshot_artifacts artifact
    WHERE artifact.id = NEW.artifact_id
      AND artifact.snapshot_id = NEW.snapshot_id
  ) THEN RAISE(ABORT, 'artifact receipt must reference one snapshot artifact') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM call_session_preparation_bindings binding
    WHERE binding.call_session_id = NEW.call_session_id
      AND binding.snapshot_id = NEW.snapshot_id
  ) THEN RAISE(ABORT, 'artifact receipt must match the CallSession snapshot') END;
END;

CREATE TRIGGER trg_evaluation_snapshot_case_scope_insert
BEFORE INSERT ON preparation_human_evaluations
WHEN NEW.snapshot_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM call_preparation_snapshots snapshot
    WHERE snapshot.id = NEW.snapshot_id AND snapshot.case_id = NEW.case_id
  ) THEN RAISE(ABORT, 'evaluation snapshot must belong to the same case') END;
END;
