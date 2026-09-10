use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{SqliteConnection, SqlitePool, Transaction};
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInput {
    source_id: String,
    events: Vec<Value>,
    projections: Vec<Value>,
    report: Value,
}

#[derive(Deserialize)]
pub struct AppendInput {
    event: Value,
    projection: Value,
}

#[derive(Debug, Serialize)]
pub struct AppendResult {
    event: Value,
    projection: Value,
}

#[derive(Debug, Serialize)]
pub struct ReadResult {
    events: Vec<Value>,
    projections: Vec<Value>,
}

async fn pool(instances: State<'_, DbInstances>) -> Result<SqlitePool, String> {
    match instances.0.read().await.get("sqlite:jarvis.db") {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err("Human evaluation database is not loaded.".into()),
    }
}

#[tauri::command]
pub async fn evaluation_store_import_status(
    instances: State<'_, DbInstances>,
    source_id: String,
) -> Result<Option<Value>, String> {
    let payload: Option<String> =
        sqlx::query_scalar("SELECT receipt FROM human_evaluation_imports WHERE source_id=?")
            .bind(source_id)
            .fetch_optional(&pool(instances).await?)
            .await
            .map_err(error)?;
    payload
        .map(|value| serde_json::from_str(&value).map_err(error))
        .transpose()
}

#[tauri::command]
pub async fn evaluation_store_import(
    instances: State<'_, DbInstances>,
    input: ImportInput,
) -> Result<Value, String> {
    import(&pool(instances).await?, input).await
}

#[tauri::command]
pub async fn evaluation_store_append(
    instances: State<'_, DbInstances>,
    input: AppendInput,
) -> Result<AppendResult, String> {
    append(&pool(instances).await?, input).await
}

#[tauri::command]
pub async fn evaluation_store_read(
    instances: State<'_, DbInstances>,
    session_id: String,
) -> Result<ReadResult, String> {
    read(&pool(instances).await?, &session_id).await
}

#[tauri::command]
pub async fn evaluation_store_project(
    instances: State<'_, DbInstances>,
    projection: Value,
) -> Result<Value, String> {
    project(&pool(instances).await?, projection).await
}

fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("Human evaluation requires nonempty {key}."))
}

fn object(value: &Value, key: &str) -> Result<(), String> {
    if !value[key].is_object() {
        return Err(format!("Human evaluation requires object {key}."));
    }
    Ok(())
}

fn strings(value: &Value, key: &str) -> Result<(), String> {
    if !value[key]
        .as_array()
        .is_some_and(|items| items.iter().all(Value::is_string))
    {
        return Err(format!("Human evaluation requires string array {key}."));
    }
    Ok(())
}

fn validate(value: &Value, id: &str) -> Result<(), String> {
    if value["schemaVersion"] != 2 {
        return Err("Human evaluation requires schemaVersion 2.".into());
    }
    text(value, id)?;
    text(value, "sessionId")?;
    object(value, "subject")?;
    let subject = &value["subject"];
    for key in ["attemptId", "questionId", "momentId", "taskId"] {
        if subject.get(key).is_some() {
            text(subject, key)?;
        }
    }
    strings(subject, "traceIds")?;
    strings(subject, "sourceTurnIds")?;
    Ok(())
}

fn validate_event(event: &Value) -> Result<(), String> {
    validate(event, "eventId")?;
    object(event, "fact")?;
    text(&event["fact"], "kind")?;
    object(event, "provenance")?;
    let provenance = &event["provenance"];
    text(provenance, "source")?;
    text(provenance, "collection")?;
    if provenance["actor"] != "human"
        || !provenance["recordedAt"].is_number()
        || !matches!(
            event["confirmation"].as_str(),
            Some("confirmed" | "suggested")
        )
    {
        return Err("Human evaluation has invalid provenance or confirmation.".into());
    }
    if provenance.get("actionId").is_some() {
        text(provenance, "actionId")?;
    }
    if event.get("supersedesEventId").is_some() {
        text(event, "supersedesEventId")?;
    }
    Ok(())
}

fn validate_projection(projection: &Value) -> Result<(), String> {
    validate(projection, "projectionId")?;
    text(projection, "derivationVersion")?;
    strings(projection, "inputEventIds")?;
    object(projection, "activeFacts")?;
    object(projection, "verdicts")?;
    if !projection["computedAt"].is_number() || !projection["conflicts"].is_array() {
        return Err("Human evaluation has invalid projection structure.".into());
    }
    if projection.get("observed").is_some() {
        object(projection, "observed")?;
    }
    Ok(())
}

