PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'waiting', 'resolved', 'archived')),
  case_type TEXT,
  current_revision_id TEXT,
  row_revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS case_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  parent_revision_id TEXT,
  primary_objective TEXT NOT NULL DEFAULT '',
  acceptable_fallbacks_json TEXT NOT NULL DEFAULT '[]',
  party_ids_json TEXT NOT NULL DEFAULT '[]',
  statement_ids_json TEXT NOT NULL DEFAULT '[]',
  next_action_ids_json TEXT NOT NULL DEFAULT '[]',
  source_command_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_revision_id) REFERENCES case_revisions(id) ON DELETE SET NULL,
  UNIQUE (case_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_case_revisions_case_revision
  ON case_revisions(case_id, revision DESC);

CREATE TABLE IF NOT EXISTS case_parties (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'counterparty', 'representative', 'third-party', 'unknown')),
  organization TEXT,
  review_state TEXT NOT NULL CHECK (review_state IN ('proposed', 'confirmed', 'rejected', 'superseded')),
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  row_revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS call_plans (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'ready', 'used', 'superseded')),
  objective TEXT NOT NULL DEFAULT '',
  counterparty_ids_json TEXT NOT NULL DEFAULT '[]',
  acceptable_outcomes_json TEXT NOT NULL DEFAULT '[]',
  questions_to_ask_json TEXT NOT NULL DEFAULT '[]',
  known_risks_json TEXT NOT NULL DEFAULT '[]',
  scheduled_at INTEGER,
  row_revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  UNIQUE (case_id, title)
);

