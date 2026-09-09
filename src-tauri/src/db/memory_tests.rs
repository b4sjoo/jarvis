use super::*;
use sqlx::Executor;

fn source() -> ContentCandidate {
    let mut content: Content = SOURCE_FIELDS
        .iter()
        .map(|f| (f.to_string(), Some("test".into())))
        .collect();
    for key in [
        "original_path",
        "project_id",
        "project_name",
        "checksum",
        "draft_path",
    ] {
        content.insert(key.into(), None);
    }
    for (key, value) in [
        ("title", "Source A"),
        ("scope", "global"),
        ("collection", "profiles"),
        ("source_origin", "manual"),
        ("source_format", "markdown"),
        ("source_role", "resume"),
        ("canonicality", "canonical"),
        ("raw_injection_policy", "allow"),
        ("curation_status", "verified"),
        ("confidentiality", "normal"),
    ] {
        content.insert(key.into(), Some(value.into()));
    }
    ContentCandidate {
        id: "source".into(),
        content,
        enabled: None,
    }
}
fn entry(text: &str) -> ContentCandidate {
    let mut content: Content = ENTRY_FIELDS
        .iter()
        .map(|f| (f.to_string(), Some("test".into())))
        .collect();
    for key in ["summary", "project_id", "project_name", "draft_path"] {
        content.insert(key.into(), None);
    }
    for key in [
        "tags",
        "keywords",
        "related_entry_ids",
        "evidence_entry_ids",
    ] {
        content.insert(key.into(), Some("[]".into()));
    }
    for (key, value) in [
        ("source_ids", "[\"source\"]"),
        ("content", text),
        ("title", "Entry A"),
        ("scope", "global"),
        ("type", "interview_framework"),
        ("priority", "normal"),
        ("injection_mode", "retrieval"),
        ("use_cases", "[\"meeting_assistant\"]"),
        (
            "interview_families",
            "[\"system-design\",\"ai-ml-system-design\"]",
        ),
        ("curation_status", "verified"),
        ("confidentiality", "normal"),
    ] {
        content.insert(key.into(), Some(value.into()));
    }
    ContentCandidate {
        id: "entry".into(),
        content,
        enabled: Some(true),
    }
}
fn input(text: &str) -> PublishInput {
    PublishInput {
        sources: vec![source()],
        entries: vec![entry(text)],
        projects: vec![],
        imported_at: 10,
    }
}
async fn migrate(pool: &SqlitePool, through: i64) {
    for migration in crate::db::migrations()
        .into_iter()
        .filter(|m| m.version <= through)
    {
        pool.execute(migration.sql).await.unwrap();
    }
}
async fn database() -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    migrate(&pool, 20).await;
    pool
}
async fn current(pool: &SqlitePool) -> Vec<(String, i64, String, i64, Option<i64>)> {
    sqlx::query_as("SELECT e.id,r.revision,r.content,e.enabled,e.last_used_at FROM memory_entries e JOIN memory_entry_revisions r ON r.entry_id=e.id AND r.revision=e.current_content_revision ORDER BY e.id").fetch_all(pool).await.unwrap()
}
async fn hash_for(pool: &SqlitePool, revision: i64) -> String {
    sqlx::query_scalar(
        "SELECT content_hash FROM memory_entry_revisions WHERE entry_id='entry' AND revision=?",
    )
    .bind(revision)
    .fetch_one(pool)
    .await
    .unwrap()
}
async fn snapshot(
    pool: &SqlitePool,
    id: &str,
    revision: i64,
    hash: &str,
) -> Result<(), sqlx::Error> {
    pool.execute("INSERT OR IGNORE INTO preparation_workspaces VALUES ('w','interview','Test','active',1,1,NULL);
      INSERT OR IGNORE INTO interview_processes (id,workspace_id,created_at,updated_at) VALUES ('p','w',1,1);
      INSERT OR IGNORE INTO interview_rounds (id,process_id,title,stage,expected_interview_types,expected_type_policy,created_at,updated_at) VALUES ('round','p','Round','coding','[]','advisory',1,1);
      INSERT OR IGNORE INTO interview_preparation_profile_revisions (id,process_id,scope_key,round_id,revision,source_fingerprint,content_hash,content_json,confirmed_statement_ids_json,unresolved_statement_ids_json,build_status,created_at) VALUES ('profile','p','round','round',1,'fp','ph','{}','[]','[]','committed',1);").await?;
    let manifest = json!({"materials":[],"kmbEntries":[{"entryId":"entry","entryRevision":revision,"contentHash":hash}]});
    let version: i64 = sqlx::query_scalar("SELECT COUNT(*)+1 FROM interview_preparation_snapshots")
        .fetch_one(pool)
        .await?;
    let payload = json!({"schemaVersion":2,"runtimeBrief":{"role":"A"},
        "artifactManifest":{"version":"preparation-artifact-manifest-v1","artifacts":[]}});
    sqlx::query("INSERT INTO interview_preparation_snapshots (id,process_id,round_id,version,profile_revision_id,profile_revision,compiler_version,playbook_registry_version,runtime_capability_version,source_fingerprint,content_hash,runtime_char_count,snapshot_json,source_manifest_json,warnings_json,status,build_status,created_at,schema_version) VALUES (?,'p','round',?,'profile',1,'compiler','playbook','capability',?,?,0,?,?,'[]','ready','staging',1,2)")
        .bind(id).bind(version).bind(id).bind(id).bind(payload.to_string()).bind(manifest.to_string()).execute(pool).await?;
    sqlx::query("INSERT INTO preparation_snapshot_kmb_entry_links (snapshot_id,entry_id,entry_revision,content_hash,ordinal) VALUES (?,'entry',?,?,0)").bind(id).bind(revision).bind(hash).execute(pool).await?;
    Ok(())
}
async fn commit_snapshot(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE interview_preparation_snapshots SET build_status='committed' WHERE id=?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}
async fn activate(pool: &SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE interview_preparation_current_context SET process_id='p',round_id='round',selected_snapshot_id=?,revision=revision+1,updated_at=10").bind(id).execute(pool).await?;
    Ok(())
}

#[tokio::test]
async fn task165_k1_same_content_reuses_and_old_snapshot_replays_exact_content_and_source() {
    let pool = database().await;
    publish(&pool, input("A")).await.unwrap();
    let hash = hash_for(&pool, 1).await;
    snapshot(&pool, "s1", 1, &hash).await.unwrap();
    commit_snapshot(&pool, "s1").await.unwrap();
    activate(&pool, "s1").await.unwrap();
    let same = publish(&pool, input("A")).await.unwrap();
    assert_eq!(same.revisions_reused, 2);
    assert_eq!(same.entry_revisions_created, 0);
    let mut changed = input("B");
    changed.sources[0]
        .content
        .insert("title".into(), Some("Source B".into()));
    publish(&pool, changed).await.unwrap();
    assert_eq!(current(&pool).await[0].2, "B");
    let old:(String,String)=sqlx::query_as("SELECT r.content,s.title FROM preparation_snapshot_kmb_entry_links pin JOIN memory_entry_revisions r ON r.entry_id=pin.entry_id AND r.revision=pin.entry_revision JOIN json_each(r.source_revisions_json) ref JOIN memory_source_revisions s ON s.source_id=ref.key AND s.revision=ref.value WHERE pin.snapshot_id='s1'").fetch_one(&pool).await.unwrap();
    assert_eq!(old, ("A".into(), "Source A".into()));
    assert_eq!(hash_for(&pool, 1).await, hash);
    assert!(activate(&pool, "s1").await.is_err());
    assert!(pool.execute("UPDATE memory_entry_revisions SET content='changed' WHERE entry_id='entry' AND revision=1").await.is_err());
    assert!(pool
        .execute("DELETE FROM memory_source_revisions WHERE source_id='source' AND revision=1")
        .await
        .is_err());
    publish(&pool, input("A")).await.unwrap();
    assert_eq!(current(&pool).await[0].1, 1);
    activate(&pool, "s1").await.unwrap();
}

#[tokio::test]
async fn task165_k2_rebuild_preserves_policy_and_usage_and_revocation_blocks_old_pins() {
    let pool = database().await;
    publish(&pool, input("A")).await.unwrap();
    snapshot(&pool, "s1", 1, &hash_for(&pool, 1).await)
        .await
        .unwrap();
    commit_snapshot(&pool, "s1").await.unwrap();
    pool.execute("UPDATE memory_entries SET enabled=0,last_used_at=77 WHERE id='entry'")
        .await
        .unwrap();
    publish(&pool, input("B")).await.unwrap();
    let row = &current(&pool).await[0];
    assert_eq!((row.3, row.4), (0, Some(77)));
    assert!(activate(&pool, "s1").await.is_err());
    pool.execute("UPDATE memory_entries SET enabled=1 WHERE id='entry'")
        .await
        .unwrap();
    assert_eq!(current(&pool).await[0].1, 2);
    assert!(activate(&pool, "s1").await.is_err());
}

#[tokio::test]
async fn task165_k3_publication_failures_roll_back_complete_sets() {
    for trigger in [
      "CREATE TRIGGER injected BEFORE INSERT ON memory_source_revisions BEGIN SELECT RAISE(ABORT,'injected'); END",
      "CREATE TRIGGER injected BEFORE INSERT ON memory_entry_revisions BEGIN SELECT RAISE(ABORT,'injected'); END",
      "CREATE TRIGGER injected BEFORE UPDATE OF current_content_revision ON memory_entries BEGIN SELECT RAISE(ABORT,'injected'); END",
      "CREATE TRIGGER injected BEFORE DELETE ON memory_entries BEGIN SELECT RAISE(ABORT,'injected'); END",
    ] {
        let pool=database().await;let mut first=input("A");let mut stale=entry("old");stale.id="stale".into();first.entries.push(stale);publish(&pool,first).await.unwrap();
        let before=current(&pool).await;
        pool.execute(trigger).await.unwrap();
        let mut changed=input("B");changed.sources[0].content.insert("title".into(),Some("Source B".into()));
        assert!(publish(&pool,changed).await.is_err());
        assert_eq!(current(&pool).await,before);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM memory_entry_revisions").fetch_one(&pool).await.unwrap(),2);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM memory_source_revisions").fetch_one(&pool).await.unwrap(),1);
    }
    let pool = database().await;
    publish(&pool, input("A")).await.unwrap();
    let before = current(&pool).await;
    let mut invalid = input("bad");
    invalid.entries[0].content.remove("content");
    assert!(publish(&pool, invalid).await.is_err());
    assert_eq!(current(&pool).await, before);
    let mut missing = input("bad");
    missing.entries[0]
        .content
        .insert("source_ids".into(), Some("[\"missing\"]".into()));
    assert!(publish(&pool, missing).await.is_err());
    assert_eq!(current(&pool).await, before);
}

