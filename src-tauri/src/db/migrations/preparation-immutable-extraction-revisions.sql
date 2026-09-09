ALTER TABLE preparation_materials ADD COLUMN selected_revision_id TEXT
    REFERENCES preparation_material_revisions(id) ON DELETE SET NULL;
ALTER TABLE preparation_materials ADD COLUMN candidate_revision_id TEXT
    REFERENCES preparation_material_revisions(id) ON DELETE SET NULL;
ALTER TABLE preparation_material_revisions ADD COLUMN output_hash TEXT;
ALTER TABLE preparation_snapshot_material_revision_links ADD COLUMN output_hash TEXT;
CREATE INDEX idx_preparation_material_review_revision
    ON preparation_material_review_events(material_revision_id);

-- Preserve the old visible revision once, without inventing discarded output.
UPDATE preparation_materials SET candidate_revision_id = (
    SELECT id FROM preparation_material_revisions
    WHERE material_id = preparation_materials.id ORDER BY revision DESC LIMIT 1
);
UPDATE preparation_materials SET selected_revision_id = candidate_revision_id
WHERE EXISTS (
    SELECT 1 FROM preparation_material_revisions r
    WHERE r.id = candidate_revision_id AND r.extraction_status IN ('ready', 'needs-review')
);

CREATE TRIGGER preparation_material_initial_candidate
AFTER INSERT ON preparation_material_revisions
WHEN (SELECT candidate_revision_id FROM preparation_materials WHERE id = NEW.material_id) IS NULL
BEGIN
    UPDATE preparation_materials SET candidate_revision_id = NEW.id WHERE id = NEW.material_id;
END;

CREATE TRIGGER preparation_material_pointer_owner
BEFORE UPDATE OF selected_revision_id, candidate_revision_id ON preparation_materials
BEGIN
    SELECT CASE WHEN NEW.candidate_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM preparation_material_revisions WHERE id = NEW.candidate_revision_id AND material_id = NEW.id
    ) THEN RAISE(ABORT, 'Extraction candidate belongs to another material.') END;
    SELECT CASE WHEN NEW.selected_revision_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM preparation_material_revisions WHERE id = NEW.selected_revision_id AND material_id = NEW.id
          AND extraction_status IN ('ready', 'needs-review')
    ) THEN RAISE(ABORT, 'Selected extraction must be a completed material revision.') END;
END;

CREATE TRIGGER preparation_extraction_content_immutable
BEFORE UPDATE OF material_id, revision, source_checksum_sha256, extraction_request_id,
    extraction_status, extraction_started_at, extracted_text_relative_path, extraction_metadata,
    completed_at, derived_from_revision_id ON preparation_material_revisions
WHEN OLD.extraction_status IN ('ready', 'needs-review', 'unsupported')
BEGIN
    SELECT RAISE(ABORT, 'Completed extraction content is immutable.');
END;
CREATE TRIGGER preparation_extraction_hash_immutable
BEFORE UPDATE OF output_hash ON preparation_material_revisions
WHEN OLD.output_hash IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'Extraction output hash is immutable.');
END;
CREATE TRIGGER preparation_extraction_chunk_insert
BEFORE INSERT ON preparation_material_chunks
WHEN NOT EXISTS (
    SELECT 1 FROM preparation_material_revisions r JOIN preparation_materials m ON m.id = r.material_id
    WHERE r.id = NEW.material_revision_id AND r.material_id = NEW.material_id
      AND m.workspace_id = NEW.workspace_id AND r.extraction_request_id = NEW.extraction_request_id
      AND r.extraction_status = 'extracting'
)
BEGIN
    SELECT RAISE(ABORT, 'Chunks require their unfinished extraction owner.');
END;
CREATE TRIGGER preparation_extraction_chunk_update
BEFORE UPDATE ON preparation_material_chunks
BEGIN
    SELECT RAISE(ABORT, 'Extraction chunks are append-only.');
END;
CREATE TRIGGER preparation_extraction_chunk_delete
BEFORE DELETE ON preparation_material_chunks
WHEN EXISTS (
    SELECT 1 FROM preparation_material_revisions r JOIN preparation_materials m ON m.id = r.material_id
    JOIN preparation_workspaces w ON w.id = m.workspace_id
    WHERE r.id = OLD.material_revision_id AND r.extraction_status IN ('ready', 'needs-review', 'unsupported')
      AND m.status <> 'deleted' AND m.deleted_at IS NULL AND w.status <> 'deleting'
)
BEGIN
    SELECT RAISE(ABORT, 'Completed extraction chunks must be retained.');
END;

