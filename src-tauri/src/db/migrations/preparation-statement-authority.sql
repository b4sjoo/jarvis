PRAGMA foreign_keys = ON;

CREATE TABLE preparation_statement_proposal_operations (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('process', 'round')),
    scope_key TEXT NOT NULL,
    round_id TEXT,
    conversation_id TEXT NOT NULL,
    expected_conversation_revision INTEGER NOT NULL CHECK(expected_conversation_revision >= 0),
    provider_id TEXT,
    source_manifest_json TEXT NOT NULL,
    source_manifest_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
        'staging', 'committed', 'stale', 'failed', 'cancelled'
    )),
    created_at INTEGER NOT NULL,
    settled_at INTEGER,
    error TEXT,
    CHECK(
        (scope_kind = 'process' AND scope_key = 'process' AND round_id IS NULL)
        OR
        (scope_kind = 'round' AND scope_key = round_id AND round_id IS NOT NULL)
    ),
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE,
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE CASCADE
);

CREATE INDEX idx_preparation_statement_operations_scope
ON preparation_statement_proposal_operations(
    process_id, scope_key, status, created_at DESC, id DESC
);

CREATE TABLE preparation_statements (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    round_id TEXT,
    domain TEXT NOT NULL CHECK(domain IN (
        'candidate-fact', 'project-evidence', 'interview-logistics',
        'interview-policy', 'company-guidance', 'strategy', 'terminology',
        'question-to-ask', 'risk', 'unknown'
    )),
    content TEXT NOT NULL CHECK(length(trim(content)) > 0),
    normalized_content TEXT NOT NULL CHECK(length(trim(normalized_content)) > 0),
    status TEXT NOT NULL CHECK(status IN (
        'proposed', 'confirmed', 'rejected', 'superseded', 'unresolved'
    )),
    authority TEXT NOT NULL CHECK(authority IN (
        'user-confirmed', 'curated-kmb', 'material-grounded',
        'user-message', 'model-generated', 'model-inferred'
    )),
    ownership TEXT NOT NULL CHECK(ownership IN (
        'candidate-owned', 'team-owned', 'upstream-existing',
        'future-design', 'unresolved'
    )),
    allowed_wording TEXT,
    prohibited_wording_json TEXT NOT NULL DEFAULT '[]',
    allowed_interview_families_json TEXT NOT NULL DEFAULT '[]',
    proposal_operation_id TEXT NOT NULL,
    source_message_id TEXT,
    supersedes_id TEXT,
    confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    last_review_action TEXT NOT NULL CHECK(last_review_action IN (
        'proposed', 'confirmed', 'rejected', 'unresolved', 'edited', 'superseded'
    )),
    last_review_actor TEXT NOT NULL CHECK(last_review_actor IN ('model', 'user', 'runtime')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    CHECK(round_id IS NULL OR length(trim(round_id)) > 0),
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE,
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE CASCADE,
    FOREIGN KEY (proposal_operation_id) REFERENCES preparation_statement_proposal_operations(id) ON DELETE CASCADE,
    FOREIGN KEY (source_message_id) REFERENCES preparation_messages(id) ON DELETE SET NULL,
    FOREIGN KEY (supersedes_id) REFERENCES preparation_statements(id) ON DELETE SET NULL
);

CREATE INDEX idx_preparation_statements_scope_status
ON preparation_statements(process_id, round_id, status, updated_at DESC);

CREATE INDEX idx_preparation_statements_operation
ON preparation_statements(process_id, proposal_operation_id);

CREATE INDEX idx_preparation_statements_normalized
ON preparation_statements(process_id, round_id, normalized_content, status);

CREATE TABLE preparation_statement_sources (
    id TEXT PRIMARY KEY,
    statement_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK(source_type IN (
        'material-chunk', 'preparation-message', 'curated-kmb',
        'user-confirmation'
    )),
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    material_id TEXT,
    material_revision_id TEXT,
    page INTEGER CHECK(page IS NULL OR page > 0),
    section TEXT,
    content_hash TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (statement_id) REFERENCES preparation_statements(id) ON DELETE CASCADE,
    UNIQUE(statement_id, source_type, source_id)
);

CREATE INDEX idx_preparation_statement_sources_statement
ON preparation_statement_sources(statement_id, created_at ASC);

CREATE TABLE preparation_statement_review_events (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    statement_id TEXT NOT NULL,
    statement_revision INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN (
        'proposed', 'confirmed', 'rejected', 'unresolved', 'edited', 'superseded'
    )),
    actor TEXT NOT NULL CHECK(actor IN ('model', 'user', 'runtime')),
    previous_status TEXT,
    next_status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE,
    FOREIGN KEY (statement_id) REFERENCES preparation_statements(id) ON DELETE CASCADE,
    UNIQUE(statement_id, statement_revision)
);