#[tokio::test]
async fn task165_k4_final_compile_activation_and_rollback_recheck_pins() {
    let pool = database().await;
    publish(&pool, input("A")).await.unwrap();
    let hash = hash_for(&pool, 1).await;
    snapshot(&pool, "wrong", 1, "wrong-hash").await.unwrap();
    assert!(commit_snapshot(&pool, "wrong").await.is_err());
    snapshot(&pool, "s1", 1, &hash).await.unwrap();
    // This policy change represents the controlled gap after service preflight.
    pool.execute("UPDATE memory_entries SET enabled=0")
        .await
        .unwrap();
    assert!(commit_snapshot(&pool, "s1").await.is_err());
    pool.execute("UPDATE memory_entries SET enabled=1")
        .await
        .unwrap();
    commit_snapshot(&pool, "s1").await.unwrap();
    publish(&pool, input("B")).await.unwrap();
    assert!(activate(&pool, "s1").await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT revision FROM interview_preparation_current_context")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    snapshot(&pool, "s2", 2, &hash_for(&pool, 2).await)
        .await
        .unwrap();
    commit_snapshot(&pool, "s2").await.unwrap();
    activate(&pool, "s2").await.unwrap();
    assert!(activate(&pool, "s1").await.is_err());
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT selected_snapshot_id FROM interview_preparation_current_context"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        "s2"
    );
    assert!(pool
        .execute("DELETE FROM preparation_snapshot_kmb_entry_links WHERE snapshot_id='s2'")
        .await
        .is_err());
    assert!(pool
        .execute("UPDATE interview_preparation_snapshots SET schema_version=99")
        .await
        .is_err());
}

