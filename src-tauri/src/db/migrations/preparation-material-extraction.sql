ALTER TABLE preparation_material_revisions
ADD COLUMN extraction_request_id TEXT;

ALTER TABLE preparation_material_revisions
ADD COLUMN extraction_started_at INTEGER;

CREATE TABLE IF NOT EXISTS preparation_material_chunks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    material_id TEXT NOT NULL,
    material_revision_id TEXT NOT NULL,
    extraction_request_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    content TEXT NOT NULL CHECK(length(content) > 0),
    search_text TEXT NOT NULL,
    page INTEGER CHECK(page IS NULL OR page > 0),
    section TEXT,
    start_offset INTEGER CHECK(start_offset IS NULL OR start_offset >= 0),
    end_offset INTEGER CHECK(end_offset IS NULL OR end_offset >= 0),
    created_at INTEGER NOT NULL,
    CHECK(end_offset IS NULL OR start_offset IS NULL OR end_offset >= start_offset),
    FOREIGN KEY (workspace_id) REFERENCES preparation_workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES preparation_materials(id) ON DELETE CASCADE,
    FOREIGN KEY (material_revision_id) REFERENCES preparation_material_revisions(id) ON DELETE CASCADE,
    UNIQUE(material_revision_id, extraction_request_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_preparation_material_chunks_revision_request
ON preparation_material_chunks(material_revision_id, extraction_request_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_preparation_material_chunks_workspace_material
ON preparation_material_chunks(workspace_id, material_id, ordinal);
