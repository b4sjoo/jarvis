PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS interview_processes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL UNIQUE,
    company TEXT,
    role TEXT,
    active_round_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES preparation_workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interview_processes_updated
ON interview_processes(updated_at DESC);

CREATE TABLE IF NOT EXISTS interview_rounds (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    title TEXT NOT NULL,
    stage TEXT NOT NULL CHECK(stage IN (
        'recruiter-screen', 'hiring-manager', 'behavioral', 'coding',
        'general-system-design', 'ai-ml-system-design', 'project-deep-dive',
        'mixed', 'other'
    )),
    expected_interview_types TEXT NOT NULL,
    expected_type_policy TEXT NOT NULL CHECK(expected_type_policy IN ('advisory', 'restricted')),
    scheduled_at INTEGER,
    interviewer_name TEXT,
    interviewer_role TEXT,
    preferred_programming_language TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interview_rounds_process_updated
ON interview_rounds(process_id, archived_at, updated_at DESC);
