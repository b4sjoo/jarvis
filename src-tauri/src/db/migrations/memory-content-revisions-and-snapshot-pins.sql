-- Content moves once; logical rows retain user policy and current pointers.
ALTER TABLE memory_sources ADD COLUMN current_content_revision INTEGER DEFAULT 1;
CREATE TABLE memory_source_revisions (
    source_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    content_hash TEXT,
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
    PRIMARY KEY (source_id, revision),
    UNIQUE (source_id, content_hash),
    FOREIGN KEY (source_id) REFERENCES memory_sources(id) ON DELETE CASCADE
);
INSERT INTO memory_source_revisions (source_id, revision, title, collection, source_origin, source_format, source_role, original_path, scope, project_id, project_name, confidentiality, canonicality, raw_injection_policy, curation_status, checksum, draft_path, created_at)
SELECT id, 1, title, collection, source_origin, source_format, source_role, original_path, scope, project_id, project_name, confidentiality, canonicality, raw_injection_policy, curation_status, checksum, draft_path, created_at FROM memory_sources;
DROP INDEX idx_memory_sources_collection;
DROP INDEX idx_memory_sources_project;
ALTER TABLE memory_sources DROP COLUMN title;
ALTER TABLE memory_sources DROP COLUMN collection;
ALTER TABLE memory_sources DROP COLUMN source_origin;
ALTER TABLE memory_sources DROP COLUMN source_format;
ALTER TABLE memory_sources DROP COLUMN source_role;
ALTER TABLE memory_sources DROP COLUMN original_path;
ALTER TABLE memory_sources DROP COLUMN scope;
ALTER TABLE memory_sources DROP COLUMN project_id;
ALTER TABLE memory_sources DROP COLUMN project_name;
ALTER TABLE memory_sources DROP COLUMN confidentiality;
ALTER TABLE memory_sources DROP COLUMN canonicality;
ALTER TABLE memory_sources DROP COLUMN raw_injection_policy;
ALTER TABLE memory_sources DROP COLUMN curation_status;
ALTER TABLE memory_sources DROP COLUMN checksum;
ALTER TABLE memory_sources DROP COLUMN draft_path;
CREATE TRIGGER memory_source_revisions_immutable
BEFORE UPDATE ON memory_source_revisions WHEN OLD.content_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'KMB content revisions are immutable.'); END;
CREATE TRIGGER memory_source_revisions_retained
BEFORE DELETE ON memory_source_revisions WHEN EXISTS (SELECT 1 FROM memory_sources WHERE id=OLD.source_id)
BEGIN SELECT RAISE(ABORT, 'KMB content revisions must be retained.'); END;
CREATE TRIGGER memory_sources_current_owner
BEFORE UPDATE OF current_content_revision ON memory_sources
WHEN NEW.current_content_revision IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM memory_source_revisions WHERE source_id=NEW.id AND revision=NEW.current_content_revision AND content_hash IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'KMB current revision is unavailable.'); END;

