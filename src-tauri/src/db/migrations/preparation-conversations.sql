PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS preparation_conversations (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('process', 'round')),
    scope_key TEXT NOT NULL,
    round_id TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    active_operation_id TEXT,
    rolling_summary TEXT,
    summary_revision INTEGER NOT NULL DEFAULT 0 CHECK(summary_revision >= 0),
    summary_through_message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    CHECK(
      (scope_kind = 'process' AND scope_key = 'process' AND round_id IS NULL)
      OR
      (scope_kind = 'round' AND round_id IS NOT NULL AND scope_key = round_id)
    ),
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE,
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE CASCADE,
    UNIQUE(process_id, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_preparation_conversations_process_updated
ON preparation_conversations(process_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_preparation_conversations_round
ON preparation_conversations(process_id, round_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS preparation_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    logical_turn_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    status TEXT NOT NULL CHECK(status IN ('pending', 'committed')),
    content TEXT NOT NULL CHECK(length(trim(content)) > 0),
    material_refs_json TEXT NOT NULL DEFAULT '[]',
    source_refs_json TEXT NOT NULL DEFAULT '[]',
    model_execution_ref TEXT,
    context_snapshot_json TEXT,
    operation_id TEXT,
    created_at INTEGER NOT NULL,
    committed_at INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES preparation_conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_preparation_messages_conversation_created
ON preparation_messages(conversation_id, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_preparation_messages_operation
ON preparation_messages(conversation_id, operation_id, status);
