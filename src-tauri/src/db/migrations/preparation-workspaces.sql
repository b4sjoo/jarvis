PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS preparation_workspaces (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('interview', 'case')),
    title TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'archived', 'deleting')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_preparation_workspaces_kind_status_updated
ON preparation_workspaces(kind, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS preparation_materials (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('workspace', 'round')),
    scope_id TEXT,
    display_name TEXT NOT NULL,
    original_file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    extension TEXT,
    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
    checksum_sha256 TEXT NOT NULL,
    storage_relative_path TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'received', 'extracting', 'ready', 'needs-review', 'unsupported', 'failed', 'deleted'
    )),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES preparation_workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_preparation_materials_workspace_status
ON preparation_materials(workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_preparation_materials_checksum
ON preparation_materials(workspace_id, checksum_sha256);

CREATE TABLE IF NOT EXISTS preparation_material_revisions (
    id TEXT PRIMARY KEY,
    material_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    source_checksum_sha256 TEXT NOT NULL,
    extraction_status TEXT NOT NULL CHECK(extraction_status IN (
        'pending', 'extracting', 'ready', 'needs-review', 'unsupported', 'failed'
    )),
    extracted_text_relative_path TEXT,
    extraction_metadata TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    FOREIGN KEY (material_id) REFERENCES preparation_materials(id) ON DELETE CASCADE,
    UNIQUE(material_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_preparation_material_revisions_material_revision
ON preparation_material_revisions(material_id, revision DESC);

CREATE TABLE IF NOT EXISTS preparation_source_refs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    material_id TEXT,
    material_revision_id TEXT,
    source_kind TEXT NOT NULL CHECK(source_kind IN (
        'user-upload', 'screenshot', 'pasted-image', 'pasted-text', 'job-url', 'kmb-entry'
    )),
    locator TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES preparation_workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES preparation_materials(id) ON DELETE CASCADE,
    FOREIGN KEY (material_revision_id) REFERENCES preparation_material_revisions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_preparation_source_refs_workspace
ON preparation_source_refs(workspace_id, created_at DESC);