async fn insert_legacy(pool: &SqlitePool, kind: Kind, candidate: ContentCandidate) {
    let (table, _, _, fields) = kind.tables();
    let extra = if matches!(kind, Kind::Entry) {
        ",enabled,last_used_at"
    } else {
        ""
    };
    let values =
        vec!["?"; fields.len() + 3 + if matches!(kind, Kind::Entry) { 2 } else { 0 }].join(",");
    let query = format!(
        "INSERT INTO {table} (id,{},created_at,updated_at{extra}) VALUES ({values})",
        fields.join(",")
    );
    let mut query = sqlx::query(&query).bind(candidate.id);
    for field in fields {
        query = query.bind(candidate.content.get(*field).cloned().flatten());
    }
    query = query.bind(1_i64).bind(2_i64);
    if matches!(kind, Kind::Entry) {
        query = query.bind(false).bind(77_i64);
    }
    query.execute(pool).await.unwrap();
}

#[tokio::test]
async fn task165_k5_migration_retains_raw_content_policy_and_unknown_history() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    migrate(&pool, 19).await;
    insert_legacy(&pool, Kind::Source, source()).await;
    let mut legacy = entry("Original");
    legacy
        .content
        .insert("interview_families".into(), Some("not-json".into()));
    insert_legacy(&pool, Kind::Entry, legacy).await;
    seed_legacy_snapshot(&pool).await;
    pool.execute(include_str!(
        "migrations/memory-content-revisions-and-snapshot-pins.sql"
    ))
    .await
    .unwrap();
    assert_legacy_migration(&pool).await;
}

