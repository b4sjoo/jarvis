use super::*;
use sqlx::Executor;

const MATERIAL_REPOSITORY: &str =
    include_str!("../../../src/lib/database/preparation-material.action.ts");
const ROUND_REPOSITORY: &str =
    include_str!("../../../src/lib/database/interview-process.action.ts");
const WORKSPACE_REPOSITORY: &str =
    include_str!("../../../src/lib/database/preparation-workspace.action.ts");

fn sql(source: &'static str, method: &str, index: usize) -> &'static str {
    source
        .split_once(method)
        .unwrap()
        .1
        .split('`')
        .nth(index * 2 + 1)
        .unwrap()
}

async fn seed_legacy(pool: &SqlitePool) {
    for migration in crate::db::migrations()
        .into_iter()
        .filter(|m| m.version < 19)
    {
        pool.execute(migration.sql).await.unwrap();
    }
    pool.execute("INSERT INTO preparation_workspaces VALUES ('w','interview','Test','active',1,1,NULL);
      INSERT INTO preparation_materials (id,workspace_id,scope_kind,display_name,original_file_name,mime_type,extension,size_bytes,checksum_sha256,storage_relative_path,status,created_at,updated_at)
      VALUES ('m','w','workspace','Test','test.pdf','application/pdf','pdf',1,'checksum','materials/m/original.pdf','ready',1,1);
      INSERT INTO preparation_material_revisions (id,material_id,revision,source_checksum_sha256,extraction_status,extraction_request_id,review_status,extraction_metadata,created_at)
      VALUES ('a','m',1,'checksum','ready','old','approved','{\"method\":\"pdf-text\",\"chunkCount\":1}',1);
      INSERT INTO preparation_material_chunks (id,workspace_id,material_id,material_revision_id,extraction_request_id,ordinal,content,search_text,created_at) VALUES ('old-c','w','m','a','old',0,'old text','old text',1);
      INSERT INTO interview_processes (id,workspace_id,active_round_id,created_at,updated_at) VALUES ('p','w','round',1,1);
      INSERT INTO interview_rounds (id,process_id,title,stage,expected_interview_types,expected_type_policy,created_at,updated_at) VALUES ('round','p','Round','coding','[]','advisory',1,1),('sibling','p','Sibling','coding','[]','advisory',1,1);
      INSERT INTO interview_preparation_profile_revisions (id,process_id,scope_key,round_id,revision,source_fingerprint,content_hash,content_json,confirmed_statement_ids_json,unresolved_statement_ids_json,build_status,created_at)
      VALUES ('profile','p','round','round',1,'fingerprint','profile-hash','{}','[]','[]','committed',1);
      INSERT INTO interview_preparation_snapshots (id,process_id,round_id,version,profile_revision_id,profile_revision,compiler_version,playbook_registry_version,runtime_capability_version,source_fingerprint,content_hash,runtime_char_count,snapshot_json,source_manifest_json,warnings_json,status,build_status,created_at)
      VALUES ('snapshot','p','round',1,'profile',1,'compiler','playbook','capability','fingerprint','snapshot-hash',0,'{\"frozen\":\"A\"}','{\"materials\":[{\"materialId\":\"m\",\"materialRevisionId\":\"a\",\"sourceChecksumSha256\":\"checksum\"}]}','[]','ready','committed',1);
      INSERT INTO preparation_snapshot_material_revision_links (snapshot_id,material_id,material_revision_id,source_checksum_sha256,ordinal) VALUES ('snapshot','m','a','checksum',0);
      UPDATE interview_preparation_current_context SET process_id='p',round_id='round',selected_snapshot_id='snapshot',revision=1;").await.unwrap();
}

async fn fixture(migration19: bool) -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    seed_legacy(&pool).await;
    if migration19 {
        pool.execute(include_str!(
            "migrations/preparation-immutable-extraction-revisions.sql"
        ))
        .await
        .unwrap();
    }
    pool
}

async fn add_bootstrap_candidates(pool: &SqlitePool) {
    // Set up pre-migration data, including both current roles and unrelated history.
    pool.execute("INSERT INTO preparation_material_revisions (id,material_id,revision,source_checksum_sha256,extraction_status,extraction_request_id,review_status,extraction_metadata,created_at)
      VALUES ('history','m',2,'checksum','ready','history-request','approved','{\"method\":\"pdf-text\",\"chunkCount\":1}',1),
             ('b','m',3,'checksum','needs-review','b-request','needs-review','{\"method\":\"pdf-ocr\",\"chunkCount\":1}',1),
             ('unfinished','m',4,'checksum','extracting','unfinished-request','unreviewed',NULL,1),
             ('missing','m',5,'checksum','ready','missing-request','approved','{\"method\":\"pdf-text\",\"chunkCount\":1}',1);
      INSERT INTO preparation_material_chunks (id,workspace_id,material_id,material_revision_id,extraction_request_id,ordinal,content,search_text,created_at)
      VALUES ('history-c','w','m','history','history-request',0,'Historical','historical',1),
             ('b-c','w','m','b','b-request',0,'Candidate','candidate',1);").await.unwrap();
    pool.execute(include_str!(
        "migrations/preparation-immutable-extraction-revisions.sql"
    ))
    .await
    .unwrap();
    pool.execute(
        "UPDATE preparation_materials SET selected_revision_id='a',candidate_revision_id='b'",
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn task164_bootstrap_only_hashes_current_completed_outputs_and_preserves_authority() {
    let pool = fixture(false).await;
    add_bootstrap_candidates(&pool).await;
    let before:Vec<(String,String,String)>=sqlx::query_as("SELECT id,review_status,COALESCE(extraction_metadata,'null') FROM preparation_material_revisions ORDER BY id").fetch_all(&pool).await.unwrap();
    let pins_before: (String, String) = sqlx::query_as(
        "SELECT snapshot_json,source_manifest_json FROM interview_preparation_snapshots",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    bootstrap(&pool).await.unwrap();
    let hashed: Vec<String> = sqlx::query_scalar(
        "SELECT id FROM preparation_material_revisions WHERE output_hash IS NOT NULL ORDER BY id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(hashed, vec!["a", "b"]);
    assert_eq!(sqlx::query_as::<_,(String,String,String)>("SELECT id,review_status,COALESCE(extraction_metadata,'null') FROM preparation_material_revisions ORDER BY id").fetch_all(&pool).await.unwrap(),before);
    assert_eq!(
        sqlx::query_as::<_, (String, String)>(
            "SELECT selected_revision_id,candidate_revision_id FROM preparation_materials"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        ("a".into(), "b".into())
    );
    assert_eq!(
        sqlx::query_as::<_, (String, String)>(
            "SELECT snapshot_json,source_manifest_json FROM interview_preparation_snapshots"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        pins_before
    );
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT output_hash FROM preparation_snapshot_material_revision_links"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        None
    );
    assert!(pool
        .execute("UPDATE interview_preparation_current_context SET selected_snapshot_id='snapshot'")
        .await
        .is_err());
    pool.execute("UPDATE preparation_materials SET candidate_revision_id='unfinished'")
        .await
        .unwrap();
    bootstrap(&pool).await.unwrap();
    pool.execute("UPDATE preparation_materials SET candidate_revision_id='missing'")
        .await
        .unwrap();
    bootstrap(&pool).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT COUNT(*) FROM preparation_material_revisions WHERE id IN ('history','unfinished','missing') AND output_hash IS NULL").fetch_one(&pool).await.unwrap(),3);
    assert!(pool
        .fetch_all("PRAGMA foreign_key_check")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn task164_bootstrap_failure_rolls_back_all_current_hashes() {
    let pool = fixture(false).await;
    add_bootstrap_candidates(&pool).await;
    pool.execute("CREATE TRIGGER fail_bootstrap BEFORE UPDATE OF output_hash ON preparation_material_revisions WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT,'bootstrap failure'); END;").await.unwrap();
    assert!(bootstrap(&pool)
        .await
        .unwrap_err()
        .contains("bootstrap failure"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM preparation_material_revisions WHERE output_hash IS NOT NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );
    pool.execute("DROP TRIGGER fail_bootstrap").await.unwrap();
    bootstrap(&pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM preparation_material_revisions WHERE output_hash IS NOT NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        2
    );
}

#[tokio::test]
async fn task164_simultaneous_webview_bootstraps_use_the_same_sqlite_transaction_boundary() {
    let path = std::env::temp_dir().join(format!(
        "jarvis-task164-bootstrap-{}.db",
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
        .connect_with(options)
        .await
        .unwrap();
    seed_legacy(&pool).await;
    add_bootstrap_candidates(&pool).await;
    let (first, second) = tokio::join!(bootstrap(&pool), bootstrap(&pool));
    first.unwrap();
    second.unwrap();
    let hashes:Vec<(String,String)>=sqlx::query_as("SELECT id,output_hash FROM preparation_material_revisions WHERE output_hash IS NOT NULL ORDER BY id").fetch_all(&pool).await.unwrap();
    assert_eq!(hashes.len(), 2);
    bootstrap(&pool).await.unwrap();
    assert_eq!(sqlx::query_as::<_,(String,String)>("SELECT id,output_hash FROM preparation_material_revisions WHERE output_hash IS NOT NULL ORDER BY id").fetch_all(&pool).await.unwrap(),hashes);
    assert!(pool
        .fetch_all("PRAGMA foreign_key_check")
        .await
        .unwrap()
        .is_empty());
    pool.close().await;
    std::fs::remove_file(path).unwrap();
}

async fn material_lifecycle(pool: &SqlitePool, status: &str, deleted: Option<i64>) {
    sqlx::query(sql(MATERIAL_REPOSITORY, "async setLifecycle(input)", 0))
        .bind(status)
        .bind(2_i64)
        .bind(deleted)
        .bind("m")
        .bind("w")
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn task164_review_explicit_material_delete_and_restore_preserve_pins() {
    for migrated in [false, true] {
        let pool = fixture(migrated).await;
        material_lifecycle(&pool, "deleted", Some(2)).await;
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM preparation_snapshot_material_revision_links"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT content FROM preparation_material_chunks")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "old text"
        );
        material_lifecycle(&pool, "ready", None).await;
        assert!(pool
            .fetch_all("PRAGMA foreign_key_check")
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn task164_review_round_deletion_uses_archive_and_keeps_sibling() {
    for migrated in [false, true] {
        let pool = fixture(migrated).await;
        pool.execute(
            "UPDATE preparation_materials SET scope_kind='round',scope_id='round' WHERE id='m'",
        )
        .await
        .unwrap();
        // File staging precedes this material soft-delete; no SQL DELETE is used by the Round owner.
        material_lifecycle(&pool, "deleted", Some(2)).await;
        sqlx::query(sql(ROUND_REPOSITORY, "async deleteRound(input)", 0))
            .bind("sibling")
            .bind(2_i64)
            .bind("p")
            .bind("round")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(sql(ROUND_REPOSITORY, "async deleteRound(input)", 1))
            .bind(2_i64)
            .bind(2_i64)
            .bind("round")
            .bind("p")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM interview_rounds WHERE id='sibling' AND archived_at IS NULL"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM preparation_snapshot_material_revision_links"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT selected_snapshot_id FROM interview_preparation_current_context"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            None
        );
        assert!(pool
            .fetch_all("PRAGMA foreign_key_check")
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn task164_review_process_deletion_matches_workspace_repository_order() {
    for migrated in [false, true] {
        let pool = fixture(migrated).await;
        sqlx::query(sql(WORKSPACE_REPOSITORY, "async setLifecycle(input)", 0))
            .bind("deleting")
            .bind(2_i64)
            .bind(None::<i64>)
            .bind("w")
            .execute(&pool)
            .await
            .unwrap();
        assert!(WORKSPACE_REPOSITORY.contains("DELETE FROM preparation_workspaces WHERE id = ?"));
        let deleted = sqlx::query("DELETE FROM preparation_workspaces WHERE id = ?")
            .bind("w")
            .execute(&pool)
            .await;
        assert!(deleted.is_ok(), "migration19={migrated}: {deleted:?}");
        for table in [
            "preparation_materials",
            "preparation_material_revisions",
            "preparation_material_chunks",
            "preparation_snapshot_material_revision_links",
            "interview_preparation_snapshots",
            "interview_rounds",
            "interview_processes",
        ] {
            assert_eq!(
                sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {table}"))
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                0,
                "{table}"
            );
        }
        assert!(pool
            .fetch_all("PRAGMA foreign_key_check")
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn task164_review_original_pin_and_revision_guards_allow_actual_cascade_order() {
    let pool = fixture(true).await;
    pool.execute("DROP TRIGGER preparation_snapshot_material_pin_delete;
      CREATE TRIGGER preparation_snapshot_material_pin_delete BEFORE DELETE ON preparation_snapshot_material_revision_links
      WHEN EXISTS (SELECT 1 FROM interview_preparation_snapshots WHERE id=OLD.snapshot_id AND build_status='committed')
      BEGIN SELECT RAISE(ABORT,'Committed material pins are immutable.'); END;
      DROP TRIGGER preparation_extraction_revision_delete;
      CREATE TRIGGER preparation_extraction_revision_delete BEFORE DELETE ON preparation_material_revisions
      WHEN OLD.extraction_status IN ('ready','needs-review','unsupported') AND EXISTS (
        SELECT 1 FROM preparation_materials m WHERE m.id=OLD.material_id AND m.status<>'deleted' AND m.deleted_at IS NULL)
      BEGIN SELECT RAISE(ABORT,'Completed extraction revisions must be retained.'); END;").await.unwrap();
    sqlx::query(sql(WORKSPACE_REPOSITORY, "async setLifecycle(input)", 0))
        .bind("deleting")
        .bind(2_i64)
        .bind(None::<i64>)
        .bind("w")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM preparation_workspaces WHERE id = ?")
        .bind("w")
        .execute(&pool)
        .await
        .unwrap();
    assert!(pool
        .fetch_all("PRAGMA foreign_key_check")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn task164_review_direct_deletion_and_failed_process_delete_keep_protection() {
    let pool = fixture(true).await;
    for query in [
        "DELETE FROM preparation_material_chunks",
        "DELETE FROM preparation_material_revisions",
        "DELETE FROM preparation_snapshot_material_revision_links",
    ] {
        assert!(pool.execute(query).await.is_err(), "{query}");
    }
    pool.execute("CREATE TRIGGER injected_delete_failure BEFORE DELETE ON interview_processes BEGIN SELECT RAISE(ABORT,'injected process delete failure'); END;").await.unwrap();
    sqlx::query(sql(WORKSPACE_REPOSITORY, "async setLifecycle(input)", 0))
        .bind("deleting")
        .bind(2_i64)
        .bind(None::<i64>)
        .bind("w")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        sqlx::query("DELETE FROM preparation_workspaces WHERE id = ?")
            .bind("w")
            .execute(&pool)
            .await
            .is_err()
    );
    sqlx::query(sql(WORKSPACE_REPOSITORY, "async setLifecycle(input)", 0))
        .bind("active")
        .bind(3_i64)
        .bind(None::<i64>)
        .bind("w")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT content FROM preparation_material_chunks")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "old text"
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM preparation_snapshot_material_revision_links"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert!(pool
        .execute("DELETE FROM preparation_material_chunks")
        .await
        .is_err());
    assert!(pool
        .execute("DELETE FROM preparation_snapshot_material_revision_links")
        .await
        .is_err());
    assert!(pool
        .fetch_all("PRAGMA foreign_key_check")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[ignore = "Local current-only bootstrap timing; synthetic temporary database only"]
async fn task164_review_current_bootstrap_cost_and_historical_reads() {
    use std::time::{Instant, SystemTime, UNIX_EPOCH};
    let path = std::env::temp_dir().join(format!(
        "jarvis-task164-checkpoint-{}.db",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    seed_legacy(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    // Five independent cold targets, each with 2M content characters; other history stays untouched.
    let targets = ["a", "large-1", "large-2", "large-3", "large-4"];
    sqlx::query("DELETE FROM preparation_material_chunks WHERE material_revision_id='a'")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE preparation_material_revisions SET extraction_metadata='{\"method\":\"pdf-text\",\"chunkCount\":2000}' WHERE id='a'").execute(&mut *tx).await.unwrap();
    for i in 2..=205_i64 {
        sqlx::query("INSERT INTO preparation_material_revisions (id,material_id,revision,source_checksum_sha256,extraction_status,extraction_request_id,review_status,extraction_metadata,created_at) VALUES (?,'m',?,'checksum','ready',?,'approved','{\"method\":\"pdf-text\",\"chunkCount\":0}',1)")
            .bind(format!("history-{i}")).bind(i).bind(format!("request-{i}")).execute(&mut *tx).await.unwrap();
    }
    for (i, target) in targets.iter().enumerate() {
        if i > 0 {
            sqlx::query("INSERT INTO preparation_material_revisions (id,material_id,revision,source_checksum_sha256,extraction_status,extraction_request_id,review_status,extraction_metadata,created_at) VALUES (?,'m',?,'checksum','ready','old','approved','{\"method\":\"pdf-text\",\"chunkCount\":2000}',1)")
                .bind(target).bind(300+i as i64).execute(&mut *tx).await.unwrap();
        }
        for ordinal in 0..2000_i64 {
            let content = format!("{ordinal:04}{}", "x".repeat(996));
            sqlx::query("INSERT INTO preparation_material_chunks (id,workspace_id,material_id,material_revision_id,extraction_request_id,ordinal,content,search_text,source_method,created_at) VALUES (?,'w','m',?,'old',?,?,?,'pdf-text',1)")
                .bind(format!("{target}-{ordinal}")).bind(target).bind(ordinal).bind(&content).bind(&content).execute(&mut *tx).await.unwrap();
        }
    }
    sqlx::query("INSERT INTO preparation_material_revisions (id,material_id,revision,source_checksum_sha256,extraction_status,extraction_request_id,review_status,extraction_metadata,created_at) VALUES ('current','m',1000,'checksum','ready','current-request','approved','{\"method\":\"pdf-text\",\"chunkCount\":1}',1)").execute(&mut *tx).await.unwrap();
    sqlx::query("INSERT INTO preparation_material_chunks (id,workspace_id,material_id,material_revision_id,extraction_request_id,ordinal,content,search_text,created_at) VALUES ('current-c','w','m','current','current-request',0,'current text','current text',1)").execute(&mut *tx).await.unwrap();
    tx.commit().await.unwrap();
    pool.execute(include_str!(
        "migrations/preparation-immutable-extraction-revisions.sql"
    ))
    .await
    .unwrap();
    let snapshots_before: (String,String)=sqlx::query_as("SELECT snapshot_json,source_manifest_json FROM interview_preparation_snapshots WHERE id='snapshot'").fetch_one(&pool).await.unwrap();
    let content_before: (i64, i64) =
        sqlx::query_as("SELECT COUNT(*),SUM(length(content)) FROM preparation_material_chunks")
            .fetch_one(&pool)
            .await
            .unwrap();
    let repository = include_str!("../../../src/lib/database/preparation-extraction.action.ts");
    let read = format!(
        "{} AND m.id = ? AND r.id = ? LIMIT 1",
        sql(repository, "const EXTRACTION_SELECT =", 0)
    );
    let startup = Instant::now();
    bootstrap(&pool).await.unwrap();
    let small_current_startup_ms = startup.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM preparation_material_revisions WHERE output_hash IS NOT NULL"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    let mut warm = Vec::new();
    for _ in 0..50 {
        let start = Instant::now();
        let row = sqlx::query(&read)
            .bind("m")
            .bind("a")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(row.get::<Option<String>, _>("output_hash").is_none());
        warm.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let expected = sqlx::query_scalar::<_, Option<String>>(
        "SELECT output_hash FROM preparation_material_revisions WHERE id='a'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let history_start = Instant::now();
    let chunks=sqlx::query("SELECT content FROM preparation_material_chunks WHERE material_revision_id='a' AND extraction_request_id='old' ORDER BY ordinal").fetch_all(&pool).await.unwrap();
    let history_read_ms = history_start.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(chunks.len(), 2000);
    assert_eq!(
        chunks
            .iter()
            .map(|r| r.get::<String, _>("content").len())
            .sum::<usize>(),
        2_000_000
    );
    bootstrap(&pool).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT output_hash FROM preparation_material_revisions WHERE id='a'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        expected
    );
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT output_hash FROM preparation_snapshot_material_revision_links"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        None
    );
    assert_eq!(sqlx::query_as::<_,(String,String)>("SELECT snapshot_json,source_manifest_json FROM interview_preparation_snapshots WHERE id='snapshot'").fetch_one(&pool).await.unwrap(),snapshots_before);
    assert_eq!(
        sqlx::query_as::<_, (i64, i64)>(
            "SELECT COUNT(*),SUM(length(content)) FROM preparation_material_chunks"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        content_before
    );
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT selected_revision_id FROM preparation_materials")
            .fetch_one(&pool)
            .await
            .unwrap(),
        "current"
    );
    assert!(pool
        .execute("UPDATE interview_preparation_current_context SET selected_snapshot_id='snapshot'")
        .await
        .is_err());
    let plan=sqlx::query("EXPLAIN QUERY PLAN SELECT * FROM preparation_material_chunks WHERE material_revision_id=? AND extraction_request_id=? ORDER BY ordinal").bind("a").bind("old").fetch_all(&pool).await.unwrap();
    let detail = plan
        .iter()
        .map(|r| r.get::<String, _>("detail"))
        .collect::<Vec<_>>()
        .join("; ");
    assert!(detail.contains("INDEX"), "{detail}");
    let mut missing = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        let row = sqlx::query(&read)
            .bind("m")
            .bind("history-2")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<Option<String>, _>("output_hash"), None);
        missing.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    missing.sort_by(f64::total_cmp);
    let mut cold = Vec::new();
    for target in targets {
        sqlx::query("UPDATE preparation_materials SET selected_revision_id=?,candidate_revision_id=? WHERE id='m'").bind(target).bind(target).execute(&pool).await.unwrap();
        let start = Instant::now();
        bootstrap(&pool).await.unwrap();
        cold.push(start.elapsed().as_secs_f64() * 1000.0);
        assert!(sqlx::query_scalar::<_, Option<String>>(
            "SELECT output_hash FROM preparation_material_revisions WHERE id=?"
        )
        .bind(target)
        .fetch_one(&pool)
        .await
        .unwrap()
        .is_some());
    }
    sqlx::query("UPDATE preparation_materials SET selected_revision_id='current',candidate_revision_id='current' WHERE id='m'").execute(&pool).await.unwrap();
    cold.sort_by(f64::total_cmp);
    warm.sort_by(f64::total_cmp);
    let journal: String = sqlx::query_scalar("PRAGMA journal_mode")
        .fetch_one(&pool)
        .await
        .unwrap();
    println!("task164-bootstrap: debug={} journal={} revisions=210 small_current_first_open_ms={:.3} large_current_chunks=2000 large_current_chars=2000000 large_current_first_open_n={} median_ms={:.3} max_ms={:.3} unverified_history_read_n={} median_ms={:.3} p95_ms={:.3} db_bytes={} plan={}",cfg!(debug_assertions),journal,small_current_startup_ms,cold.len(),cold[cold.len()/2],cold[cold.len()-1],warm.len(),warm[warm.len()/2],warm[47],std::fs::metadata(&path).unwrap().len(),detail);
    println!("task164-history: full_content_read_n=1 full_content_read_ms={history_read_ms:.3} missing_n={} missing_median_ms={:.3} missing_max_ms={:.3}",missing.len(),missing[missing.len()/2],missing[missing.len()-1]);
    assert!(pool
        .fetch_all("PRAGMA foreign_key_check")
        .await
        .unwrap()
        .is_empty());
    pool.close().await;
    std::fs::remove_file(path).unwrap();
}
