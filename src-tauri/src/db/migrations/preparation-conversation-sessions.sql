CREATE TABLE preparation_conversations_v2 (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('process', 'round')),
    scope_key TEXT NOT NULL,
    round_id TEXT,
    title TEXT NOT NULL,
    title_source TEXT NOT NULL DEFAULT 'placeholder'
      CHECK(title_source IN ('placeholder', 'automatic', 'manual')),
    status TEXT NOT NULL CHECK(status IN ('active', 'archived')),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    active_operation_id TEXT,
    head_message_id TEXT,
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
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE CASCADE
);

INSERT INTO preparation_conversations_v2 (
    id, process_id, scope_kind, scope_key, round_id, title, title_source,
    status, revision, active_operation_id, head_message_id, rolling_summary,
    summary_revision, summary_through_message_id, created_at, updated_at,
    archived_at
)
SELECT
    id, process_id, scope_kind, scope_key, round_id, title, 'automatic',
    status, revision, active_operation_id, NULL, rolling_summary,
    summary_revision, summary_through_message_id, created_at, updated_at,
    archived_at
FROM preparation_conversations;

CREATE TABLE preparation_messages_backup (
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
    request_metadata_json TEXT NOT NULL DEFAULT '{}',
    operation_id TEXT,
    parent_message_id TEXT,
    supersedes_message_id TEXT,
    created_at INTEGER NOT NULL,
    committed_at INTEGER
);

INSERT INTO preparation_messages_backup (
    id, conversation_id, logical_turn_id, role, status, content,
    material_refs_json, source_refs_json, model_execution_ref,
    context_snapshot_json, request_metadata_json, operation_id,
    parent_message_id, supersedes_message_id, created_at, committed_at
)
SELECT
    id, conversation_id, logical_turn_id, role, status, content,
    material_refs_json, source_refs_json, model_execution_ref,
    context_snapshot_json, '{}', operation_id,
    LAG(id) OVER (
      PARTITION BY conversation_id
      ORDER BY created_at ASC, id ASC
    ),
    NULL, created_at, committed_at
FROM preparation_messages;

UPDATE preparation_conversations_v2
SET head_message_id = (
  SELECT message.id
  FROM preparation_messages_backup message
  WHERE message.conversation_id = preparation_conversations_v2.id
    AND message.status = 'committed'
  ORDER BY message.created_at DESC, message.id DESC
  LIMIT 1
);

DROP TABLE preparation_messages;
DROP TABLE preparation_conversations;

ALTER TABLE preparation_conversations_v2 RENAME TO preparation_conversations;

CREATE TABLE preparation_messages (
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
    request_metadata_json TEXT NOT NULL DEFAULT '{}',
    operation_id TEXT,
    parent_message_id TEXT,
    supersedes_message_id TEXT,
    created_at INTEGER NOT NULL,
    committed_at INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES preparation_conversations(id) ON DELETE CASCADE
);

INSERT INTO preparation_messages (
    id, conversation_id, logical_turn_id, role, status, content,
    material_refs_json, source_refs_json, model_execution_ref,
    context_snapshot_json, request_metadata_json, operation_id,
    parent_message_id, supersedes_message_id, created_at, committed_at
)
SELECT
    id, conversation_id, logical_turn_id, role, status, content,
    material_refs_json, source_refs_json, model_execution_ref,
    context_snapshot_json, request_metadata_json, operation_id,
    parent_message_id, supersedes_message_id, created_at, committed_at
FROM preparation_messages_backup;

DROP TABLE preparation_messages_backup;

CREATE INDEX idx_preparation_conversations_process_updated
ON preparation_conversations(process_id, updated_at DESC);

CREATE INDEX idx_preparation_conversations_round
ON preparation_conversations(process_id, round_id, updated_at DESC);

CREATE INDEX idx_preparation_conversations_scope
ON preparation_conversations(process_id, scope_kind, round_id, updated_at DESC);

CREATE INDEX idx_preparation_messages_conversation_created
ON preparation_messages(conversation_id, status, created_at ASC);

CREATE INDEX idx_preparation_messages_operation
ON preparation_messages(conversation_id, operation_id, status);

CREATE INDEX idx_preparation_messages_parent
ON preparation_messages(conversation_id, parent_message_id);