// Keep the precedence of human-ground-truth-v2.ts subjectsMatch, including trace fallback.
fn subjects_match(left: &Value, right: &Value) -> bool {
    let id = |value: &Value, key: &str| {
        value[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let (a, b) = (id(left, "attemptId"), id(right, "attemptId"));
    if a.is_some() || b.is_some() {
        return a.is_some() && a == b;
    }
    for key in ["questionId", "momentId"] {
        if let (Some(a), Some(b)) = (id(left, key), id(right, key)) {
            return a == b;
        }
    }
    left["traceIds"].as_array().is_some_and(|traces| {
        right["traceIds"]
            .as_array()
            .is_some_and(|other| traces.iter().any(|trace| other.contains(trace)))
    })
}

async fn finish<T>(
    tx: Transaction<'_, sqlx::Sqlite>,
    result: Result<T, String>,
) -> Result<T, String> {
    match result {
        Ok(value) => {
            tx.commit().await.map_err(error)?;
            Ok(value)
        }
        Err(err) => {
            tx.rollback().await.map_err(error)?;
            Err(err)
        }
    }
}

async fn existing_event(
    conn: &mut SqliteConnection,
    event: &Value,
) -> Result<Option<Value>, String> {
    let payload: Option<String> =
        sqlx::query_scalar("SELECT payload FROM human_evaluation_events WHERE event_id=?")
            .bind(text(event, "eventId")?)
            .fetch_optional(conn)
            .await
            .map_err(error)?;
    let saved = payload
        .map(|s| serde_json::from_str::<Value>(&s).map_err(error))
        .transpose()?;
    if saved.as_ref().is_some_and(|saved| saved != event) {
        return Err(format!(
            "Human evaluation eventId conflict: {}",
            event["eventId"]
        ));
    }
    Ok(saved)
}

async fn insert_event(conn: &mut SqliteConnection, event: &Value) -> Result<(), String> {
    sqlx::query("INSERT INTO human_evaluation_events(event_id,session_id,payload) VALUES (?,?,?)")
        .bind(text(event, "eventId")?)
        .bind(text(event, "sessionId")?)
        .bind(event.to_string())
        .execute(conn)
        .await
        .map_err(error)?;
    Ok(())
}

async fn put_projection(
    conn: &mut SqliteConnection,
    projection: &Value,
    importing: bool,
) -> Result<(), String> {
    let saved: Option<String> = sqlx::query_scalar(
        "SELECT payload FROM human_evaluation_projections WHERE projection_id=?",
    )
    .bind(text(projection, "projectionId")?)
    .fetch_optional(&mut *conn)
    .await
    .map_err(error)?;
    if let Some(saved) = saved {
        let saved: Value = serde_json::from_str(&saved).map_err(error)?;
        if saved == *projection {
            return Ok(());
        }
        if importing
            || saved["sessionId"] != projection["sessionId"]
            || !(saved["subject"] == projection["subject"]
                || subjects_match(&saved["subject"], &projection["subject"]))
        {
            return Err(format!(
                "Human evaluation projectionId conflict: {}",
                projection["projectionId"]
            ));
        }
        sqlx::query("UPDATE human_evaluation_projections SET payload=? WHERE projection_id=?")
            .bind(projection.to_string())
            .bind(text(projection, "projectionId")?)
            .execute(conn)
            .await
            .map_err(error)?;
    } else {
        sqlx::query("INSERT INTO human_evaluation_projections(projection_id,session_id,payload) VALUES (?,?,?)")
            .bind(text(projection,"projectionId")?).bind(text(projection,"sessionId")?).bind(projection.to_string())
            .execute(conn).await.map_err(error)?;
    }
    Ok(())
}

async fn import(pool: &SqlitePool, input: ImportInput) -> Result<Value, String> {
    if input.source_id.trim().is_empty() {
        return Err("Human evaluation requires sourceId.".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
    let result = async {
        let saved: Option<String> =
            sqlx::query_scalar("SELECT receipt FROM human_evaluation_imports WHERE source_id=?")
                .bind(&input.source_id)
                .fetch_optional(&mut *tx)
                .await
                .map_err(error)?;
        if let Some(saved) = saved {
            return serde_json::from_str(&saved).map_err(error);
        }
        // Imports preserve all original IDs, even historical action duplicates.
        for event in &input.events {
            validate_event(event)?;
            if existing_event(&mut tx, event).await?.is_none() {
                insert_event(&mut tx, event).await?;
            }
        }
        for projection in &input.projections {
            validate_projection(projection)?;
            put_projection(&mut tx, projection, true).await?;
        }
        let receipt = json!({"sourceId": input.source_id, "report": input.report});
        sqlx::query("INSERT INTO human_evaluation_imports(source_id,receipt) VALUES (?,?)")
            .bind(&input.source_id)
            .bind(receipt.to_string())
            .execute(&mut *tx)
            .await
            .map_err(error)?;
        Ok(receipt)
    }
    .await;
    finish(tx, result).await
}

async fn action_duplicate(
    conn: &mut SqliteConnection,
    event: &Value,
) -> Result<Option<Value>, String> {
    let Some(action) = event["provenance"]["actionId"].as_str() else {
        return Ok(None);
    };
    let candidates: Vec<String> = sqlx::query_scalar("SELECT payload FROM human_evaluation_events WHERE session_id=? AND json_extract(payload,'$.provenance.actionId')=? AND json_extract(payload,'$.fact.kind')=? ORDER BY rowid")
        .bind(text(event,"sessionId")?).bind(action).bind(text(&event["fact"],"kind")?)
        .fetch_all(conn).await.map_err(error)?;
    let mut duplicate = None;
    for payload in candidates {
        let saved: Value = serde_json::from_str(&payload).map_err(error)?;
        if !subjects_match(&saved["subject"], &event["subject"]) {
            continue;
        }
        if ["fact", "confirmation", "supersedesEventId"]
            .iter()
            .any(|key| saved[key] != event[key])
            || ["source", "actor", "collection"]
                .iter()
                .any(|key| saved["provenance"][key] != event["provenance"][key])
        {
            return Err(format!("Human evaluation actionId conflict: {action}"));
        }
        if duplicate.is_none() {
            duplicate = Some(saved);
        }
    }
    Ok(duplicate)
}

async fn saved_projection(
    conn: &mut SqliteConnection,
    event: &Value,
    projection_id: &str,
) -> Result<Option<Value>, String> {
    // A superseded event can be absent from the current projection's inputEventIds.
    let candidates: Vec<String> = sqlx::query_scalar("SELECT payload FROM human_evaluation_projections WHERE session_id=? AND (projection_id=? OR EXISTS (SELECT 1 FROM json_each(payload,'$.inputEventIds') WHERE value=?)) ORDER BY (projection_id=?) DESC, rowid DESC")
        .bind(text(event,"sessionId")?).bind(projection_id).bind(text(event,"eventId")?).bind(projection_id).fetch_all(conn).await.map_err(error)?;
    for payload in candidates {
        let projection: Value = serde_json::from_str(&payload).map_err(error)?;
        if subjects_match(&projection["subject"], &event["subject"])
            || projection["subject"] == event["subject"]
        {
            return Ok(Some(projection));
        }
    }
    Ok(None)
}

async fn append(pool: &SqlitePool, input: AppendInput) -> Result<AppendResult, String> {
    validate_event(&input.event)?;
    validate_projection(&input.projection)?;
    if input.event["sessionId"] != input.projection["sessionId"]
        || !(input.event["subject"] == input.projection["subject"]
            || subjects_match(&input.event["subject"], &input.projection["subject"]))
        || !input.projection["inputEventIds"]
            .as_array()
            .unwrap()
            .contains(&input.event["eventId"])
    {
        return Err("Human evaluation event/projection binding mismatch.".into());
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
    let result = async {
        let existing = existing_event(&mut tx,&input.event).await?;
        let duplicate = if existing.is_some() { existing } else { action_duplicate(&mut tx,&input.event).await? };
        if let Some(event) = duplicate {
            if let Some(projection) = saved_projection(&mut tx,&event,text(&input.projection,"projectionId")?).await? {
                return Ok(AppendResult { event, projection });
            }
            // A preserved import may not have a projection. Only the exact event can supply one.
            if event["eventId"] != input.event["eventId"] {
                return Err(format!("Human evaluation action duplicate {} has no saved projection; read and retry with its persisted event.",event["eventId"]));
            }
        } else {
            insert_event(&mut tx,&input.event).await?;
        }
        put_projection(&mut tx,&input.projection,false).await?;
        Ok(AppendResult {event: input.event, projection: input.projection})
    }.await;
    finish(tx, result).await
}

async fn project(pool: &SqlitePool, projection: Value) -> Result<Value, String> {
    validate_projection(&projection)?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
    // The frontend serializes refresh with append and derives from persisted session events.
    // This boundary only replaces the read model; it never writes human facts or import receipts.
    let result = put_projection(&mut tx, &projection, false)
        .await
        .map(|()| projection);
    finish(tx, result).await
}

async fn read(pool: &SqlitePool, session_id: &str) -> Result<ReadResult, String> {
    if session_id.trim().is_empty() {
        return Err("Human evaluation requires sessionId.".into());
    }
    // Both collections come from one snapshot, scoped to the requested session.
    let mut tx = pool.begin().await.map_err(error)?;
    let result = async {
        let events: Vec<String> = sqlx::query_scalar(
            "SELECT payload FROM human_evaluation_events WHERE session_id=? ORDER BY rowid",
        )
        .bind(session_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(error)?;
        let projections: Vec<String> = sqlx::query_scalar(
            "SELECT payload FROM human_evaluation_projections WHERE session_id=? ORDER BY rowid",
        )
        .bind(session_id)
        .fetch_all(&mut *tx)
        .await
        .map_err(error)?;
        Ok(ReadResult {
            events: events
                .iter()
                .map(|s| serde_json::from_str(s).map_err(error))
                .collect::<Result<_, _>>()?,
            projections: projections
                .iter()
                .map(|s| serde_json::from_str(s).map_err(error))
                .collect::<Result<_, _>>()?,
        })
    }
    .await;
    finish(tx, result).await
}

#[cfg(test)]
#[path = "human_evaluation_tests.rs"]
mod tests;
