use tauri_plugin_sql::{Migration, MigrationKind};

pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_moss_runtime_baseline",
            sql: include_str!("migrations/moss-runtime-baseline.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create_moss_case_preparation",
            sql: include_str!("migrations/moss-case-preparation.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "harden_moss_case_preparation",
            sql: include_str!("migrations/moss-case-hardening.sql"),
            kind: MigrationKind::Up,
        },
    ]
}
