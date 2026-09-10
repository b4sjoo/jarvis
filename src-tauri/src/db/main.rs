use tauri_plugin_sql::{Migration, MigrationKind};

/// Returns all database migrations
pub fn migrations() -> Vec<Migration> {
    vec![
        // Migration 1: Create system_prompts table with indexes and triggers
        Migration {
            version: 1,
            description: "create_system_prompts_table",
            sql: include_str!("migrations/system-prompts.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 2: Create chat history tables (conversations and messages)
        Migration {
            version: 2,
            description: "create_chat_history_tables",
            sql: include_str!("migrations/chat-history.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 3: Create knowledge memory base tables
        Migration {
            version: 3,
            description: "create_knowledge_memory_base_tables",
            sql: include_str!("migrations/knowledge-memory-base.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 4: Create shared preparation workspace metadata tables
        Migration {
            version: 4,
            description: "create_preparation_workspace_tables",
            sql: include_str!("migrations/preparation-workspaces.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 5: Create interview-specific process and round tables
        Migration {
            version: 5,
            description: "create_interview_preparation_domain_tables",
            sql: include_str!("migrations/interview-preparation-domain.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 6: Enforce active material checksum uniqueness per workspace
        Migration {
            version: 6,
            description: "add_preparation_material_constraints",
            sql: include_str!("migrations/preparation-material-constraints.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 7: Preserve user-defined labels for Other interview rounds
        Migration {
            version: 7,
            description: "add_interview_round_custom_stage_label",
            sql: include_str!("migrations/interview-round-custom-stage.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 8: Add revision-bound local extraction leases and chunks
        Migration {
            version: 8,
            description: "add_preparation_material_extraction",
            sql: include_str!("migrations/preparation-material-extraction.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 9: Preserve per-chunk extraction provenance and OCR confidence
        Migration {
            version: 9,
            description: "add_preparation_material_ocr_provenance",
            sql: include_str!("migrations/preparation-material-ocr.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 10: Add process/round-scoped preparation conversations
        Migration {
            version: 10,
            description: "add_preparation_conversations",
            sql: include_str!("migrations/preparation-conversations.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 11: Allow multiple preparation sessions and branched edits
        Migration {
            version: 11,
            description: "add_preparation_conversation_sessions",
            sql: include_str!("migrations/preparation-conversation-sessions.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 12: Separate extraction completeness from review authority
        Migration {
            version: 12,
            description: "add_preparation_material_review_authority",
            sql: include_str!("migrations/preparation-material-review.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 13: Add reviewed preparation statements and draft composition state
        Migration {
            version: 13,
            description: "add_preparation_statement_authority",
            sql: include_str!("migrations/preparation-statement-authority.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 14: Preserve edit and review as separate audit revisions
        Migration {
            version: 14,
            description: "separate_preparation_statement_edit_review_events",
            sql: include_str!("migrations/preparation-statement-review-events.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 15: Add immutable preparation snapshots and explicit activation
        Migration {
            version: 15,
            description: "add_interview_preparation_runtime_snapshots",
            sql: include_str!("migrations/preparation-runtime-snapshots.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 16: Separate immutable snapshots from mutable Round selection
        Migration {
            version: 16,
            description: "add_interview_preparation_snapshot_selection",
            sql: include_str!("migrations/preparation-snapshot-selection.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 17: Enforce one global current Process, Round, and snapshot
        Migration {
            version: 17,
            description: "add_preparation_global_current_context",
            sql: include_str!("migrations/preparation-global-current-context.sql"),
            kind: MigrationKind::Up,
        },
        // Migration 18: Preserve curator-authored interview-family metadata
        Migration {
            version: 18,
            description: "add_memory_entry_interview_families",
            sql: include_str!("migrations/memory-entry-interview-families.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "immutable_preparation_extraction_revisions",
            sql: include_str!("migrations/preparation-immutable-extraction-revisions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "immutable_kmb_content_and_snapshot_pins",
            sql: include_str!("migrations/memory-content-revisions-and-snapshot-pins.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "human_evaluation_storage",
            sql: include_str!("migrations/human-evaluation.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
