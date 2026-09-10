CREATE TABLE human_evaluation_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    payload JSON NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX human_evaluation_events_session ON human_evaluation_events(session_id);
CREATE INDEX human_evaluation_events_action ON human_evaluation_events(
    session_id, json_extract(payload, '$.provenance.actionId'), json_extract(payload, '$.fact.kind')
);

CREATE TABLE human_evaluation_projections (
    projection_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    payload JSON NOT NULL CHECK (json_valid(payload))
);
CREATE INDEX human_evaluation_projections_session ON human_evaluation_projections(session_id);

CREATE TABLE human_evaluation_imports (
    source_id TEXT PRIMARY KEY NOT NULL,
    receipt JSON NOT NULL CHECK (json_valid(receipt))
);
