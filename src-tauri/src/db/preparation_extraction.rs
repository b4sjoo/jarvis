use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection, SqlitePool};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimInput {
    workspace_id: String,
    material_id: String,
    revision_id: String,
    new_revision_id: String,
    source_checksum_sha256: String,
    request_id: String,
    started_at: i64,
    stale_before: i64,
    #[serde(default)]
    force: bool,
    derived: Option<DerivedReview>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivedReview {
    review_status: String,
    review_actor: String,
    quality_signals: Value,
    action: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    id: String,
    workspace_id: String,
    material_id: String,
    material_revision_id: String,
    extraction_request_id: String,
    ordinal: i64,
    content: String,
    search_text: String,
    page: Option<i64>,
    section: Option<String>,
    source_method: String,
    confidence: Option<f64>,
    start_offset: Option<i64>,
    end_offset: Option<i64>,
    created_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteInput {
    workspace_id: String,
    material_id: String,
    revision_id: String,
    request_id: String,
    status: String,
    extracted_text_relative_path: Option<String>,
    metadata: Value,
    chunks: Vec<Chunk>,
    review_status: String,
    review_actor: String,
    #[serde(default = "empty_array")]
    quality_signals: Value,
    completed_at: i64,
}

fn empty_array() -> Value {
    json!([])
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailInput {
    workspace_id: String,
    material_id: String,
    revision_id: String,
    request_id: String,
    metadata: Value,
    completed_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewInput {
    workspace_id: String,
    material_id: String,
    revision_id: String,
    expected_request_id: Option<String>,
    expected_review_event_id: Option<String>,
    review_status: String,
    actor: String,
    quality_signals: Value,
    event_id: String,
    action: String,
    detail: Option<String>,
    updated_at: i64,
}

async fn pool(instances: State<'_, DbInstances>) -> Result<SqlitePool, String> {
    let guard = instances.0.read().await;
    match guard.get("sqlite:jarvis.db") {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err("Preparation database is not loaded.".into()),
    }
}

#[tauri::command]
pub async fn preparation_extraction_claim(
    instances: State<'_, DbInstances>,
    input: ClaimInput,
) -> Result<Option<String>, String> {
    claim(&pool(instances).await?, input).await
}
#[tauri::command]
pub async fn preparation_extraction_complete(
    instances: State<'_, DbInstances>,
    input: CompleteInput,
) -> Result<bool, String> {
    complete(&pool(instances).await?, input).await
}
#[tauri::command]
pub async fn preparation_extraction_fail(
    instances: State<'_, DbInstances>,
    input: FailInput,
) -> Result<bool, String> {
    fail(&pool(instances).await?, input).await
}
#[tauri::command]
pub async fn preparation_extraction_review(
    instances: State<'_, DbInstances>,
    input: ReviewInput,
) -> Result<bool, String> {
    review(&pool(instances).await?, input).await
}

#[tauri::command]
pub async fn preparation_extraction_initialize(
    instances: State<'_, DbInstances>,
) -> Result<(), String> {
    bootstrap(&pool(instances).await?).await
}

async fn bootstrap(pool: &SqlitePool) -> Result<(), String> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
    let result: Result<(), String> = async {
        let current = sqlx::query("SELECT m.id AS material_id, r.id AS revision_id
            FROM preparation_materials m JOIN preparation_workspaces w ON w.id=m.workspace_id
            JOIN preparation_material_revisions r ON r.id IN (m.selected_revision_id,m.candidate_revision_id)
            WHERE r.material_id=m.id AND m.status<>'deleted' AND m.deleted_at IS NULL AND w.status='active'
              AND r.output_hash IS NULL AND r.extraction_status IN ('ready','needs-review','unsupported')
            ORDER BY m.id,r.id")
            .fetch_all(&mut *tx).await.map_err(error)?;
        for row in current {
            checkpoint_in(&mut tx, row.get("material_id"), row.get("revision_id")).await?;
        }
        Ok(())
    }.await;
    match result {
        Ok(()) => tx.commit().await.map_err(error),
        Err(err) => {
            tx.rollback().await.map_err(error)?;
            Err(err)
        }
    }
}

// Bootstrap attests surviving CURRENT content, never an old Snapshot pin or transform.
async fn checkpoint_in(
    conn: &mut SqliteConnection,
    material_id: &str,
    revision_id: &str,
) -> Result<Option<String>, String> {
    let row = sqlx::query("SELECT r.extraction_metadata, r.extraction_request_id FROM preparation_material_revisions r JOIN preparation_materials m ON m.id=r.material_id JOIN preparation_workspaces w ON w.id=m.workspace_id WHERE r.id=? AND r.material_id=? AND r.id IN (m.selected_revision_id,m.candidate_revision_id) AND r.output_hash IS NULL AND r.extraction_status IN ('ready','needs-review','unsupported') AND m.status<>'deleted' AND m.deleted_at IS NULL AND w.status='active'")
        .bind(revision_id).bind(material_id).fetch_optional(&mut *conn).await.map_err(error)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let request: Option<String> = row.get("extraction_request_id");
    let rows = sqlx::query("SELECT * FROM preparation_material_chunks WHERE material_revision_id=? AND extraction_request_id=? ORDER BY ordinal")
        .bind(revision_id).bind(&request).fetch_all(&mut *conn).await.map_err(error)?;
    if rows.is_empty() {
        return Ok(None);
    }
    let chunks: Vec<Chunk> = rows
        .iter()
        .map(|r| Chunk {
            id: r.get("id"),
            workspace_id: r.get("workspace_id"),
            material_id: r.get("material_id"),
            material_revision_id: r.get("material_revision_id"),
            extraction_request_id: r.get("extraction_request_id"),
            ordinal: r.get("ordinal"),
            content: r.get("content"),
            search_text: r.get("search_text"),
            page: r.get("page"),
            section: r.get("section"),
            source_method: r.get("source_method"),
            confidence: r.get("confidence"),
            start_offset: r.get("start_offset"),
            end_offset: r.get("end_offset"),
            created_at: r.get("created_at"),
        })
        .collect();
    let raw: Option<String> = row.get("extraction_metadata");
    let metadata: Value = raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    if chunks
        .iter()
        .enumerate()
        .any(|(i, c)| c.ordinal != i as i64)
        || metadata["chunkCount"]
            .as_u64()
            .is_some_and(|count| count != chunks.len() as u64)
    {
        return Ok(None);
    }
    let hash = output_hash(&metadata, &chunks);
    sqlx::query("UPDATE preparation_material_revisions SET output_hash=? WHERE id=? AND output_hash IS NULL")
        .bind(&hash).bind(revision_id).execute(&mut *conn).await.map_err(error)?;
    Ok(Some(hash))
}

async fn claim(pool: &SqlitePool, input: ClaimInput) -> Result<Option<String>, String> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
    let result = claim_in(&mut tx, &input).await;
    match result {
        Ok(Some(id)) => {
            tx.commit().await.map_err(error)?;
            Ok(Some(id))
        }
        Ok(None) => {
            tx.rollback().await.map_err(error)?;
            Ok(None)
        }
        Err(err) => {
            tx.rollback().await.map_err(error)?;
            Err(err)
        }
    }
}

async fn claim_in(
    conn: &mut SqliteConnection,
    input: &ClaimInput,
) -> Result<Option<String>, String> {
    let base = sqlx::query(
        "SELECT r.*, m.selected_revision_id, m.scope_kind, m.scope_id
         FROM preparation_material_revisions r JOIN preparation_materials m ON m.id = r.material_id
         JOIN preparation_workspaces w ON w.id = m.workspace_id
         WHERE r.id = ? AND r.material_id = ? AND m.workspace_id = ?
           AND m.candidate_revision_id = r.id AND m.checksum_sha256 = r.source_checksum_sha256
           AND r.source_checksum_sha256 = ? AND w.status = 'active'
           AND m.status <> 'deleted' AND m.deleted_at IS NULL",
    )
    .bind(&input.revision_id)
    .bind(&input.material_id)
    .bind(&input.workspace_id)
    .bind(&input.source_checksum_sha256)
    .fetch_optional(&mut *conn)
    .await
    .map_err(error)?;
    let Some(base) = base else { return Ok(None) };
    let status: String = base.get("extraction_status");
    let started: Option<i64> = base.get("extraction_started_at");
    if input.derived.is_none()
        && !input.force
        && status != "pending"
        && status != "failed"
        && !(status == "extracting" && started.unwrap_or(0) <= input.stale_before)
    {
        return Ok(None);
    }
    let request: Option<String> = base.get("extraction_request_id");
    let reuse_pending = input.derived.is_none() && status == "pending" && request.is_none();
    let revision_id = if reuse_pending {
        &input.revision_id
    } else {
        &input.new_revision_id
    };
    let selected: Option<String> = base.get("selected_revision_id");
    let scope_kind: String = base.get("scope_kind");
    let scope_id: Option<String> = base.get("scope_id");
    let metadata = json!({"publicationBaseRevisionId": selected, "sourceScopeKind": scope_kind, "sourceScopeId": scope_id});
    if let Some(derived) = &input.derived {
        if !["needs-review", "approved"].contains(&derived.review_status.as_str())
            || !["model", "user"].contains(&derived.review_actor.as_str())
            || !["recovery-created", "manual-content-created"].contains(&derived.action.as_str())
            || (derived.review_status == "approved" && derived.review_actor != "user")
        {
            return Err("Invalid derived extraction review authority.".into());
        }
    }
    if reuse_pending {
        sqlx::query("UPDATE preparation_material_revisions SET extraction_status = 'extracting', extraction_request_id = ?, extraction_started_at = ?, extraction_metadata = ? WHERE id = ?")
            .bind(&input.request_id).bind(input.started_at).bind(metadata.to_string()).bind(revision_id)
            .execute(&mut *conn).await.map_err(error)?;
    } else {
        sqlx::query("INSERT INTO preparation_material_revisions
            (id, material_id, revision, source_checksum_sha256, extraction_status, extraction_request_id,
             extraction_started_at, extraction_metadata, derived_from_revision_id, created_at)
            SELECT ?, ?, COALESCE(MAX(revision), 0) + 1, ?, 'extracting', ?, ?, ?, ?, ?
            FROM preparation_material_revisions WHERE material_id = ?")
            .bind(revision_id).bind(&input.material_id).bind(&input.source_checksum_sha256)
            .bind(&input.request_id).bind(input.started_at).bind(metadata.to_string())
            .bind(input.derived.as_ref().map(|_| &input.revision_id)).bind(input.started_at)
            .bind(&input.material_id).execute(&mut *conn).await.map_err(error)?;
    }
    if let Some(derived) = &input.derived {
        sqlx::query("UPDATE preparation_material_revisions SET review_status = ?, review_actor = ?, review_updated_at = ?, quality_signals_json = ? WHERE id = ?")
            .bind(&derived.review_status).bind(&derived.review_actor).bind(input.started_at)
            .bind(derived.quality_signals.to_string()).bind(revision_id).execute(&mut *conn).await.map_err(error)?;
        sqlx::query("INSERT INTO preparation_material_review_events (id, workspace_id, material_id, material_revision_id, action, actor, reason_codes_json, created_at) VALUES (?, ?, ?, ?, ?, ?, '[]', ?)")
            .bind(format!("{revision_id}-event")).bind(&input.workspace_id).bind(&input.material_id)
            .bind(revision_id).bind(&derived.action).bind(&derived.review_actor).bind(input.started_at)
            .execute(&mut *conn).await.map_err(error)?;
    }
    sqlx::query("UPDATE preparation_materials SET candidate_revision_id = ?, status = CASE WHEN selected_revision_id IS NULL THEN 'extracting' ELSE status END, updated_at = ? WHERE id = ?")
        .bind(revision_id).bind(input.started_at).bind(&input.material_id).execute(&mut *conn).await.map_err(error)?;
    Ok(Some(revision_id.clone()))
}

fn output_hash(metadata: &Value, chunks: &[Chunk]) -> String {
    // Exclude request IDs, timestamps and mutable review/publication metadata.
    let content: Vec<Value> = chunks
        .iter()
        .map(|c| {
            json!({
                "ordinal": c.ordinal, "content": c.content, "searchText": c.search_text,
                "page": c.page, "section": c.section, "sourceMethod": c.source_method,
                "confidence": c.confidence, "startOffset": c.start_offset, "endOffset": c.end_offset
            })
        })
        .collect();
    let mut output_metadata = metadata.clone();
    if let Some(fields) = output_metadata.as_object_mut() {
        for field in [
            "durationMs",
            "publicationBaseRevisionId",
            "sourceScopeKind",
            "sourceScopeId",
            "transformHash",
        ] {
            fields.remove(field);
        }
        fields.entry("transform").or_insert(Value::Null);
    }
    let value =
        json!({"version": "preparation-output-v1", "metadata": output_metadata, "chunks": content});
    digest(&value)
}

fn digest(value: &Value) -> String {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(fields) => {
                let ordered: std::collections::BTreeMap<_, _> = fields.iter().collect();
                Value::Object(
                    ordered
                        .into_iter()
                        .map(|(key, value)| (key.clone(), canonical(value)))
                        .collect(),
                )
            }
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            _ => value.clone(),
        }
    }
    format!(
        "{:x}",
        Sha256::digest(canonical(value).to_string().as_bytes())
    )
}

async fn complete(pool: &SqlitePool, input: CompleteInput) -> Result<bool, String> {
    if !["ready", "needs-review", "unsupported"].contains(&input.status.as_str())
        || !input.metadata.is_object()
        || input.chunks.len() > 2000
    {
        return Err("Invalid extraction completion.".into());
    }
    for (ordinal, chunk) in input.chunks.iter().enumerate() {
        if chunk.ordinal != ordinal as i64
            || chunk.workspace_id != input.workspace_id
            || chunk.material_id != input.material_id
            || chunk.material_revision_id != input.revision_id
            || chunk.extraction_request_id != input.request_id
            || chunk.content.is_empty()
        {
            return Err("Extraction chunk identity or ordinal does not match its owner.".into());
        }
    }
    let hash = output_hash(&input.metadata, &input.chunks);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
    let result = complete_in(&mut tx, &input, &hash).await;
    match result {
        Ok(true) => {
            tx.commit().await.map_err(error)?;
            Ok(true)
        }
        Ok(false) => {
            tx.rollback().await.map_err(error)?;
            Ok(false)
        }
        Err(err) => {
            tx.rollback().await.map_err(error)?;
            Err(err)
        }
    }
}

async fn complete_in(
    conn: &mut SqliteConnection,
    input: &CompleteInput,
    hash: &str,
) -> Result<bool, String> {
    let row = sqlx::query("SELECT r.extraction_metadata, r.review_status, r.review_actor, r.derived_from_revision_id FROM preparation_material_revisions r
        JOIN preparation_materials m ON m.id = r.material_id JOIN preparation_workspaces w ON w.id = m.workspace_id
        WHERE r.id = ? AND r.material_id = ? AND m.workspace_id = ? AND r.extraction_request_id = ?
          AND r.extraction_status = 'extracting' AND m.candidate_revision_id = r.id
          AND m.selected_revision_id IS json_extract(r.extraction_metadata, '$.publicationBaseRevisionId')
          AND m.scope_kind = json_extract(r.extraction_metadata, '$.sourceScopeKind')
          AND m.scope_id IS json_extract(r.extraction_metadata, '$.sourceScopeId')
          AND m.checksum_sha256 = r.source_checksum_sha256 AND w.status = 'active'
          AND m.status <> 'deleted' AND m.deleted_at IS NULL")
        .bind(&input.revision_id).bind(&input.material_id).bind(&input.workspace_id).bind(&input.request_id)
        .fetch_optional(&mut *conn).await.map_err(error)?;
    let Some(row) = row else {
        // A retried acknowledgement must never delete an already completed file.
        return sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM preparation_material_revisions WHERE id=? AND material_id=? AND extraction_request_id=? AND output_hash=? AND extraction_status IN ('ready','needs-review','unsupported'))")
            .bind(&input.revision_id).bind(&input.material_id).bind(&input.request_id)
            .bind(hash).fetch_one(&mut *conn).await.map_err(error);
    };
    if input.review_status == "approved"
        && (row
            .get::<Option<String>, _>("derived_from_revision_id")
            .is_none()
            || row.get::<String, _>("review_status") != "approved"
            || row.get::<Option<String>, _>("review_actor").as_deref() != Some("user")
            || input.review_actor != "user")
    {
        return Err("Completion cannot grant review authority.".into());
    }
    let claim: Value =
        serde_json::from_str(row.get::<&str, _>("extraction_metadata")).map_err(error)?;
    let mut metadata = input.metadata.clone();
    for field in [
        "publicationBaseRevisionId",
        "sourceScopeKind",
        "sourceScopeId",
    ] {
        metadata[field] = claim[field].clone();
    }
    if metadata.get("transform").is_none() {
        metadata["transform"] = Value::Null;
    }
    metadata["transformHash"] = if metadata["transform"].is_null() {
        Value::Null
    } else {
        json!(digest(&metadata["transform"]))
    };
    for chunk in &input.chunks {
        sqlx::query("INSERT INTO preparation_material_chunks (id, workspace_id, material_id, material_revision_id, extraction_request_id, ordinal, content, search_text, page, section, source_method, confidence, start_offset, end_offset, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&chunk.id).bind(&chunk.workspace_id).bind(&chunk.material_id).bind(&chunk.material_revision_id)
            .bind(&chunk.extraction_request_id).bind(chunk.ordinal).bind(&chunk.content).bind(&chunk.search_text)
            .bind(chunk.page).bind(&chunk.section).bind(&chunk.source_method).bind(chunk.confidence)
            .bind(chunk.start_offset).bind(chunk.end_offset).bind(chunk.created_at).execute(&mut *conn).await.map_err(error)?;
    }
    sqlx::query("UPDATE preparation_material_revisions SET extraction_status = ?, extracted_text_relative_path = ?, extraction_metadata = ?, output_hash = ?, review_status = ?, review_actor = ?, review_updated_at = ?, quality_signals_json = ?, completed_at = ? WHERE id = ?")
        .bind(&input.status).bind(&input.extracted_text_relative_path).bind(metadata.to_string()).bind(hash)
        .bind(&input.review_status).bind(&input.review_actor).bind(input.completed_at)
        .bind(input.quality_signals.to_string()).bind(input.completed_at).bind(&input.revision_id)
        .execute(&mut *conn).await.map_err(error)?;
    let eligible = (input.status == "ready" && input.review_status != "needs-review")
        || (input.status == "needs-review" && input.review_status == "approved");
    sqlx::query("UPDATE preparation_materials SET selected_revision_id = CASE WHEN ? THEN ? ELSE selected_revision_id END, status = CASE WHEN ? THEN 'ready' WHEN selected_revision_id IS NULL THEN ? ELSE status END, updated_at = ? WHERE id = ?")
        .bind(eligible).bind(&input.revision_id).bind(eligible).bind(&input.status).bind(input.completed_at)
        .bind(&input.material_id).execute(&mut *conn).await.map_err(error)?;
    Ok(true)
}

async fn fail(pool: &SqlitePool, input: FailInput) -> Result<bool, String> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
    let result: Result<bool, sqlx::Error> = async {
        let changed = sqlx::query("UPDATE preparation_material_revisions SET extraction_status = 'failed', extraction_metadata = ?, completed_at = ? WHERE id = ? AND material_id = ? AND extraction_request_id = ? AND extraction_status = 'extracting' AND EXISTS (SELECT 1 FROM preparation_materials WHERE id = ? AND workspace_id = ?)")
            .bind(input.metadata.to_string()).bind(input.completed_at).bind(&input.revision_id)
            .bind(&input.material_id).bind(&input.request_id).bind(&input.material_id).bind(&input.workspace_id)
            .execute(&mut *tx).await?.rows_affected() > 0;
        if changed {
            sqlx::query("DELETE FROM preparation_material_chunks WHERE material_revision_id = ? AND extraction_request_id = ?")
                .bind(&input.revision_id).bind(&input.request_id).execute(&mut *tx).await?;
            sqlx::query("UPDATE preparation_materials SET status = 'failed', updated_at = ? WHERE id = ? AND candidate_revision_id = ? AND selected_revision_id IS NULL AND status <> 'deleted' AND deleted_at IS NULL")
                .bind(input.completed_at).bind(&input.material_id).bind(&input.revision_id).execute(&mut *tx).await?;
        }
        Ok(changed)
    }.await;
    match result {
        Ok(changed) => {
            tx.commit().await.map_err(error)?;
            Ok(changed)
        }
        Err(err) => {
            tx.rollback().await.map_err(error)?;
            Err(error(err))
        }
    }
}

async fn review(pool: &SqlitePool, input: ReviewInput) -> Result<bool, String> {
    if !["approved", "needs-review"].contains(&input.review_status.as_str())
        || (input.review_status == "approved"
            && (input.actor != "user" || input.action != "approved"))
    {
        return Err("Invalid extraction review authority.".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
    let result: Result<bool, sqlx::Error> = async {
        let changed = sqlx::query("UPDATE preparation_material_revisions AS r
            SET review_status = ?, review_actor = ?, review_updated_at = ?, quality_signals_json = ?
            WHERE r.id = ? AND r.material_id = ? AND r.extraction_request_id IS ?
              AND r.extraction_status IN ('ready', 'needs-review')
              AND (SELECT id FROM preparation_material_review_events WHERE material_revision_id = r.id ORDER BY rowid DESC LIMIT 1) IS ?
              AND EXISTS (SELECT 1 FROM preparation_materials m JOIN preparation_workspaces w ON w.id = m.workspace_id
                WHERE m.id = r.material_id AND m.workspace_id = ? AND w.status = 'active'
                  AND m.status <> 'deleted' AND m.deleted_at IS NULL
                  AND (m.candidate_revision_id = r.id OR (? = 'needs-review' AND m.selected_revision_id = r.id))
                  AND (? = 'needs-review' OR m.selected_revision_id = r.id
                    OR (m.selected_revision_id IS json_extract(r.extraction_metadata, '$.publicationBaseRevisionId')
                      AND m.scope_kind = json_extract(r.extraction_metadata, '$.sourceScopeKind')
                      AND m.scope_id IS json_extract(r.extraction_metadata, '$.sourceScopeId'))))")
            .bind(&input.review_status).bind(&input.actor).bind(input.updated_at).bind(input.quality_signals.to_string())
            .bind(&input.revision_id).bind(&input.material_id).bind(&input.expected_request_id)
            .bind(&input.expected_review_event_id).bind(&input.workspace_id).bind(&input.review_status).bind(&input.review_status)
            .execute(&mut *tx).await?.rows_affected() > 0;
        if !changed { return Ok(false); }
        sqlx::query("INSERT INTO preparation_material_review_events (id, workspace_id, material_id, material_revision_id, action, actor, reason_codes_json, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&input.event_id).bind(&input.workspace_id).bind(&input.material_id).bind(&input.revision_id)
            .bind(&input.action).bind(&input.actor)
            .bind(Value::Array(input.quality_signals.as_array().into_iter().flatten().map(|v| v["code"].clone()).collect()).to_string())
            .bind(&input.detail).bind(input.updated_at).execute(&mut *tx).await?;
        sqlx::query("UPDATE preparation_materials SET selected_revision_id = CASE WHEN ? = 'approved' THEN ? ELSE selected_revision_id END, status = CASE WHEN ? = 'approved' THEN 'ready' WHEN selected_revision_id = ? OR selected_revision_id IS NULL THEN 'needs-review' ELSE status END, updated_at = ? WHERE id = ?")
            .bind(&input.review_status).bind(&input.revision_id).bind(&input.review_status).bind(&input.revision_id)
            .bind(input.updated_at).bind(&input.material_id).execute(&mut *tx).await?;
        Ok(true)
    }.await;
    match result {
        Ok(true) => {
            tx.commit().await.map_err(error)?;
            Ok(true)
        }
        Ok(false) => {
            tx.rollback().await.map_err(error)?;
            Ok(false)
        }
        Err(err) => {
            tx.rollback().await.map_err(error)?;
            Err(error(err))
        }
    }
}

fn error(err: impl std::fmt::Display) -> String {
    err.to_string()
}

#[cfg(test)]
#[path = "preparation_extraction_review_tests.rs"]
mod review_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Executor;

    async fn database(legacy: bool) -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for migration in crate::db::migrations()
            .into_iter()
            .filter(|m| m.version < 19)
        {
            pool.execute(migration.sql).await.unwrap();
        }
        pool.execute("INSERT INTO preparation_workspaces VALUES ('w','interview','Test','active',1,1,NULL);
          INSERT INTO preparation_materials (id,workspace_id,scope_kind,display_name,original_file_name,mime_type,extension,size_bytes,checksum_sha256,storage_relative_path,status,created_at,updated_at)
          VALUES ('m','w','workspace','Test','test.pdf','application/pdf','pdf',1,'checksum','materials/m/original.pdf','received',1,1);
          INSERT INTO preparation_material_revisions (id,material_id,revision,source_checksum_sha256,extraction_status,created_at)
          VALUES ('a','m',1,'checksum','pending',1);").await.unwrap();
        if legacy {
            pool.execute("UPDATE preparation_material_revisions SET extraction_status='ready',extraction_request_id='old',review_status='approved',extraction_metadata='{\"method\":\"pdf-text\"}' WHERE id='a';
              INSERT INTO preparation_material_chunks (id,workspace_id,material_id,material_revision_id,extraction_request_id,ordinal,content,search_text,created_at) VALUES ('old-c','w','m','a','old',0,'old text','old text',1);
              UPDATE preparation_materials SET status='ready' WHERE id='m';").await.unwrap();
        }
        pool.execute(include_str!(
            "migrations/preparation-immutable-extraction-revisions.sql"
        ))
        .await
        .unwrap();
        pool
    }

    fn request(base: &str, next: &str) -> ClaimInput {
        ClaimInput {
            workspace_id: "w".into(),
            material_id: "m".into(),
            revision_id: base.into(),
            new_revision_id: next.into(),
            source_checksum_sha256: "checksum".into(),
            request_id: format!("request-{next}"),
            started_at: 2,
            stale_before: 0,
            force: true,
            derived: None,
        }
    }
    fn result(id: &str, request: &str, text: &str) -> CompleteInput {
        CompleteInput {
            workspace_id: "w".into(),
            material_id: "m".into(),
            revision_id: id.into(),
            request_id: request.into(),
            status: "ready".into(),
            extracted_text_relative_path: Some(format!(
                "materials/m/extraction/{id}/{request}.txt"
            )),
            metadata: json!({"method":"pdf-text", "transform":{"parser":"test-v1"}}),
            review_status: "unreviewed".into(),
            review_actor: "runtime".into(),
            quality_signals: json!([]),
            completed_at: 3,
            chunks: vec![Chunk {
                id: format!("chunk-{id}"),
                workspace_id: "w".into(),
                material_id: "m".into(),
                material_revision_id: id.into(),
                extraction_request_id: request.into(),
                ordinal: 0,
                content: text.into(),
                search_text: text.into(),
                page: Some(1),
                section: None,
                source_method: "pdf-text".into(),
                confidence: None,
                start_offset: Some(0),
                end_offset: Some(text.len() as i64),
                created_at: 3,
            }],
        }
    }
    async fn selected(pool: &SqlitePool) -> String {
        sqlx::query_scalar("SELECT selected_revision_id FROM preparation_materials WHERE id='m'")
            .fetch_one(pool)
            .await
            .unwrap()
    }
    async fn ready_a(pool: &SqlitePool) {
        assert_eq!(
            claim(pool, request("a", "a-request"))
                .await
                .unwrap()
                .as_deref(),
            Some("a")
        );
        assert!(complete(pool, result("a", "request-a-request", "A"))
            .await
            .unwrap());
    }
    fn review_request(id: &str, request: &str, event: &str) -> ReviewInput {
        ReviewInput {
            workspace_id: "w".into(),
            material_id: "m".into(),
            revision_id: id.into(),
            expected_request_id: Some(request.into()),
            expected_review_event_id: None,
            review_status: "approved".into(),
            actor: "user".into(),
            quality_signals: json!([]),
            event_id: event.into(),
            action: "approved".into(),
            detail: None,
            updated_at: 4,
        }
    }

    #[tokio::test]
    async fn task164_failed_candidate_preserves_selected_and_rolls_back_all_chunks() {
        let pool = database(false).await;
        ready_a(&pool).await;
        assert_eq!(
            claim(&pool, request("a", "b")).await.unwrap().as_deref(),
            Some("b")
        );
        pool.execute("CREATE TRIGGER fail_chunk BEFORE INSERT ON preparation_material_chunks WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'injected chunk failure'); END;").await.unwrap();
        let mut b = result("b", "request-b", "B");
        let mut second = b.chunks[0].clone();
        second.ordinal = 1;
        second.id = "chunk-b-2".into();
        b.chunks.push(second);
        assert!(complete(&pool, b).await.unwrap_err().contains("injected"));
        assert_eq!(selected(&pool).await, "a");
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM preparation_material_chunks WHERE material_revision_id='b'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        assert!(fail(
            &pool,
            FailInput {
                workspace_id: "w".into(),
                material_id: "m".into(),
                revision_id: "b".into(),
                request_id: "request-b".into(),
                metadata: json!({"error":"test"}),
                completed_at: 5
            }
        )
        .await
        .unwrap());
        assert_eq!(selected(&pool).await, "a");
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT content FROM preparation_material_chunks WHERE material_revision_id='a'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "A"
        );
    }

    #[tokio::test]
    async fn task164_new_output_preserves_exact_old_revision_and_rejects_mutations() {
        let pool = database(false).await;
        ready_a(&pool).await;
        let hash: String = sqlx::query_scalar(
            "SELECT output_hash FROM preparation_material_revisions WHERE id='a'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        claim(&pool, request("a", "b")).await.unwrap();
        assert!(complete(&pool, result("b", "request-b", "B"))
            .await
            .unwrap());
        assert_eq!(selected(&pool).await, "b");
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT output_hash FROM preparation_material_revisions WHERE id='a'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            hash
        );
        assert!(pool.execute("UPDATE preparation_material_revisions SET extraction_status='extracting' WHERE id='a'").await.is_err());
        assert!(pool
            .execute("DELETE FROM preparation_material_chunks WHERE material_revision_id='a'")
            .await
            .is_err());
        assert!(pool.execute("UPDATE preparation_material_chunks SET content='changed' WHERE material_revision_id='a'").await.is_err());
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

    #[tokio::test]
    async fn task164_out_of_order_and_review_cas_preserve_the_new_owner() {
        let pool = database(false).await;
        ready_a(&pool).await;
        claim(&pool, request("a", "b")).await.unwrap();
        claim(&pool, request("b", "c")).await.unwrap();
        assert!(!complete(&pool, result("b", "request-b", "late B"))
            .await
            .unwrap());
        let mut c = result("c", "request-c", "C");
        c.review_status = "needs-review".into();
        assert!(complete(&pool, c).await.unwrap());
        assert_eq!(selected(&pool).await, "a");
        assert!(review(&pool, review_request("c", "request-c", "approve-c"))
            .await
            .unwrap());
        assert_eq!(selected(&pool).await, "c");
        assert!(!review(&pool, review_request("c", "request-c", "stale-c"))
            .await
            .unwrap());
        let mut revoke = review_request("c", "request-c", "revoke-c");
        revoke.expected_review_event_id = Some("approve-c".into());
        revoke.review_status = "needs-review".into();
        revoke.action = "quality-flagged".into();
        assert!(review(&pool, revoke).await.unwrap());
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT review_status FROM preparation_material_revisions WHERE id='c'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "needs-review"
        );
        assert_eq!(selected(&pool).await, "c");
    }

    #[tokio::test]
    async fn task164_scope_change_and_incomplete_approval_cannot_publish() {
        let pool = database(false).await;
        ready_a(&pool).await;
        claim(&pool, request("a", "b")).await.unwrap();
        assert!(!review(&pool, review_request("b", "request-b", "early"))
            .await
            .unwrap());
        pool.execute(
            "UPDATE preparation_materials SET scope_kind='round',scope_id='other' WHERE id='m'",
        )
        .await
        .unwrap();
        assert!(!complete(&pool, result("b", "request-b", "B"))
            .await
            .unwrap());
        assert_eq!(selected(&pool).await, "a");
    }

    #[tokio::test]
    async fn task164_claim_failure_is_atomic() {
        let pool = database(false).await;
        ready_a(&pool).await;
        pool.execute("CREATE TRIGGER fail_claim BEFORE UPDATE OF candidate_revision_id ON preparation_materials BEGIN SELECT RAISE(ABORT,'injected claim failure'); END;").await.unwrap();
        assert!(claim(&pool, request("a", "b")).await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM preparation_material_revisions")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
        assert_eq!(selected(&pool).await, "a");
    }

    #[tokio::test]
    async fn task164_legacy_migration_keeps_content_review_and_unknown_hashes() {
        let pool = database(true).await;
        assert_eq!(selected(&pool).await, "a");
        let row=sqlx::query("SELECT output_hash,review_status,extraction_request_id FROM preparation_material_revisions WHERE id='a'").fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<Option<String>, _>("output_hash"), None);
        assert_eq!(row.get::<String, _>("review_status"), "approved");
        assert_eq!(row.get::<String, _>("extraction_request_id"), "old");
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT content FROM preparation_material_chunks WHERE id='old-c'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "old text"
        );
        assert!(pool
            .fetch_all("PRAGMA foreign_key_check")
            .await
            .unwrap()
            .is_empty());
        bootstrap(&pool).await.unwrap();
        assert!(sqlx::query_scalar::<_, Option<String>>(
            "SELECT output_hash FROM preparation_material_revisions WHERE id='a'"
        )
        .fetch_one(&pool)
        .await
        .unwrap()
        .is_some());
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT extraction_metadata FROM preparation_material_revisions WHERE id='a'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "{\"method\":\"pdf-text\"}"
        );
    }

    async fn stage_snapshot(pool: &SqlitePool, hash: Option<&str>) {
        pool.execute("INSERT INTO interview_processes (id,workspace_id,created_at,updated_at) VALUES ('p','w',1,1);
          INSERT INTO interview_rounds (id,process_id,title,stage,expected_interview_types,expected_type_policy,created_at,updated_at) VALUES ('round','p','Round','coding','[]','advisory',1,1);
          INSERT INTO interview_preparation_profile_revisions (id,process_id,scope_key,round_id,revision,source_fingerprint,content_hash,content_json,confirmed_statement_ids_json,unresolved_statement_ids_json,build_status,created_at)
          VALUES ('profile','p','round','round',1,'fingerprint','profile-hash','{}','[]','[]','committed',1);").await.unwrap();
        let manifest = json!({"materials":[{"materialId":"m","materialRevisionId":"a","sourceChecksumSha256":"checksum","outputHash":hash}]});
        sqlx::query("INSERT INTO interview_preparation_snapshots (id,process_id,round_id,version,profile_revision_id,profile_revision,compiler_version,playbook_registry_version,runtime_capability_version,source_fingerprint,content_hash,runtime_char_count,snapshot_json,source_manifest_json,warnings_json,status,build_status,created_at) VALUES ('snapshot','p','round',1,'profile',1,'compiler','playbook','capability','fingerprint','snapshot-hash',0,'{\"frozen\":\"A\"}',?,'[]','ready','staging',1)")
            .bind(manifest.to_string()).execute(pool).await.unwrap();
        sqlx::query("INSERT INTO preparation_snapshot_material_revision_links (snapshot_id,material_id,material_revision_id,source_checksum_sha256,output_hash,ordinal) VALUES ('snapshot','m','a','checksum',?,0)")
            .bind(hash).execute(pool).await.unwrap();
    }

    #[tokio::test]
    async fn task164_snapshot_final_boundary_retains_exact_pin_and_rejects_race() {
        let pool = database(false).await;
        ready_a(&pool).await;
        let hash: String = sqlx::query_scalar(
            "SELECT output_hash FROM preparation_material_revisions WHERE id='a'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        stage_snapshot(&pool, Some(&hash)).await;
        pool.execute("UPDATE interview_preparation_snapshots SET build_status='committed' WHERE id='snapshot'").await.unwrap();
        claim(&pool, request("a", "b")).await.unwrap();
        assert!(complete(&pool, result("b", "request-b", "B"))
            .await
            .unwrap());
        assert!(pool.execute("UPDATE interview_preparation_current_context SET process_id='p',round_id='round',selected_snapshot_id='snapshot',revision=1 WHERE singleton_id=1").await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT revision FROM interview_preparation_current_context"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            0
        );
        assert_eq!(sqlx::query_scalar::<_,String>("SELECT c.content FROM preparation_snapshot_material_revision_links pin JOIN preparation_material_revisions r ON r.id=pin.material_revision_id AND r.output_hash=pin.output_hash JOIN preparation_material_chunks c ON c.material_revision_id=r.id AND c.extraction_request_id=r.extraction_request_id WHERE pin.snapshot_id='snapshot'").fetch_one(&pool).await.unwrap(),"A");
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT snapshot_json FROM interview_preparation_snapshots"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            "{\"frozen\":\"A\"}"
        );
        assert!(pool.execute("DELETE FROM preparation_snapshot_material_revision_links WHERE snapshot_id='snapshot'").await.is_err());
    }

    #[tokio::test]
    async fn task164_snapshot_compile_checks_last_boundary_and_legacy_pins_stay_unknown() {
        let pool = database(true).await;
        stage_snapshot(&pool, None).await;
        bootstrap(&pool).await.unwrap();
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
            .execute("UPDATE interview_preparation_snapshots SET build_status='committed'")
            .await
            .is_err());
        let hash: String = sqlx::query_scalar(
            "SELECT output_hash FROM preparation_material_revisions WHERE id='a'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        // A wrong hash cannot pass even when the logical revision and source match.
        pool.execute("UPDATE preparation_snapshot_material_revision_links SET output_hash='wrong'")
            .await
            .unwrap();
        assert!(!hash.is_empty());
        assert!(pool
            .execute("UPDATE interview_preparation_snapshots SET build_status='committed'")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn task164_retry_ack_and_revoked_idempotent_activation_are_safe() {
        let pool = database(false).await;
        ready_a(&pool).await;
        assert!(complete(&pool, result("a", "request-a-request", "A"))
            .await
            .unwrap());
        let hash: String = sqlx::query_scalar(
            "SELECT output_hash FROM preparation_material_revisions WHERE id='a'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        stage_snapshot(&pool, Some(&hash)).await;
        pool.execute("UPDATE interview_preparation_snapshots SET build_status='committed';
            UPDATE interview_preparation_current_context SET process_id='p',round_id='round',selected_snapshot_id='snapshot',revision=1 WHERE singleton_id=1;").await.unwrap();
        let mut revoke = review_request("a", "request-a-request", "revoked");
        revoke.review_status = "needs-review".into();
        revoke.action = "quality-flagged".into();
        assert!(review(&pool, revoke).await.unwrap());
        assert!(pool.execute("UPDATE interview_preparation_current_context SET selected_snapshot_id='snapshot' WHERE singleton_id=1").await.is_err());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT revision FROM interview_preparation_current_context"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            1
        );
    }

    #[test]
    fn task164_output_hash_ignores_execution_identity_but_tracks_transform() {
        let a = result("a", "ra", "same");
        let b = result("b", "rb", "same");
        assert_eq!(
            output_hash(&a.metadata, &a.chunks),
            output_hash(&b.metadata, &b.chunks)
        );
        assert_ne!(
            output_hash(&a.metadata, &a.chunks),
            output_hash(
                &json!({"method":"pdf-text","transform":{"parser":"test-v2"}}),
                &a.chunks
            )
        );
    }
}
