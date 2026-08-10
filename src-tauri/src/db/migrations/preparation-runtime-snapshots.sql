PRAGMA foreign_keys = ON;

CREATE TABLE interview_preparation_snapshots (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    profile_revision_id TEXT NOT NULL,
    profile_revision INTEGER NOT NULL CHECK(profile_revision > 0),
    compiler_version TEXT NOT NULL,
    playbook_registry_version TEXT NOT NULL,
    runtime_capability_version TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    runtime_char_count INTEGER NOT NULL CHECK(runtime_char_count >= 0),
    snapshot_json TEXT NOT NULL,
    source_manifest_json TEXT NOT NULL,
    warnings_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'ready', 'active', 'superseded', 'invalidated'
    )),
    build_status TEXT NOT NULL CHECK(build_status IN (
        'staging', 'committed', 'failed'
    )),
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE,
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE CASCADE,
    FOREIGN KEY (profile_revision_id) REFERENCES interview_preparation_profile_revisions(id) ON DELETE RESTRICT,
    UNIQUE(process_id, round_id, version),
    UNIQUE(process_id, round_id, content_hash)
);

CREATE INDEX idx_interview_preparation_snapshots_round
ON interview_preparation_snapshots(
    process_id, round_id, build_status, status, version DESC
);

CREATE UNIQUE INDEX idx_interview_preparation_snapshots_active
ON interview_preparation_snapshots(process_id, round_id)
WHERE build_status = 'committed' AND status = 'active';

CREATE TABLE preparation_snapshot_statement_links (
    snapshot_id TEXT NOT NULL,
    statement_id TEXT NOT NULL,
    statement_revision INTEGER NOT NULL CHECK(statement_revision >= 0),
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    PRIMARY KEY (snapshot_id, statement_id),
    FOREIGN KEY (snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE CASCADE,
    FOREIGN KEY (statement_id) REFERENCES preparation_statements(id) ON DELETE RESTRICT
);

CREATE TABLE preparation_snapshot_narrative_node_links (
    snapshot_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    node_revision INTEGER NOT NULL CHECK(node_revision >= 0),
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    PRIMARY KEY (snapshot_id, node_id),
    FOREIGN KEY (snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE CASCADE,
    FOREIGN KEY (node_id) REFERENCES preparation_narrative_nodes(id) ON DELETE RESTRICT
);

CREATE TABLE preparation_snapshot_material_revision_links (
    snapshot_id TEXT NOT NULL,
    material_id TEXT NOT NULL,
    material_revision_id TEXT NOT NULL,
    source_checksum_sha256 TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    PRIMARY KEY (snapshot_id, material_id, material_revision_id),
    FOREIGN KEY (snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE CASCADE,
    FOREIGN KEY (material_id) REFERENCES preparation_materials(id) ON DELETE RESTRICT,
    FOREIGN KEY (material_revision_id) REFERENCES preparation_material_revisions(id) ON DELETE RESTRICT
);

CREATE TABLE preparation_snapshot_kmb_entry_links (
    snapshot_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    PRIMARY KEY (snapshot_id, entry_id),
    FOREIGN KEY (snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES memory_entries(id) ON DELETE RESTRICT
);

CREATE TABLE preparation_snapshot_activation_events (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    previous_snapshot_id TEXT,
    action TEXT NOT NULL CHECK(action IN ('activated', 'reactivated')),
    created_at INTEGER NOT NULL,
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE,
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE CASCADE,
    FOREIGN KEY (snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE RESTRICT,
    FOREIGN KEY (previous_snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE SET NULL
);

CREATE INDEX idx_preparation_snapshot_activation_events_round
ON preparation_snapshot_activation_events(process_id, round_id, created_at DESC);

-- Snapshot content and source pins are immutable. Only lifecycle metadata may change.
CREATE TRIGGER preparation_snapshot_rejects_content_mutation
BEFORE UPDATE OF
    process_id, round_id, version, profile_revision_id, profile_revision,
    compiler_version, playbook_registry_version, runtime_capability_version,
    source_fingerprint, content_hash, runtime_char_count, snapshot_json,
    source_manifest_json, warnings_json, created_at
ON interview_preparation_snapshots
BEGIN
    SELECT RAISE(ABORT, 'Preparation snapshot content is immutable.');
END;

-- One statement atomically records activation and supersedes the prior selection.
CREATE TRIGGER preparation_snapshot_before_activation
BEFORE UPDATE OF status ON interview_preparation_snapshots
WHEN NEW.status = 'active' AND OLD.status <> 'active'
BEGIN
    INSERT INTO preparation_snapshot_activation_events
      (id, process_id, round_id, snapshot_id, previous_snapshot_id, action, created_at)
    VALUES
      (NEW.id || ':' || NEW.activated_at || ':' ||
       (SELECT COUNT(*) FROM preparation_snapshot_activation_events
        WHERE snapshot_id = NEW.id),
       NEW.process_id,
       NEW.round_id,
       NEW.id,
       (SELECT id FROM interview_preparation_snapshots
        WHERE process_id = NEW.process_id AND round_id = NEW.round_id
          AND build_status = 'committed' AND status = 'active'
        LIMIT 1),
       CASE WHEN OLD.status = 'superseded' THEN 'reactivated' ELSE 'activated' END,
       NEW.activated_at);

    UPDATE interview_preparation_snapshots
    SET status = 'superseded'
    WHERE process_id = NEW.process_id AND round_id = NEW.round_id
      AND id <> NEW.id AND build_status = 'committed' AND status = 'active';
END;
