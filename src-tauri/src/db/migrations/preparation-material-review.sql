ALTER TABLE preparation_material_revisions
ADD COLUMN review_status TEXT NOT NULL DEFAULT 'unreviewed'
CHECK(review_status IN ('unreviewed', 'needs-review', 'approved'));

ALTER TABLE preparation_material_revisions
ADD COLUMN review_actor TEXT
CHECK(review_actor IS NULL OR review_actor IN ('runtime', 'model', 'user'));

ALTER TABLE preparation_material_revisions
ADD COLUMN review_updated_at INTEGER;

ALTER TABLE preparation_material_revisions
ADD COLUMN quality_signals_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE preparation_material_revisions
ADD COLUMN derived_from_revision_id TEXT;

UPDATE preparation_material_revisions
SET review_status = 'needs-review',
    review_actor = 'runtime',
    review_updated_at = COALESCE(completed_at, created_at)
WHERE extraction_status = 'needs-review';

CREATE TABLE preparation_material_review_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    material_id TEXT NOT NULL,
    material_revision_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN (
        'quality-flagged', 'recovery-created', 'manual-content-created', 'approved'
    )),
    actor TEXT NOT NULL CHECK(actor IN ('runtime', 'model', 'user')),
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    detail TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (workspace_id) REFERENCES preparation_workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES preparation_materials(id) ON DELETE CASCADE,
    FOREIGN KEY (material_revision_id) REFERENCES preparation_material_revisions(id) ON DELETE CASCADE
);

CREATE INDEX idx_preparation_material_review_events_material
ON preparation_material_review_events(material_id, created_at DESC);

CREATE INDEX idx_preparation_material_revisions_review
ON preparation_material_revisions(material_id, review_status, revision DESC);