-- One material-only predicate serves compilation and activation, including no-op activation.
CREATE VIEW preparation_snapshot_invalid_material_pins AS
SELECT snapshot.id AS snapshot_id FROM interview_preparation_snapshots snapshot WHERE
      (SELECT COUNT(*) FROM json_each(snapshot.source_manifest_json, '$.materials')) <>
      (SELECT COUNT(*) FROM preparation_snapshot_material_revision_links WHERE snapshot_id = snapshot.id)
      OR EXISTS (
        SELECT 1 FROM json_each(snapshot.source_manifest_json, '$.materials') pin
        WHERE NOT EXISTS (
          SELECT 1 FROM preparation_snapshot_material_revision_links link
          JOIN preparation_material_revisions r ON r.id = link.material_revision_id
          JOIN preparation_materials m ON m.id = r.material_id
          JOIN interview_processes p ON p.workspace_id = m.workspace_id
          JOIN preparation_workspaces w ON w.id = m.workspace_id
          WHERE link.snapshot_id = snapshot.id AND p.id = snapshot.process_id AND w.status = 'active'
            AND link.material_id = m.id AND link.material_id = json_extract(pin.value, '$.materialId')
            AND link.material_revision_id = json_extract(pin.value, '$.materialRevisionId')
            AND link.source_checksum_sha256 = json_extract(pin.value, '$.sourceChecksumSha256')
            AND link.source_checksum_sha256 = r.source_checksum_sha256
            AND m.checksum_sha256 = r.source_checksum_sha256
            AND link.output_hash IS NOT NULL AND link.output_hash = r.output_hash
            AND link.output_hash = json_extract(pin.value, '$.outputHash')
            AND m.selected_revision_id = r.id AND m.status = 'ready' AND m.deleted_at IS NULL
            AND (m.scope_kind = 'workspace' OR m.scope_id = snapshot.round_id)
            AND ((r.extraction_status = 'ready' AND r.review_status IN ('unreviewed', 'approved'))
              OR (r.extraction_status = 'needs-review' AND r.review_status = 'approved'))
        )
      );

CREATE TRIGGER preparation_snapshot_material_pin_commit
BEFORE UPDATE OF build_status, status ON interview_preparation_snapshots
WHEN NEW.build_status = 'committed' AND
    (OLD.build_status <> 'committed' OR NEW.status = 'active')
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM preparation_snapshot_invalid_material_pins WHERE snapshot_id = NEW.id)
      THEN RAISE(ABORT, 'Snapshot material output pin is unavailable or unverified.') END;
END;

CREATE TRIGGER preparation_snapshot_material_pin_activation
BEFORE UPDATE OF selected_snapshot_id ON interview_preparation_current_context
WHEN NEW.selected_snapshot_id IS NOT NULL
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM preparation_snapshot_invalid_material_pins WHERE snapshot_id = NEW.selected_snapshot_id)
      THEN RAISE(ABORT, 'Snapshot material output pin is unavailable or unverified.') END;
END;

CREATE TRIGGER preparation_snapshot_material_pin_update
BEFORE UPDATE ON preparation_snapshot_material_revision_links
WHEN EXISTS (SELECT 1 FROM interview_preparation_snapshots WHERE id = OLD.snapshot_id AND build_status = 'committed')
BEGIN
    SELECT RAISE(ABORT, 'Committed material pins are immutable.');
END;
CREATE TRIGGER preparation_snapshot_material_pin_insert
BEFORE INSERT ON preparation_snapshot_material_revision_links
WHEN EXISTS (SELECT 1 FROM interview_preparation_snapshots WHERE id = NEW.snapshot_id AND build_status = 'committed')
BEGIN
    SELECT RAISE(ABORT, 'Committed material pins are immutable.');
END;

CREATE TRIGGER preparation_snapshot_material_pin_delete
BEFORE DELETE ON preparation_snapshot_material_revision_links
WHEN EXISTS (SELECT 1 FROM interview_preparation_snapshots WHERE id = OLD.snapshot_id AND build_status = 'committed')
BEGIN
    SELECT RAISE(ABORT, 'Committed material pins are immutable.');
END;

CREATE TRIGGER preparation_extraction_revision_delete
BEFORE DELETE ON preparation_material_revisions
WHEN OLD.extraction_status IN ('ready', 'needs-review', 'unsupported') AND EXISTS (
    SELECT 1 FROM preparation_materials m WHERE m.id = OLD.material_id AND m.status <> 'deleted' AND m.deleted_at IS NULL
)
BEGIN
    SELECT RAISE(ABORT, 'Completed extraction revisions must be retained.');
END;