async fn seed_legacy_snapshot(pool: &SqlitePool) {
    pool.execute("INSERT INTO preparation_workspaces VALUES ('w','interview','Test','active',1,1,NULL);
      INSERT INTO interview_processes (id,workspace_id,created_at,updated_at) VALUES ('p','w',1,1);
      INSERT INTO interview_rounds (id,process_id,title,stage,expected_interview_types,expected_type_policy,created_at,updated_at) VALUES ('round','p','Round','coding','[]','advisory',1,1);
      INSERT INTO interview_preparation_profile_revisions (id,process_id,scope_key,round_id,revision,source_fingerprint,content_hash,content_json,confirmed_statement_ids_json,unresolved_statement_ids_json,build_status,created_at) VALUES ('profile','p','round','round',1,'fp','ph','{}','[]','[]','committed',1);
      INSERT INTO interview_preparation_snapshots (id,process_id,round_id,version,profile_revision_id,profile_revision,compiler_version,playbook_registry_version,runtime_capability_version,source_fingerprint,content_hash,runtime_char_count,snapshot_json,source_manifest_json,warnings_json,status,build_status,created_at)
      VALUES ('legacy','p','round',1,'profile',1,'compiler','playbook','capability','fp','legacy-hash',0,'{\"frozen\":\"Original\"}','{\"kmbEntries\":[{\"entryId\":\"entry\",\"contentHash\":\"legacy-body-hash\"}]}','[]','ready','committed',1);
      INSERT INTO preparation_snapshot_kmb_entry_links (snapshot_id,entry_id,content_hash,ordinal) VALUES ('legacy','entry','legacy-body-hash',0);").await.unwrap();
}

async fn assert_legacy_migration(pool: &SqlitePool) {
    assert_eq!(
        current(pool).await[0],
        ("entry".into(), 1, "Original".into(), 0, Some(77))
    );
    initialize(pool).await.unwrap();
    initialize(pool).await.unwrap();
    let source_row = sqlx::query(
        "SELECT * FROM memory_source_revisions WHERE source_id='source' AND revision=1",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(row_content(&source_row, SOURCE_FIELDS), source().content);
    let entry_row =
        sqlx::query("SELECT * FROM memory_entry_revisions WHERE entry_id='entry' AND revision=1")
            .fetch_one(pool)
            .await
            .unwrap();
    let mut original = entry("Original");
    original
        .content
        .insert("interview_families".into(), Some("not-json".into()));
    assert_eq!(row_content(&entry_row, ENTRY_FIELDS), original.content);
    assert_eq!(
        entry_row.get::<String, _>("source_revisions_json"),
        "{\"source\":1}"
    );
    for table in ["memory_source_revisions", "memory_entry_revisions"] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {table}"))
                .fetch_one(pool)
                .await
                .unwrap(),
            1
        );
    }
    assert_eq!(
        current(pool).await[0],
        ("entry".into(), 1, "Original".into(), 0, Some(77))
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT interview_families FROM memory_entry_revisions")
            .fetch_one(pool)
            .await
            .unwrap(),
        "not-json"
    );
    assert_eq!(
        sqlx::query_as::<_, (Option<i64>, String)>(
            "SELECT entry_revision,content_hash FROM preparation_snapshot_kmb_entry_links"
        )
        .fetch_one(pool)
        .await
        .unwrap(),
        (None, "legacy-body-hash".into())
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT snapshot_json FROM interview_preparation_snapshots"
        )
        .fetch_one(pool)
        .await
        .unwrap(),
        "{\"frozen\":\"Original\"}"
    );
    assert!(activate(pool, "legacy").await.is_err());
    assert!(pool
        .fetch_all("PRAGMA foreign_key_check")
        .await
        .unwrap()
        .is_empty());
    assert!(pool
        .execute("UPDATE memory_entries SET content='old writer'")
        .await
        .is_err());
}

