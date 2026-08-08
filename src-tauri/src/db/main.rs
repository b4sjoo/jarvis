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
    ]
}
