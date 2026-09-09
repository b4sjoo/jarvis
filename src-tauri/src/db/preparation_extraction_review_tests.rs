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

#[tokio::test]
async fn task164_e5_file_copy_migration_failure_restore_and_reopen() {
    let root = std::env::temp_dir().join(format!(
        "jarvis-e5-{}-{}",
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
    seed_legacy(&pool).await;
    let content_before: (String, String, String, String) = sqlx::query_as(
        "SELECT r.review_status,r.extraction_metadata,c.content,c.extraction_request_id
         FROM preparation_material_revisions r JOIN preparation_material_chunks c ON c.material_revision_id=r.id")
        .fetch_one(&pool).await.unwrap();
    let snapshot_before: (String, String) = sqlx::query_as(
        "SELECT snapshot_json,source_manifest_json FROM interview_preparation_snapshots",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    // Copy only a closed database; no live WAL or user database is involved.
    pool.close().await;
    std::fs::copy(&original, &backup).unwrap();
    let backup_bytes = std::fs::read(&backup).unwrap();
    std::fs::copy(&backup, &candidate).unwrap();
    let migration = crate::db::migrations()
        .into_iter()
        .find(|m| m.version == 19)
        .unwrap();
    let failed = SqlitePool::connect_with(options(&candidate)).await.unwrap();
    failed.execute(migration.sql).await.unwrap();
    failed.execute("CREATE TRIGGER injected_copy_failure BEFORE UPDATE OF output_hash ON preparation_material_revisions BEGIN SELECT RAISE(ABORT,'injected copy bootstrap failure'); END").await.unwrap();
    assert!(bootstrap(&failed)
        .await
        .unwrap_err()
        .contains("injected copy bootstrap failure"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM preparation_material_revisions WHERE output_hash IS NOT NULL"
        )
        .fetch_one(&failed)
        .await
        .unwrap(),
        0
    );
    failed.close().await;

    std::fs::copy(&backup, &candidate).unwrap();
    let restored = SqlitePool::connect_with(options(&candidate)).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM pragma_table_info('preparation_material_revisions') WHERE name='output_hash'")
        .fetch_one(&restored).await.unwrap(), 0);
    assert_eq!(sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT r.review_status,r.extraction_metadata,c.content,c.extraction_request_id FROM preparation_material_revisions r JOIN preparation_material_chunks c ON c.material_revision_id=r.id")
        .fetch_one(&restored).await.unwrap(), content_before);
    restored.execute(migration.sql).await.unwrap();
    bootstrap(&restored).await.unwrap();
    let hashes: Vec<(String, String)> = sqlx::query_as(
        "SELECT id,output_hash FROM preparation_material_revisions WHERE output_hash IS NOT NULL ORDER BY id")
        .fetch_all(&restored).await.unwrap();
    assert_eq!(hashes.len(), 1);
    assert_eq!(
        sqlx::query_as::<_, (String, String)>(
            "SELECT selected_revision_id,candidate_revision_id FROM preparation_materials"
        )
        .fetch_one(&restored)
        .await
        .unwrap(),
        ("a".into(), "a".into())
    );
    assert_eq!(
        sqlx::query_as::<_, (String, String)>(
            "SELECT snapshot_json,source_manifest_json FROM interview_preparation_snapshots"
        )
        .fetch_one(&restored)
        .await
        .unwrap(),
        snapshot_before
    );
    assert_eq!(
        sqlx::query_scalar::<_, Option<String>>(
            "SELECT output_hash FROM preparation_snapshot_material_revision_links"
        )
        .fetch_one(&restored)
        .await
        .unwrap(),
        None
    );
    assert!(restored
        .execute("UPDATE interview_preparation_current_context SET selected_snapshot_id='snapshot'")
        .await
        .is_err());
    restored.close().await;

    let reopened = SqlitePool::connect_with(options(&candidate)).await.unwrap();
    bootstrap(&reopened).await.unwrap();
    assert_eq!(sqlx::query_as::<_, (String, String)>(
        "SELECT id,output_hash FROM preparation_material_revisions WHERE output_hash IS NOT NULL ORDER BY id")
        .fetch_all(&reopened).await.unwrap(), hashes);
    assert_eq!(sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT r.review_status,r.extraction_metadata,c.content,c.extraction_request_id FROM preparation_material_revisions r JOIN preparation_material_chunks c ON c.material_revision_id=r.id")
        .fetch_one(&reopened).await.unwrap(), content_before);
    assert!(reopened
        .fetch_all("PRAGMA foreign_key_check")
        .await
        .unwrap()
        .is_empty());
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
#[ignore = "Two-operation test transport; invoked explicitly by the E1 fixture parent"]
async fn task164_two_operation_driver() {
    let path = std::path::PathBuf::from(std::env::var("JARVIS_NATIVE_REPOSITORY_DB").unwrap());
    let result_path =
        std::path::PathBuf::from(std::env::var("JARVIS_NATIVE_OPERATION_RESULT").unwrap());
    assert_eq!(result_path.parent(), path.parent());
    let input = std::env::var("JARVIS_NATIVE_OPERATION_INPUT").unwrap();
    let pool = SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
        .await
        .unwrap();
    let result = match std::env::var("JARVIS_NATIVE_OPERATION").unwrap().as_str() {
        "preparation_extraction_claim" => {
            claim(&pool, serde_json::from_str::<ClaimInput>(&input).unwrap())
                .await
                .map(|id| json!(id))
        }
        "preparation_extraction_fail" => {
            fail(&pool, serde_json::from_str::<FailInput>(&input).unwrap())
                .await
                .map(|changed| json!(changed))
        }
        other => panic!("Unsupported test operation: {other}"),
    };
    pool.close().await;
    std::fs::write(result_path, serde_json::to_vec(&result).unwrap()).unwrap();
}

#[tokio::test]
async fn task164_native_repository_readers_follow_failure_and_publication() {
    let root = std::env::temp_dir().join(format!(
        "jarvis-e1-readers-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&root).unwrap();
    let original = root.join("materials/m/original.pdf");
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    std::fs::write(&original, b"unchanged original fixture bytes").unwrap();
    let path = root.join("fixture.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut pool = SqlitePool::connect_with(options.clone()).await.unwrap();
    for migration in crate::db::migrations()
        .into_iter()
        .filter(|m| m.version < 19)
    {
        pool.execute(migration.sql).await.unwrap();
    }
    // The production process creator uses workspace.id as process.id.
    pool.execute("INSERT INTO preparation_workspaces VALUES ('w','interview','Test','active',1,1,NULL);
      INSERT INTO preparation_materials (id,workspace_id,scope_kind,display_name,original_file_name,mime_type,extension,size_bytes,checksum_sha256,storage_relative_path,status,created_at,updated_at)
      VALUES ('m','w','workspace','Test','test.pdf','application/pdf','pdf',1,'checksum','materials/m/original.pdf','ready',1,1);
      INSERT INTO preparation_material_revisions (id,material_id,revision,source_checksum_sha256,extraction_status,extraction_request_id,review_status,extraction_metadata,created_at)
      VALUES ('a','m',1,'checksum','ready','old','approved','{\"method\":\"pdf-text\",\"chunkCount\":1}',1);
      INSERT INTO preparation_material_chunks (id,workspace_id,material_id,material_revision_id,extraction_request_id,ordinal,content,search_text,source_method,created_at)
      VALUES ('old-c','w','m','a','old',0,'old text','old text','pdf-text',1);
      INSERT INTO interview_processes (id,workspace_id,created_at,updated_at) VALUES ('w','w',1,1);
      INSERT INTO interview_rounds (id,process_id,title,stage,expected_interview_types,expected_type_policy,created_at,updated_at) VALUES ('round','w','Round','coding','[]','advisory',1,1);
      INSERT INTO interview_preparation_profile_revisions (id,process_id,scope_key,round_id,revision,source_fingerprint,content_hash,content_json,confirmed_statement_ids_json,unresolved_statement_ids_json,build_status,created_at)
      VALUES ('profile','w','round','round',1,'fp','ph','{}','[]','[]','committed',1);").await.unwrap();
    for migration in crate::db::migrations()
        .into_iter()
        .filter(|m| m.version >= 19)
    {
        pool.execute(migration.sql).await.unwrap();
    }
    bootstrap(&pool).await.unwrap();
    let old_hash: String =
        sqlx::query_scalar("SELECT output_hash FROM preparation_material_revisions WHERE id='a'")
            .fetch_one(&pool)
            .await
            .unwrap();
    let manifest = json!({"materials":[{"materialId":"m","materialRevisionId":"a","sourceChecksumSha256":"checksum","outputHash":old_hash}],"kmbEntries":[]});
    let payload = json!({"schemaVersion":2,"runtimeBrief":{"role":"old text"},
        "artifactManifest":{"version":"preparation-artifact-manifest-v1","artifacts":[]}});
    sqlx::query("INSERT INTO interview_preparation_snapshots (id,process_id,round_id,version,profile_revision_id,profile_revision,compiler_version,playbook_registry_version,runtime_capability_version,source_fingerprint,content_hash,runtime_char_count,snapshot_json,source_manifest_json,warnings_json,status,build_status,created_at,schema_version)
      VALUES ('snapshot','w','round',1,'profile',1,'compiler','playbook','capability','fp','snapshot-hash',0,?,?,'[]','ready','staging',1,2)")
        .bind(payload.to_string()).bind(manifest.to_string()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO preparation_snapshot_material_revision_links (snapshot_id,material_id,material_revision_id,source_checksum_sha256,output_hash,ordinal) VALUES ('snapshot','m','a','checksum',?,0)")
        .bind(&old_hash).execute(&pool).await.unwrap();
    pool.execute(
        "UPDATE interview_preparation_snapshots SET build_status='committed' WHERE id='snapshot'",
    )
    .await
    .unwrap();
    pool.execute("INSERT INTO preparation_statement_proposal_operations
        (id,process_id,scope_kind,scope_key,conversation_id,expected_conversation_revision,source_manifest_json,source_manifest_hash,status,created_at)
        VALUES ('operation','w','process','process','fixture-conversation',0,'[]','manifest','committed',1);
      INSERT INTO preparation_statements
        (id,process_id,domain,content,normalized_content,status,authority,ownership,proposal_operation_id,last_review_action,last_review_actor,created_at,updated_at)
        VALUES ('statement','w','candidate-fact','old text','old text','confirmed','material-grounded','candidate-owned','operation','confirmed','user',1,1);
      INSERT INTO preparation_statement_sources (id,statement_id,source_type,source_id,title,material_id,material_revision_id,created_at)
        VALUES ('source','statement','material-chunk','old-c','Original material','m','a',1);").await.unwrap();
    let request = |base: &str, next: &str| {
        serde_json::from_value::<ClaimInput>(json!({
        "workspaceId":"w","materialId":"m","revisionId":base,"newRevisionId":next,
        "sourceChecksumSha256":"checksum","requestId":format!("request-{next}"),
        "startedAt":10,"staleBefore":0,"force":true}))
        .unwrap()
    };
    let completion = |id: &str| {
        serde_json::from_value::<CompleteInput>(json!({
        "workspaceId":"w","materialId":"m","revisionId":id,"requestId":format!("request-{id}"),
        "status":"ready","metadata":{"method":"pdf-text","chunkCount":1},
        "reviewStatus":"unreviewed","reviewActor":"runtime","completedAt":20,
        "chunks":[{"id":format!("chunk-{id}"),"workspaceId":"w","materialId":"m","materialRevisionId":id,
          "extractionRequestId":format!("request-{id}"),"ordinal":0,"content":"new text","searchText":"new text",
          "sourceMethod":"pdf-text","createdAt":20}]})).unwrap()
    };
    for stage in [
        "claim-failure",
        "file-failure",
        "claimed",
        "completion-failure",
        "failed",
        "published",
    ] {
        match stage {
            "claim-failure" => {
                pool.execute("CREATE TRIGGER injected_claim BEFORE UPDATE OF candidate_revision_id ON preparation_materials BEGIN SELECT RAISE(ABORT,'injected claim'); END").await.unwrap();
                assert!(claim(&pool, request("a", "b")).await.is_err());
                pool.execute("DROP TRIGGER injected_claim").await.unwrap();
            }
            "file-failure" => {} // The actual TS service invokes claim and fail in the Node child.
            "claimed" => {
                assert_eq!(
                    claim(&pool, request("file-b", "b")).await.unwrap(),
                    Some("b".into())
                );
            }
            "completion-failure" => {
                pool.execute("CREATE TRIGGER injected_complete BEFORE UPDATE OF output_hash ON preparation_material_revisions BEGIN SELECT RAISE(ABORT,'injected complete'); END").await.unwrap();
                assert!(complete(&pool, completion("b")).await.is_err());
                pool.execute("DROP TRIGGER injected_complete")
                    .await
                    .unwrap();
            }
            "failed" => {
                assert!(fail(&pool, serde_json::from_value(json!({"workspaceId":"w","materialId":"m",
                    "revisionId":"b","requestId":"request-b","metadata":{"error":"failed candidate"},"completedAt":20})).unwrap()).await.unwrap());
            }
            "published" => {
                assert_eq!(
                    claim(&pool, request("b", "c")).await.unwrap(),
                    Some("c".into())
                );
                assert!(complete(&pool, completion("c")).await.unwrap());
            }
            _ => unreachable!(),
        }
        let published = stage == "published";
        let selected = if published { "c" } else { "a" };
        let selected_hash: String =
            sqlx::query_scalar("SELECT output_hash FROM preparation_material_revisions WHERE id=?")
                .bind(selected)
                .fetch_one(&pool)
                .await
                .unwrap();
        let expected = json!({"kind":"extraction","stage":stage,"selected":selected,"selectedHash":selected_hash,"oldHash":old_hash,
            "text":if published {"new text"} else {"old text"},
            "candidate":if published {"c"} else if stage=="claim-failure" {"a"} else if stage=="file-failure" {"file-b"} else {"b"},
            "candidateStatus":if published || stage=="claim-failure" {"ready"} else if stage=="failed" || stage=="file-failure" {"failed"} else {"extracting"}});
        pool.close().await;
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap();
        let result = std::process::Command::new("node")
            .args(["--test", "tests/helpers/native-repository-readers.mjs"])
            .current_dir(repo)
            .env("JARVIS_NATIVE_REPOSITORY_DB", &path)
            .env("JARVIS_NATIVE_TEST_BINARY", std::env::current_exe().unwrap())
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
        assert_eq!(std::fs::read(&original).unwrap(), b"unchanged original fixture bytes");
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT storage_relative_path FROM preparation_materials WHERE id='m'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "materials/m/original.pdf"
        );
    }
    pool.close().await;
    std::fs::remove_dir_all(root).unwrap();
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
