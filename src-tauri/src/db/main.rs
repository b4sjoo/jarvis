use tauri_plugin_sql::{Migration, MigrationKind};

pub fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_moss_runtime_baseline",
        sql: include_str!("migrations/moss-runtime-baseline.sql"),
        kind: MigrationKind::Up,
    }]
}