CREATE INDEX idx_preparation_statement_events_statement
ON preparation_statement_review_events(statement_id, created_at ASC);

CREATE TRIGGER preparation_statement_created_event
AFTER INSERT ON preparation_statements
BEGIN
    INSERT INTO preparation_statement_review_events
      (id, process_id, statement_id, statement_revision, action, actor,
       previous_status, next_status, created_at)
    VALUES
      (NEW.id || ':' || NEW.revision, NEW.process_id, NEW.id, NEW.revision,
       NEW.last_review_action, NEW.last_review_actor, NULL, NEW.status, NEW.updated_at);
END;

CREATE TRIGGER preparation_statement_updated_event
AFTER UPDATE OF revision ON preparation_statements
WHEN NEW.revision <> OLD.revision
BEGIN
    INSERT INTO preparation_statement_review_events
      (id, process_id, statement_id, statement_revision, action, actor,
       previous_status, next_status, created_at)
    VALUES
      (NEW.id || ':' || NEW.revision, NEW.process_id, NEW.id, NEW.revision,
       NEW.last_review_action, NEW.last_review_actor, OLD.status, NEW.status, NEW.updated_at);
    INSERT OR IGNORE INTO preparation_statement_sources
      (id, statement_id, source_type, source_id, title, created_at)
    SELECT
      NEW.id || ':user-confirmation:' || NEW.revision,
      NEW.id,
      'user-confirmation',
      NEW.id || ':' || NEW.revision,
      'User confirmation',
      NEW.updated_at
    WHERE NEW.last_review_actor = 'user'
      AND NEW.last_review_action IN ('confirmed', 'edited');
END;

CREATE TABLE interview_preparation_profile_revisions (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    round_id TEXT,
    revision INTEGER NOT NULL CHECK(revision > 0),
    source_fingerprint TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    content_json TEXT NOT NULL,
    confirmed_statement_ids_json TEXT NOT NULL,
    unresolved_statement_ids_json TEXT NOT NULL,
    build_status TEXT NOT NULL CHECK(build_status IN ('staging', 'committed', 'failed')),
    created_at INTEGER NOT NULL,
    CHECK(
        (scope_key = 'process' AND round_id IS NULL)
        OR
        (scope_key = round_id AND round_id IS NOT NULL)
    ),
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE,
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE CASCADE,
    UNIQUE(process_id, scope_key, revision),
    UNIQUE(process_id, scope_key, source_fingerprint)
);

CREATE INDEX idx_interview_preparation_profiles_scope
ON interview_preparation_profile_revisions(
    process_id, scope_key, build_status, revision DESC
);

CREATE TABLE preparation_profile_statement_links (
    profile_revision_id TEXT NOT NULL,
    statement_id TEXT NOT NULL,
    statement_revision INTEGER NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    PRIMARY KEY (profile_revision_id, statement_id),
    FOREIGN KEY (profile_revision_id) REFERENCES interview_preparation_profile_revisions(id) ON DELETE CASCADE,
    FOREIGN KEY (statement_id) REFERENCES preparation_statements(id) ON DELETE RESTRICT
);

CREATE TABLE preparation_narrative_graphs (
    id TEXT PRIMARY KEY,
    process_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    round_id TEXT,
    profile_revision_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK(subject_kind IN (
        'self-introduction', 'project', 'role-fit'
    )),
    subject_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    source_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('current', 'stale', 'superseded')),
    build_status TEXT NOT NULL CHECK(build_status IN ('staging', 'committed', 'failed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK(
        (scope_key = 'process' AND round_id IS NULL)
        OR
        (scope_key = round_id AND round_id IS NOT NULL)
    ),
    FOREIGN KEY (process_id) REFERENCES interview_processes(id) ON DELETE CASCADE,
    FOREIGN KEY (round_id) REFERENCES interview_rounds(id) ON DELETE CASCADE,
    FOREIGN KEY (profile_revision_id) REFERENCES interview_preparation_profile_revisions(id) ON DELETE RESTRICT,
    UNIQUE(process_id, scope_key, subject_kind, subject_id, revision)
);

