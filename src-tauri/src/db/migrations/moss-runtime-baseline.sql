CREATE TABLE IF NOT EXISTS call_runtime_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'planned', 'starting', 'live', 'paused', 'recovering',
      'closing', 'closed', 'start-failed', 'close-failed', 'abandoned'
    )
  ),
  runtime_epoch INTEGER NOT NULL DEFAULT 0,
  logical_revision INTEGER NOT NULL DEFAULT 0,
  recording_path TEXT,
  close_error TEXT,
  started_at INTEGER,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS call_runtime_events (
  id TEXT PRIMARY KEY NOT NULL,
  call_session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  FOREIGN KEY (call_session_id) REFERENCES call_runtime_sessions(id) ON DELETE CASCADE,
  UNIQUE (call_session_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_call_runtime_events_session_sequence
  ON call_runtime_events(call_session_id, sequence);

CREATE TABLE IF NOT EXISTS call_recording_close_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  call_session_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('closing', 'closed', 'failed', 'abandoned')),
  error TEXT,
  attempted_at INTEGER NOT NULL,
  settled_at INTEGER,
  FOREIGN KEY (call_session_id) REFERENCES call_runtime_sessions(id) ON DELETE CASCADE,
  UNIQUE (call_session_id, attempt)
);
