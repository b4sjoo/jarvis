CREATE TABLE IF NOT EXISTS memory_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'project',
    entry_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS memory_sources (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    collection TEXT NOT NULL,
    source_origin TEXT NOT NULL,
    source_format TEXT NOT NULL,
    source_role TEXT NOT NULL,
    original_path TEXT,
    scope TEXT NOT NULL,
    project_id TEXT,
    project_name TEXT,
    confidentiality TEXT NOT NULL,
    canonicality TEXT NOT NULL,
    raw_injection_policy TEXT NOT NULL,
    curation_status TEXT NOT NULL,
    checksum TEXT,
    draft_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_sources_collection
    ON memory_sources(collection);

CREATE INDEX IF NOT EXISTS idx_memory_sources_project
    ON memory_sources(project_id);

CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    source_ids TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    scope TEXT NOT NULL,
    project_id TEXT,
    project_name TEXT,
    tags TEXT NOT NULL,
    keywords TEXT NOT NULL,
    priority TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    injection_mode TEXT NOT NULL,
    use_cases TEXT NOT NULL,
    confidentiality TEXT NOT NULL,
    curation_status TEXT NOT NULL,
    related_entry_ids TEXT NOT NULL,
    evidence_entry_ids TEXT NOT NULL,
    draft_path TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_enabled
    ON memory_entries(enabled);

CREATE INDEX IF NOT EXISTS idx_memory_entries_scope
    ON memory_entries(scope);

CREATE INDEX IF NOT EXISTS idx_memory_entries_project
    ON memory_entries(project_id);

CREATE INDEX IF NOT EXISTS idx_memory_entries_type
    ON memory_entries(type);

CREATE INDEX IF NOT EXISTS idx_memory_entries_priority
    ON memory_entries(priority);