CREATE INDEX idx_preparation_narrative_graphs_scope
ON preparation_narrative_graphs(
    process_id, scope_key, build_status, status, updated_at DESC
);

CREATE TABLE preparation_narrative_nodes (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    kind TEXT NOT NULL CHECK(kind IN (
        'positioning', 'intro-30s', 'main-story-90s', 'architecture',
        'tradeoff', 'failure-recovery', 'retrospective', 'role-mapping',
        'follow-up'
    )),
    title TEXT NOT NULL,
    content_draft TEXT NOT NULL,
    target_seconds INTEGER CHECK(target_seconds IS NULL OR target_seconds > 0),
    statement_ids_json TEXT NOT NULL,
    review_status TEXT NOT NULL CHECK(review_status IN (
        'proposed', 'confirmed', 'rejected', 'unresolved'
    )),
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (graph_id) REFERENCES preparation_narrative_graphs(id) ON DELETE CASCADE,
    UNIQUE(graph_id, ordinal)
);

CREATE TABLE preparation_narrative_edges (
    id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL,
    from_node_id TEXT NOT NULL,
    to_node_id TEXT NOT NULL,
    relation TEXT NOT NULL CHECK(relation IN (
        'expands', 'supports', 'contrasts', 'answers-follow-up'
    )),
    created_at INTEGER NOT NULL,
    FOREIGN KEY (graph_id) REFERENCES preparation_narrative_graphs(id) ON DELETE CASCADE,
    FOREIGN KEY (from_node_id) REFERENCES preparation_narrative_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_node_id) REFERENCES preparation_narrative_nodes(id) ON DELETE CASCADE,
    UNIQUE(graph_id, from_node_id, to_node_id, relation)
);

CREATE TABLE preparation_narrative_node_statement_links (
    node_id TEXT NOT NULL,
    statement_id TEXT NOT NULL,
    statement_revision INTEGER NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    PRIMARY KEY (node_id, statement_id),
    FOREIGN KEY (node_id) REFERENCES preparation_narrative_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (statement_id) REFERENCES preparation_statements(id) ON DELETE RESTRICT
);

CREATE TABLE preparation_narrative_node_review_events (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL,
    node_revision INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN (
        'proposed', 'confirmed', 'rejected', 'unresolved', 'edited'
    )),
    previous_status TEXT,
    next_status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (node_id) REFERENCES preparation_narrative_nodes(id) ON DELETE CASCADE,
    UNIQUE(node_id, node_revision)
);

CREATE TRIGGER preparation_narrative_node_created_event
AFTER INSERT ON preparation_narrative_nodes
BEGIN
    INSERT INTO preparation_narrative_node_review_events
      (id, node_id, node_revision, action, previous_status, next_status, created_at)
    VALUES
      (NEW.id || ':' || NEW.revision, NEW.id, NEW.revision,
       'proposed', NULL, NEW.review_status, NEW.updated_at);
END;

CREATE TRIGGER preparation_narrative_node_updated_event
AFTER UPDATE OF revision ON preparation_narrative_nodes
WHEN NEW.revision <> OLD.revision
BEGIN
    INSERT INTO preparation_narrative_node_review_events
      (id, node_id, node_revision, action, previous_status, next_status, created_at)
    VALUES
      (NEW.id || ':' || NEW.revision, NEW.id, NEW.revision,
       CASE WHEN NEW.content_draft <> OLD.content_draft THEN 'edited'
            ELSE NEW.review_status END,
       OLD.review_status, NEW.review_status, NEW.updated_at);
END;

-- A reviewed statement revision invalidates every current narrative that used
-- the prior revision. Keeping this in SQLite makes fact review and narrative
-- invalidation one atomic mutation instead of two frontend calls.
CREATE TRIGGER preparation_statement_invalidates_narrative_graphs
AFTER UPDATE OF revision ON preparation_statements
WHEN NEW.revision <> OLD.revision
BEGIN
    UPDATE preparation_narrative_graphs
    SET status = 'stale', updated_at = NEW.updated_at
    WHERE process_id = NEW.process_id
      AND status = 'current'
      AND build_status = 'committed'
      AND EXISTS (
          SELECT 1
          FROM preparation_narrative_nodes node
          JOIN preparation_narrative_node_statement_links link
            ON link.node_id = node.id
          WHERE node.graph_id = preparation_narrative_graphs.id
            AND link.statement_id = NEW.id
      );
END;