CREATE INDEX IF NOT EXISTS idx_call_plans_case_updated
  ON call_plans(case_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS case_materials (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  call_plan_id TEXT,
  display_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  extension TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  storage_relative_path TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('upload', 'screenshot', 'pasted-image', 'manual')),
  selected_extraction_run_id TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected')),
  row_revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (call_plan_id) REFERENCES call_plans(id) ON DELETE CASCADE,
  UNIQUE (case_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_case_materials_scope
  ON case_materials(case_id, call_plan_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS extraction_runs (
  id TEXT PRIMARY KEY NOT NULL,
  material_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('native-text', 'ocr', 'multimodal', 'manual')),
  engine TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  options_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'needs-review', 'failed')),
  quality_signals_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (material_id) REFERENCES case_materials(id) ON DELETE CASCADE,
  UNIQUE (material_id, output_hash, method, options_hash)
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_material_created
  ON extraction_runs(material_id, created_at DESC);

CREATE TABLE IF NOT EXISTS extraction_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  extraction_run_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  page_number INTEGER,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  confidence REAL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (extraction_run_id) REFERENCES extraction_runs(id) ON DELETE CASCADE,
  UNIQUE (extraction_run_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_extraction_chunks_run_ordinal
  ON extraction_chunks(extraction_run_id, ordinal);

CREATE TABLE IF NOT EXISTS case_statements (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL CHECK (kind IN ('objective', 'fact', 'claim', 'unknown', 'risk', 'commitment', 'deadline', 'reference-number', 'action')),
  content TEXT NOT NULL,
  subject_party_id TEXT,
  speaker_party_id TEXT,
  review_state TEXT NOT NULL CHECK (review_state IN ('proposed', 'confirmed', 'rejected', 'superseded')),
  claim_state TEXT NOT NULL CHECK (claim_state IN ('asserted', 'supported', 'disputed', 'unknown', 'stale')),
  jurisdiction TEXT,
  valid_from INTEGER,
  valid_until INTEGER,
  allowed_uses_json TEXT NOT NULL DEFAULT '[]',
  allowed_wording TEXT,
  supersedes_id TEXT,
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'runtime-proposal', 'complex-model-proposal')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (subject_party_id) REFERENCES case_parties(id) ON DELETE SET NULL,
  FOREIGN KEY (speaker_party_id) REFERENCES case_parties(id) ON DELETE SET NULL,
  FOREIGN KEY (supersedes_id) REFERENCES case_statements(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_case_statements_case_review
  ON case_statements(case_id, review_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS case_statement_sources (
  id TEXT PRIMARY KEY NOT NULL,
  statement_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('material', 'conversation', 'call-turn', 'user', 'kmb')),
  source_id TEXT NOT NULL,
  source_revision INTEGER,
  content_hash TEXT NOT NULL,
  page_number INTEGER,
  quoted_text TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (statement_id) REFERENCES case_statements(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_statement_sources_statement
  ON case_statement_sources(statement_id);

CREATE TABLE IF NOT EXISTS preparation_conversations (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  call_plan_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  head_revision INTEGER NOT NULL DEFAULT 0,
  generated_summary TEXT,
  generated_summary_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (call_plan_id) REFERENCES call_plans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_preparation_conversations_scope
  ON preparation_conversations(case_id, call_plan_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS preparation_messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  parent_message_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  material_refs_json TEXT NOT NULL DEFAULT '[]',
  proposed_artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  context_manifest_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('committed', 'superseded')),
  operation_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES preparation_conversations(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_message_id) REFERENCES preparation_messages(id) ON DELETE SET NULL,
  UNIQUE (conversation_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_preparation_messages_conversation_revision
  ON preparation_messages(conversation_id, revision);

CREATE TABLE IF NOT EXISTS pending_case_updates (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  call_session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('claim', 'commitment', 'deadline', 'reference-number', 'action')),
  proposed_statement_json TEXT NOT NULL,
  source_turn_ids_json TEXT NOT NULL DEFAULT '[]',
  review_state TEXT NOT NULL CHECK (review_state IN ('pending', 'accepted', 'edited', 'rejected')),
  row_revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (call_session_id) REFERENCES call_runtime_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pending_case_updates_case_review
  ON pending_case_updates(case_id, review_state, created_at DESC);

CREATE TABLE IF NOT EXISTS call_preparation_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  compile_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  case_revision_id TEXT NOT NULL,
  call_plan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft', 'ready', 'superseded', 'invalidated')),
  bundle_json TEXT NOT NULL,
  source_manifest_json TEXT NOT NULL,
  artifact_manifest_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  compiler_version TEXT NOT NULL,
  invalidation_reason TEXT,
  compiled_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (case_revision_id) REFERENCES case_revisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (call_plan_id) REFERENCES call_plans(id) ON DELETE CASCADE,
  UNIQUE (case_id, call_plan_id, version),
  UNIQUE (case_id, call_plan_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_call_snapshots_plan_version
  ON call_preparation_snapshots(call_plan_id, version DESC);

CREATE TABLE IF NOT EXISTS snapshot_artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  snapshot_id TEXT NOT NULL,
  lineage_key TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  section TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (snapshot_id) REFERENCES call_preparation_snapshots(id) ON DELETE CASCADE,
  UNIQUE (snapshot_id, artifact_path)
);

CREATE TABLE IF NOT EXISTS call_session_preparation_bindings (
  call_session_id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT,
  case_revision_id TEXT,
  call_plan_id TEXT,
  snapshot_id TEXT,
  snapshot_content_hash TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('prepared', 'neutral')),
  bound_at INTEGER NOT NULL,
  FOREIGN KEY (call_session_id) REFERENCES call_runtime_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE RESTRICT,
  FOREIGN KEY (case_revision_id) REFERENCES case_revisions(id) ON DELETE RESTRICT,
  FOREIGN KEY (call_plan_id) REFERENCES call_plans(id) ON DELETE RESTRICT,
  FOREIGN KEY (snapshot_id) REFERENCES call_preparation_snapshots(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS snapshot_artifact_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  call_session_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('stt', 'runtime', 'advisor', 'post-call')),
  status TEXT NOT NULL CHECK (status IN ('selected', 'dispatched', 'provider-returned', 'commit-authorized', 'visible', 'rejected', 'stale', 'failed', 'cancelled')),
  reason TEXT,
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (call_session_id) REFERENCES call_runtime_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id) REFERENCES call_preparation_snapshots(id) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_id) REFERENCES snapshot_artifacts(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_snapshot_receipts_session_operation
  ON snapshot_artifact_receipts(call_session_id, operation_id, occurred_at);

CREATE TABLE IF NOT EXISTS preparation_operation_events (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT,
  call_plan_id TEXT,
  operation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (call_plan_id) REFERENCES call_plans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_preparation_operations_case_time
  ON preparation_operation_events(case_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS preparation_human_evaluations (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL,
  call_session_id TEXT,
  snapshot_id TEXT,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (label IN ('helpful', 'irrelevant', 'polluting', 'over-constraining', 'incorrect', 'missing')),
  note TEXT,
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
  FOREIGN KEY (call_session_id) REFERENCES call_runtime_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id) REFERENCES call_preparation_snapshots(id) ON DELETE SET NULL
);

CREATE TRIGGER IF NOT EXISTS trg_cases_current_revision_scope
BEFORE UPDATE OF current_revision_id ON cases
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM case_revisions
    WHERE id = NEW.current_revision_id AND case_id = NEW.id
  ) THEN RAISE(ABORT, 'case current revision must belong to the same case') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_material_selected_run_scope
BEFORE UPDATE OF selected_extraction_run_id ON case_materials
WHEN NEW.selected_extraction_run_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM extraction_runs
    WHERE id = NEW.selected_extraction_run_id AND material_id = NEW.id
  ) THEN RAISE(ABORT, 'selected extraction run must belong to the same material') END;
END;