ALTER TABLE memory_entries ADD COLUMN current_content_revision INTEGER DEFAULT 1;
CREATE TABLE memory_entry_revisions (
    entry_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    content_hash TEXT,
    source_revisions_json TEXT,
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
    injection_mode TEXT NOT NULL,
    use_cases TEXT NOT NULL,
    interview_families TEXT,
    confidentiality TEXT NOT NULL,
    curation_status TEXT NOT NULL,
    related_entry_ids TEXT NOT NULL,
    evidence_entry_ids TEXT NOT NULL,
    draft_path TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (entry_id, revision),
    UNIQUE (entry_id, content_hash),
    FOREIGN KEY (entry_id) REFERENCES memory_entries(id) ON DELETE CASCADE
);
INSERT INTO memory_entry_revisions (entry_id, revision, source_ids, type, title, content, summary, scope, project_id, project_name, tags, keywords, priority, injection_mode, use_cases, interview_families, confidentiality, curation_status, related_entry_ids, evidence_entry_ids, draft_path, created_at)
SELECT id, 1, source_ids, type, title, content, summary, scope, project_id, project_name, tags, keywords, priority, injection_mode, use_cases, interview_families, confidentiality, curation_status, related_entry_ids, evidence_entry_ids, draft_path, created_at FROM memory_entries;
DROP INDEX idx_memory_entries_scope;
DROP INDEX idx_memory_entries_project;
DROP INDEX idx_memory_entries_type;
DROP INDEX idx_memory_entries_priority;
ALTER TABLE memory_entries DROP COLUMN source_ids;
ALTER TABLE memory_entries DROP COLUMN type;
ALTER TABLE memory_entries DROP COLUMN title;
ALTER TABLE memory_entries DROP COLUMN content;
ALTER TABLE memory_entries DROP COLUMN summary;
ALTER TABLE memory_entries DROP COLUMN scope;
ALTER TABLE memory_entries DROP COLUMN project_id;
ALTER TABLE memory_entries DROP COLUMN project_name;
ALTER TABLE memory_entries DROP COLUMN tags;
ALTER TABLE memory_entries DROP COLUMN keywords;
ALTER TABLE memory_entries DROP COLUMN priority;
ALTER TABLE memory_entries DROP COLUMN injection_mode;
ALTER TABLE memory_entries DROP COLUMN use_cases;
ALTER TABLE memory_entries DROP COLUMN interview_families;
ALTER TABLE memory_entries DROP COLUMN confidentiality;
ALTER TABLE memory_entries DROP COLUMN curation_status;
ALTER TABLE memory_entries DROP COLUMN related_entry_ids;
ALTER TABLE memory_entries DROP COLUMN evidence_entry_ids;
ALTER TABLE memory_entries DROP COLUMN draft_path;
CREATE TRIGGER memory_entry_revisions_immutable
BEFORE UPDATE ON memory_entry_revisions WHEN OLD.content_hash IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'KMB content revisions are immutable.'); END;
CREATE TRIGGER memory_entry_revisions_retained
BEFORE DELETE ON memory_entry_revisions WHEN EXISTS (SELECT 1 FROM memory_entries WHERE id=OLD.entry_id)
BEGIN SELECT RAISE(ABORT, 'KMB content revisions must be retained.'); END;
CREATE TRIGGER memory_entries_current_owner
BEFORE UPDATE OF current_content_revision ON memory_entries
WHEN NEW.current_content_revision IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM memory_entry_revisions WHERE entry_id=NEW.id AND revision=NEW.current_content_revision AND content_hash IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'KMB current revision is unavailable.'); END;

CREATE INDEX idx_memory_entry_revisions_scope ON memory_entry_revisions(scope, project_id, type);
CREATE INDEX idx_memory_entry_revisions_priority ON memory_entry_revisions(priority, project_name, title);
CREATE INDEX idx_memory_source_revisions_collection ON memory_source_revisions(collection, project_name, title);
CREATE TRIGGER memory_source_lineage_retained
BEFORE DELETE ON memory_sources
WHEN EXISTS (
 SELECT 1 FROM memory_entry_revisions entry, json_each(entry.source_revisions_json) pin
 WHERE pin.key=OLD.id
)
BEGIN SELECT RAISE(ABORT, 'KMB source is retained by an entry revision.'); END;

ALTER TABLE preparation_snapshot_kmb_entry_links RENAME TO preparation_snapshot_kmb_entry_links_legacy;
CREATE TABLE preparation_snapshot_kmb_entry_links (
 snapshot_id TEXT NOT NULL,
 entry_id TEXT NOT NULL,
 entry_revision INTEGER,
 content_hash TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
 PRIMARY KEY(snapshot_id, entry_id),
 FOREIGN KEY(snapshot_id) REFERENCES interview_preparation_snapshots(id) ON DELETE CASCADE,
 FOREIGN KEY(entry_id) REFERENCES memory_entries(id) ON DELETE RESTRICT,
 FOREIGN KEY(entry_id, entry_revision) REFERENCES memory_entry_revisions(entry_id, revision) ON DELETE RESTRICT
);
INSERT INTO preparation_snapshot_kmb_entry_links (snapshot_id, entry_id, content_hash, ordinal)
SELECT snapshot_id, entry_id, content_hash, ordinal FROM preparation_snapshot_kmb_entry_links_legacy;
DROP TABLE preparation_snapshot_kmb_entry_links_legacy;