#[tokio::test]
async fn task165_k5_file_copy_migration_failure_restore_and_reopen() {
    let root = std::env::temp_dir().join(format!(
        "jarvis-k5-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let original = root.join("legacy.db");
    let backup = root.join("backup.db");
    let candidate = root.join("candidate.db");
    let options = |path: &std::path::Path| {
        sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
    };
    let pool = SqlitePool::connect_with(options(&original)).await.unwrap();
    migrate(&pool, 19).await;
    insert_legacy(&pool, Kind::Source, source()).await;
    let mut legacy = entry("Original");
    legacy
        .content
        .insert("interview_families".into(), Some("not-json".into()));
    insert_legacy(&pool, Kind::Entry, legacy).await;
    seed_legacy_snapshot(&pool).await;
    pool.close().await;
    std::fs::copy(&original, &backup).unwrap();
    let backup_bytes = std::fs::read(&backup).unwrap();
    std::fs::copy(&backup, &candidate).unwrap();
    let migration = crate::db::migrations()
        .into_iter()
        .find(|m| m.version == 20)
        .unwrap();
    let failed = SqlitePool::connect_with(options(&candidate)).await.unwrap();
    failed.execute(migration.sql).await.unwrap();
    // Fail after source hashes have been prepared, proving initialization is atomic.
    failed.execute("CREATE TRIGGER injected_copy_failure BEFORE UPDATE OF content_hash ON memory_entry_revisions BEGIN SELECT RAISE(ABORT,'injected copy bootstrap failure'); END").await.unwrap();
    assert!(initialize(&failed)
        .await
        .unwrap_err()
        .contains("injected copy bootstrap failure"));
    for table in ["memory_source_revisions", "memory_entry_revisions"] {
        assert_eq!(
            sqlx::query_scalar::<_, i64>(&format!(
                "SELECT COUNT(*) FROM {table} WHERE content_hash IS NOT NULL"
            ))
            .fetch_one(&failed)
            .await
            .unwrap(),
            0
        );
    }
    failed.close().await;

    std::fs::copy(&backup, &candidate).unwrap();
    let restored = SqlitePool::connect_with(options(&candidate)).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='memory_entry_revisions'"
        )
        .fetch_one(&restored)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_as::<_, (String, i64, Option<i64>)>(
            "SELECT content,enabled,last_used_at FROM memory_entries"
        )
        .fetch_one(&restored)
        .await
        .unwrap(),
        ("Original".into(), 0, Some(77))
    );
    restored.execute(migration.sql).await.unwrap();
    assert_legacy_migration(&restored).await;
    let hashes: Vec<(String, String)> = sqlx::query_as(
        "SELECT entry_id,content_hash FROM memory_entry_revisions ORDER BY entry_id,revision",
    )
    .fetch_all(&restored)
    .await
    .unwrap();
    let source_hashes: Vec<(String, String)> = sqlx::query_as(
        "SELECT source_id,content_hash FROM memory_source_revisions ORDER BY source_id,revision",
    )
    .fetch_all(&restored)
    .await
    .unwrap();
    restored.close().await;

    let reopened = SqlitePool::connect_with(options(&candidate)).await.unwrap();
    assert_legacy_migration(&reopened).await;
    assert_eq!(
        sqlx::query_as::<_, (String, String)>(
            "SELECT entry_id,content_hash FROM memory_entry_revisions ORDER BY entry_id,revision"
        )
        .fetch_all(&reopened)
        .await
        .unwrap(),
        hashes
    );
    assert_eq!(sqlx::query_as::<_, (String, String)>(
        "SELECT source_id,content_hash FROM memory_source_revisions ORDER BY source_id,revision")
        .fetch_all(&reopened).await.unwrap(), source_hashes);
    assert_eq!(
        sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
            .fetch_one(&reopened)
            .await
            .unwrap(),
        "ok"
    );
    reopened.close().await;
    assert_eq!(std::fs::read(&backup).unwrap(), backup_bytes);
    assert_eq!(std::fs::read(&original).unwrap(), backup_bytes);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn task165_k6_omitted_referenced_sources_survive_but_unlinked_entries_and_projects_retire() {
    let pool = database().await;
    let mut initial = input("A");
    let mut orphan_source = source();
    orphan_source.id = "orphan-source".into();
    orphan_source
        .content
        .insert("project_id".into(), Some("orphan-project".into()));
    let mut orphan = entry("orphan");
    orphan.id = "orphan".into();
    orphan
        .content
        .insert("source_ids".into(), Some("[\"orphan-source\"]".into()));
    orphan
        .content
        .insert("project_id".into(), Some("orphan-project".into()));
    initial.sources.push(orphan_source);
    initial.entries.push(orphan);
    initial.projects.push(Project {
        id: "orphan-project".into(),
        name: "Orphan".into(),
        scope: "project".into(),
        entry_count: 1,
    });
    publish(&pool, initial).await.unwrap();
    let mut next = input("A");
    next.sources.clear();
    publish(&pool, next).await.unwrap();
    assert_eq!(current(&pool).await.len(), 1);
    assert_eq!(current(&pool).await[0].3, 1);
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT id FROM memory_sources")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "source"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM memory_projects")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    assert!(pool
        .execute("DELETE FROM memory_sources WHERE id='source'")
        .await
        .is_err());
    assert!(pool
        .fetch_all("PRAGMA foreign_key_check")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn task165_file_database_publish_select_deactivate_rollback_and_restart() {
    let path = std::env::temp_dir().join(format!(
        "jarvis-task165-{}.db",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(options.clone())
        .await
        .unwrap();
    migrate(&pool, 20).await;
    publish(&pool, input("A")).await.unwrap();
    snapshot(&pool, "s1", 1, &hash_for(&pool, 1).await)
        .await
        .unwrap();
    commit_snapshot(&pool, "s1").await.unwrap();
    activate(&pool, "s1").await.unwrap();
    pool.execute("UPDATE interview_preparation_current_context SET selected_snapshot_id=NULL,revision=revision+1").await.unwrap();
    publish(&pool, input("B")).await.unwrap();
    snapshot(&pool, "s2", 2, &hash_for(&pool, 2).await)
        .await
        .unwrap();
    commit_snapshot(&pool, "s2").await.unwrap();
    activate(&pool, "s2").await.unwrap();
    publish(&pool, input("A")).await.unwrap();
    activate(&pool, "s1").await.unwrap();
    pool.execute("UPDATE memory_entries SET last_used_at=99")
        .await
        .unwrap();
    let expected = current(&pool).await;
    pool.close().await;
    let reopened = SqlitePool::connect_with(options).await.unwrap();
    initialize(&reopened).await.unwrap();
    assert_eq!(current(&reopened).await, expected);
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT selected_snapshot_id FROM interview_preparation_current_context"
        )
        .fetch_one(&reopened)
        .await
        .unwrap(),
        "s1"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM preparation_snapshot_invalid_kmb_pins WHERE snapshot_id='s1'"
        )
        .fetch_one(&reopened)
        .await
        .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>(
            "SELECT content FROM memory_entry_revisions WHERE entry_id='entry' AND revision=2"
        )
        .fetch_one(&reopened)
        .await
        .unwrap(),
        "B"
    );
    assert!(reopened
        .fetch_all("PRAGMA foreign_key_check")
        .await
        .unwrap()
        .is_empty());
    reopened.close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn task165_native_repository_readers_follow_committed_versions_and_policy() {
    let root = std::env::temp_dir().join(format!(
        "jarvis-k1-readers-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("fixture.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut pool = SqlitePool::connect_with(options.clone()).await.unwrap();
    migrate(&pool, 20).await;
    publish(&pool, input("A")).await.unwrap();
    let old_hash = hash_for(&pool, 1).await;
    snapshot(&pool, "s1", 1, &old_hash).await.unwrap();
    commit_snapshot(&pool, "s1").await.unwrap();
    activate(&pool, "s1").await.unwrap();
    pool.execute("UPDATE memory_entries SET last_used_at=77")
        .await
        .unwrap();
    pool.execute("INSERT INTO preparation_statement_proposal_operations
        (id,process_id,scope_kind,scope_key,conversation_id,expected_conversation_revision,source_manifest_json,source_manifest_hash,status,created_at)
        VALUES ('operation','p','process','process','fixture-conversation',0,'[]','manifest','committed',1);
      INSERT INTO preparation_statements
        (id,process_id,domain,content,normalized_content,status,authority,ownership,proposal_operation_id,last_review_action,last_review_actor,created_at,updated_at)
        VALUES ('statement','p','candidate-fact','A','a','confirmed','curated-kmb','candidate-owned','operation','confirmed','user',1,1);
      INSERT INTO preparation_statement_sources (id,statement_id,source_type,source_id,title,kmb_entry_revision,created_at)
        VALUES ('source','statement','curated-kmb','entry','Original entry',1,1);").await.unwrap();
    for stage in [
        "same-content",
        "changed-content",
        "revoked",
        "restored-content",
    ] {
        match stage {
            "same-content" => {
                assert_eq!(
                    publish(&pool, input("A")).await.unwrap().revisions_reused,
                    2
                );
            }
            "changed-content" => {
                let mut changed = input("B");
                changed.sources[0]
                    .content
                    .insert("title".into(), Some("Source B".into()));
                publish(&pool, changed).await.unwrap();
            }
            "revoked" => {
                pool.execute("UPDATE memory_entries SET enabled=0")
                    .await
                    .unwrap();
                let mut changed = input("B");
                changed.sources[0]
                    .content
                    .insert("title".into(), Some("Source B".into()));
                publish(&pool, changed).await.unwrap();
            }
            "restored-content" => {
                pool.execute("UPDATE memory_entries SET enabled=1")
                    .await
                    .unwrap();
                publish(&pool, input("A")).await.unwrap();
                activate(&pool, "s1").await.unwrap();
            }
            _ => unreachable!(),
        }
        let active = stage == "same-content" || stage == "restored-content";
        let revision = if active { 1 } else { 2 };
        let expected = json!({"kind":"memory","stage":stage,"revision":revision,
            "text":if active {"A"} else {"B"},"sourceTitle":if active {"Source A"} else {"Source B"},
            "enabled":stage!="revoked","active":active,"hash":hash_for(&pool,revision).await,"oldHash":old_hash});
        pool.close().await;
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let result = std::process::Command::new("node")
            .args(["--test", "tests/helpers/native-repository-readers.mjs"])
            .current_dir(repo)
            .env("JARVIS_NATIVE_REPOSITORY_DB", &path)
            .env("JARVIS_NATIVE_REPOSITORY_EXPECTED", expected.to_string())
            .output()
            .expect("Node must be available for native-to-repository acceptance");
        assert!(
            result.status.success(),
            "stage={stage}\n{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        pool = SqlitePool::connect_with(options.clone()).await.unwrap();
        initialize(&pool).await.unwrap();
    }
    pool.close().await;
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
#[ignore = "Bounded local KMB before/after database timing"]
async fn task165_database_performance_characterization() {
    fn percentile(samples: &mut [f64], p: f64) -> f64 {
        samples.sort_by(f64::total_cmp);
        samples[((samples.len() - 1) as f64 * p).ceil() as usize]
    }
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    migrate(&pool, 19).await;
    insert_legacy(&pool, Kind::Source, source()).await;
    for i in 0..100 {
        let mut candidate = entry(&"evidence ".repeat(200));
        candidate.id = format!("entry-{i:03}");
        insert_legacy(&pool, Kind::Entry, candidate).await;
    }
    let mut old_reads = Vec::new();
    for _ in 0..25 {
        let start = Instant::now();
        let rows =
            sqlx::query("SELECT * FROM memory_entries ORDER BY priority DESC,project_name,title")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(rows.len(), 100);
        old_reads.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    pool.execute(include_str!(
        "migrations/memory-content-revisions-and-snapshot-pins.sql"
    ))
    .await
    .unwrap();
    let start = Instant::now();
    initialize(&pool).await.unwrap();
    let init_ms = start.elapsed().as_secs_f64() * 1000.0;
    let mut reads = Vec::new();
    let mut rebuilds = Vec::new();
    let mut locks = Vec::new();
    for _ in 0..25 {
        let start = Instant::now();
        let rows=sqlx::query("SELECT r.*,e.id,e.enabled,e.created_at,e.updated_at,e.last_used_at FROM memory_entries e JOIN memory_entry_revisions r ON r.entry_id=e.id AND r.revision=e.current_content_revision ORDER BY r.priority DESC,r.project_name,r.title").fetch_all(&pool).await.unwrap();
        assert_eq!(rows.len(), 100);
        reads.push(start.elapsed().as_secs_f64() * 1000.0);
        let mut batch = input("unused");
        batch.entries = (0..100)
            .map(|i| {
                let mut e = entry(&"evidence ".repeat(200));
                e.id = format!("entry-{i:03}");
                e
            })
            .collect();
        let start = Instant::now();
        let result = publish(&pool, batch).await.unwrap();
        rebuilds.push(start.elapsed().as_secs_f64() * 1000.0);
        locks.push(result.lock_wait_ms);
    }
    let activation_pool = database().await;
    publish(&activation_pool, input("A")).await.unwrap();
    snapshot(
        &activation_pool,
        "s1",
        1,
        &hash_for(&activation_pool, 1).await,
    )
    .await
    .unwrap();
    commit_snapshot(&activation_pool, "s1").await.unwrap();
    let mut activations = Vec::new();
    for _ in 0..25 {
        let start = Instant::now();
        activate(&activation_pool, "s1").await.unwrap();
        activations.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    println!("task165-perf debug={} entries=100 body_chars=1800 n=25 init_ms={init_ms:.3} old_read_p50={:.3} old_read_p95={:.3} new_read_p50={:.3} new_read_p95={:.3} rebuild_p50={:.3} rebuild_p95={:.3} lock_wait_p95={:.3} activation_p50={:.3} activation_p95={:.3}",cfg!(debug_assertions),percentile(&mut old_reads,0.5),percentile(&mut old_reads,0.95),percentile(&mut reads,0.5),percentile(&mut reads,0.95),percentile(&mut rebuilds,0.5),percentile(&mut rebuilds,0.95),percentile(&mut locks,0.95),percentile(&mut activations,0.5),percentile(&mut activations,0.95));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM memory_entry_revisions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        100
    );
}

#[tokio::test]
async fn task165_k6_retention_keeps_pinned_stale_entries_disabled_and_source_history() {
    let pool = database().await;
    publish(&pool, input("A")).await.unwrap();
    snapshot(&pool, "s1", 1, &hash_for(&pool, 1).await)
        .await
        .unwrap();
    commit_snapshot(&pool, "s1").await.unwrap();
    let outcome = publish(
        &pool,
        PublishInput {
            sources: vec![],
            entries: vec![],
            projects: vec![],
            imported_at: 20,
        },
    )
    .await
    .unwrap();
    assert_eq!(outcome.retained_stale_entries, 1);
    assert_eq!(current(&pool).await[0].3, 0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM memory_source_revisions")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert!(activate(&pool, "s1").await.is_err());
    pool.execute(
        "UPDATE preparation_workspaces SET status='deleting'; DELETE FROM preparation_workspaces;",
    )
    .await
    .unwrap();
    publish(
        &pool,
        PublishInput {
            sources: vec![],
            entries: vec![],
            projects: vec![],
            imported_at: 21,
        },
    )
    .await
    .unwrap();
    assert!(current(&pool).await.is_empty());
    assert!(pool
        .fetch_all("PRAGMA foreign_key_check")
        .await
        .unwrap()
        .is_empty());
}