ALTER TABLE interview_preparation_snapshots ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE preparation_statement_sources ADD COLUMN kmb_entry_revision INTEGER;
CREATE TRIGGER preparation_snapshot_schema_immutable
BEFORE UPDATE OF schema_version ON interview_preparation_snapshots
BEGIN SELECT RAISE(ABORT, 'Snapshot schema version is immutable.'); END;

CREATE VIEW preparation_snapshot_invalid_kmb_pins AS
SELECT snapshot.id AS snapshot_id FROM interview_preparation_snapshots snapshot
WHERE snapshot.schema_version NOT IN (1, 2)
 OR (snapshot.schema_version=2 AND json_extract(snapshot.snapshot_json,'$.schemaVersion') IS NOT 2)
 OR (SELECT COUNT(*) FROM json_each(snapshot.source_manifest_json,'$.kmbEntries')) <>
    (SELECT COUNT(*) FROM preparation_snapshot_kmb_entry_links WHERE snapshot_id=snapshot.id)
 OR EXISTS (
 SELECT 1 FROM json_each(snapshot.source_manifest_json,'$.kmbEntries') pin
 WHERE NOT EXISTS (
   SELECT 1 FROM preparation_snapshot_kmb_entry_links link
   JOIN memory_entries entry ON entry.id=link.entry_id
   JOIN memory_entry_revisions content ON content.entry_id=entry.id AND content.revision=link.entry_revision
   WHERE link.snapshot_id=snapshot.id AND snapshot.schema_version=2
    AND link.entry_id=json_extract(pin.value,'$.entryId')
    AND link.entry_revision=json_extract(pin.value,'$.entryRevision')
    AND link.content_hash=json_extract(pin.value,'$.contentHash')
    AND content.content_hash=link.content_hash AND entry.enabled=1
    AND entry.current_content_revision=content.revision
    AND content.source_revisions_json IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM json_each(content.source_revisions_json) source_pin
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_sources source JOIN memory_source_revisions revision
          ON revision.source_id=source.id AND revision.revision=source_pin.value
        WHERE source.id=source_pin.key AND source.current_content_revision=revision.revision
          AND revision.content_hash IS NOT NULL
      )
    )
 )
);
CREATE TRIGGER preparation_snapshot_kmb_pin_commit
BEFORE UPDATE OF build_status, status ON interview_preparation_snapshots
WHEN NEW.build_status='committed' AND (OLD.build_status<>'committed' OR NEW.status='active')
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM preparation_snapshot_invalid_kmb_pins WHERE snapshot_id=NEW.id)
 THEN RAISE(ABORT, 'Snapshot KMB content pin is unavailable or unverified.') END;
END;
CREATE TRIGGER preparation_snapshot_kmb_pin_activation
BEFORE UPDATE OF selected_snapshot_id ON interview_preparation_current_context
WHEN NEW.selected_snapshot_id IS NOT NULL
BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM preparation_snapshot_invalid_kmb_pins WHERE snapshot_id=NEW.selected_snapshot_id)
 THEN RAISE(ABORT, 'Snapshot KMB content pin is unavailable or unverified.') END;
END;
CREATE TRIGGER preparation_snapshot_kmb_pin_insert
BEFORE INSERT ON preparation_snapshot_kmb_entry_links
WHEN EXISTS(SELECT 1 FROM interview_preparation_snapshots WHERE id=NEW.snapshot_id AND build_status='committed')
BEGIN SELECT RAISE(ABORT, 'Committed KMB pins are immutable.'); END;
CREATE TRIGGER preparation_snapshot_kmb_pin_update
BEFORE UPDATE ON preparation_snapshot_kmb_entry_links
WHEN EXISTS(SELECT 1 FROM interview_preparation_snapshots WHERE id=OLD.snapshot_id AND build_status='committed')
BEGIN SELECT RAISE(ABORT, 'Committed KMB pins are immutable.'); END;
CREATE TRIGGER preparation_snapshot_kmb_pin_delete
BEFORE DELETE ON preparation_snapshot_kmb_entry_links
WHEN EXISTS(SELECT 1 FROM interview_preparation_snapshots WHERE id=OLD.snapshot_id AND build_status='committed')
BEGIN SELECT RAISE(ABORT, 'Committed KMB pins are immutable.'); END;
