use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection, SqlitePool};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;
use tauri::State;
use tauri_plugin_sql::{DbInstances, DbPool};

const SOURCE_FIELDS: &[&str] = &[
    "title",
    "collection",
    "source_origin",
    "source_format",
    "source_role",
    "original_path",
    "scope",
    "project_id",
    "project_name",
    "confidentiality",
    "canonicality",
    "raw_injection_policy",
    "curation_status",
    "checksum",
    "draft_path",
];
const ENTRY_FIELDS: &[&str] = &[
    "source_ids",
    "type",
    "title",
    "content",
    "summary",
    "scope",
    "project_id",
    "project_name",
    "tags",
    "keywords",
    "priority",
    "injection_mode",
    "use_cases",
    "interview_families",
    "confidentiality",
    "curation_status",
    "related_entry_ids",
    "evidence_entry_ids",
    "draft_path",
];
type Content = BTreeMap<String, Option<String>>;
type SourcePins = BTreeMap<String, Option<i64>>;

#[derive(Clone, Deserialize)]
pub struct ContentCandidate {
    id: String,
    content: Content,
    enabled: Option<bool>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishInput {
    sources: Vec<ContentCandidate>,
    entries: Vec<ContentCandidate>,
    projects: Vec<Project>,
    imported_at: i64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    id: String,
    name: String,
    scope: String,
    entry_count: i64,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    source_revisions_created: usize,
    entry_revisions_created: usize,
    revisions_reused: usize,
    retained_stale_entries: usize,
    transaction_ms: f64,
    lock_wait_ms: f64,
}
#[derive(Clone, Copy)]
enum Kind {
    Source,
    Entry,
}
impl Kind {
    fn tables(
        self,
    ) -> (
        &'static str,
        &'static str,
        &'static str,
        &'static [&'static str],
    ) {
        match self {
            Self::Source => (
                "memory_sources",
                "memory_source_revisions",
                "source_id",
                SOURCE_FIELDS,
            ),
            Self::Entry => (
                "memory_entries",
                "memory_entry_revisions",
                "entry_id",
                ENTRY_FIELDS,
            ),
        }
    }
}
struct Prepared {
    candidate: ContentCandidate,
    digest: String,
    source_ids: Vec<String>,
}
async fn pool(instances: State<'_, DbInstances>) -> Result<SqlitePool, String> {
    match instances.0.read().await.get("sqlite:jarvis.db") {
        Some(DbPool::Sqlite(pool)) => Ok(pool.clone()),
        _ => Err("KMB database is not loaded.".into()),
    }
}
#[tauri::command]
pub async fn memory_content_initialize(instances: State<'_, DbInstances>) -> Result<(), String> {
    initialize(&pool(instances).await?).await
}
#[tauri::command]
pub async fn memory_content_publish(
    instances: State<'_, DbInstances>,
    input: PublishInput,
) -> Result<Publication, String> {
    publish(&pool(instances).await?, input).await
}

fn hash(value: &Value) -> String {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(fields) => Value::Object(
                fields
                    .iter()
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .map(|(key, value)| (key.clone(), canonical(value)))
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            _ => value.clone(),
        }
    }
    format!(
        "{:x}",
        Sha256::digest(canonical(value).to_string().as_bytes())
    )
}
fn content_digest(content: &Content) -> String {
    let mut value = serde_json::to_value(content).expect("text fields serialize");
    for key in [
        "source_ids",
        "tags",
        "keywords",
        "use_cases",
        "interview_families",
        "related_entry_ids",
        "evidence_entry_ids",
    ] {
        if let Some(Some(raw)) = content.get(key) {
            if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
                value[key] = parsed;
            }
        }
    }
    hash(&value)
}
fn ids(content: &Content) -> Result<Vec<String>, String> {
    serde_json::from_str(
        content
            .get("source_ids")
            .and_then(Option::as_deref)
            .ok_or("KMB source IDs are missing.")?,
    )
    .map_err(error)
}
fn prepare(items: Vec<ContentCandidate>, kind: Kind) -> Result<Vec<Prepared>, String> {
    let (_, _, _, fields) = kind.tables();
    let mut seen = BTreeSet::new();
    items
        .into_iter()
        .map(|candidate| {
            if candidate.id.trim().is_empty()
                || !seen.insert(candidate.id.clone())
                || candidate.content.len() != fields.len()
                || fields
                    .iter()
                    .any(|field| !candidate.content.contains_key(*field))
            {
                return Err("KMB candidate has invalid identity or content fields.".into());
            }
            let source_ids = if matches!(kind, Kind::Entry) {
                ids(&candidate.content)?
            } else {
                Vec::new()
            };
            let digest = content_digest(&candidate.content);
            Ok(Prepared {
                candidate,
                digest,
                source_ids,
            })
        })
        .collect()
}
fn row_content(row: &sqlx::sqlite::SqliteRow, fields: &[&str]) -> Content {
    fields
        .iter()
        .map(|field| ((*field).to_string(), row.get::<Option<String>, _>(*field)))
        .collect()
}

async fn source_pins(
    conn: &mut SqliteConnection,
    source_ids: &[String],
    strict: bool,
) -> Result<SourcePins, String> {
    let mut pins = BTreeMap::new();
    for id in source_ids {
        let revision=sqlx::query_scalar::<_,i64>("SELECT r.revision FROM memory_sources s JOIN memory_source_revisions r ON r.source_id=s.id AND r.revision=s.current_content_revision WHERE s.id=? AND r.content_hash IS NOT NULL")
            .bind(id).fetch_optional(&mut *conn).await.map_err(error)?;
        if strict && revision.is_none() {
            return Err(format!("KMB source {id} is unavailable."));
        }
        pins.insert(id.clone(), revision);
    }
    Ok(pins)
}
async fn initialize(pool: &SqlitePool) -> Result<(), String> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
    let result:Result<(),String>=async {
        for kind in [Kind::Source,Kind::Entry] {
            let (logical,table,id,fields)=kind.tables();
            let rows=sqlx::query(&format!("SELECT r.* FROM {logical} l JOIN {table} r ON r.{id}=l.id AND r.revision=l.current_content_revision WHERE r.content_hash IS NULL ORDER BY l.id"))
                .fetch_all(&mut *tx).await.map_err(error)?;
            for row in rows {
                let content=row_content(&row,fields);
                let digest=content_digest(&content);
                let owner:String=row.get(id);
                let revision:i64=row.get("revision");
                if matches!(kind,Kind::Entry) {
                    let Ok(source_ids)=ids(&content) else { continue };
                    let pins=source_pins(&mut tx,&source_ids,false).await?;
                    let hash=hash(&json!({"content":digest,"sources":pins}));
                    sqlx::query("UPDATE memory_entry_revisions SET content_hash=?,source_revisions_json=? WHERE entry_id=? AND revision=? AND content_hash IS NULL")
                        .bind(hash).bind(serde_json::to_string(&pins).map_err(error)?).bind(owner).bind(revision)
                        .execute(&mut *tx).await.map_err(error)?;
                } else {
                    sqlx::query("UPDATE memory_source_revisions SET content_hash=? WHERE source_id=? AND revision=? AND content_hash IS NULL")
                        .bind(digest).bind(owner).bind(revision).execute(&mut *tx).await.map_err(error)?;
                }
            }
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

async fn put_revision(
    conn: &mut SqliteConnection,
    kind: Kind,
    prepared: &Prepared,
    pins: Option<&SourcePins>,
    at: i64,
) -> Result<(i64, bool), String> {
    let (logical, table, id, fields) = kind.tables();
    let digest = match pins {
        Some(pins) => hash(&json!({"content":prepared.digest,"sources":pins})),
        None => prepared.digest.clone(),
    };
    let candidate = &prepared.candidate;
    if matches!(kind, Kind::Entry) {
        sqlx::query("INSERT INTO memory_entries (id,enabled,created_at,updated_at,current_content_revision) VALUES (?,?,?,?,NULL) ON CONFLICT(id) DO NOTHING")
            .bind(&candidate.id).bind(candidate.enabled.ok_or("KMB candidate policy is missing.")?).bind(at).bind(at)
            .execute(&mut *conn).await.map_err(error)?;
    } else {
        sqlx::query("INSERT INTO memory_sources (id,created_at,updated_at,current_content_revision) VALUES (?,?,?,NULL) ON CONFLICT(id) DO NOTHING")
            .bind(&candidate.id).bind(at).bind(at).execute(&mut *conn).await.map_err(error)?;
    }
    let existing = sqlx::query_scalar::<_, i64>(&format!(
        "SELECT revision FROM {table} WHERE {id}=? AND content_hash=?"
    ))
    .bind(&candidate.id)
    .bind(&digest)
    .fetch_optional(&mut *conn)
    .await
    .map_err(error)?;
    let revision = if let Some(revision) = existing {
        revision
    } else {
        let revision = sqlx::query_scalar::<_, i64>(&format!(
            "SELECT COALESCE(MAX(revision),0)+1 FROM {table} WHERE {id}=?"
        ))
        .bind(&candidate.id)
        .fetch_one(&mut *conn)
        .await
        .map_err(error)?;
        let extra = if matches!(kind, Kind::Entry) {
            ",source_revisions_json"
        } else {
            ""
        };
        let placeholders =
            vec!["?"; fields.len() + 4 + usize::from(matches!(kind, Kind::Entry))].join(",");
        let query=format!("INSERT INTO {table} ({id},revision,content_hash,created_at,{}{extra}) VALUES ({placeholders})",fields.join(","));
        let mut query = sqlx::query(&query)
            .bind(&candidate.id)
            .bind(revision)
            .bind(&digest)
            .bind(at);
        for field in fields {
            query = query.bind(candidate.content.get(*field).cloned().flatten());
        }
        if matches!(kind, Kind::Entry) {
            query = query.bind(
                serde_json::to_string(pins.ok_or("KMB source pins are missing.")?)
                    .map_err(error)?,
            );
        }
        query.execute(&mut *conn).await.map_err(error)?;
        revision
    };
    sqlx::query(&format!(
        "UPDATE {logical} SET current_content_revision=?,updated_at=? WHERE id=?"
    ))
    .bind(revision)
    .bind(at)
    .bind(&candidate.id)
    .execute(&mut *conn)
    .await
    .map_err(error)?;
    Ok((revision, existing.is_none()))
}

async fn publish(pool: &SqlitePool, input: PublishInput) -> Result<Publication, String> {
    // Parse, validate and hash body/metadata before acquiring the publication lock.
    let sources = prepare(input.sources, Kind::Source)?;
    let entries = prepare(input.entries, Kind::Entry)?;
    let mut project_ids = BTreeSet::new();
    for project in &input.projects {
        if project.id.trim().is_empty() || !project_ids.insert(project.id.clone()) {
            return Err("KMB project identity is invalid.".into());
        }
    }
    let started = Instant::now();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await.map_err(error)?;
    let lock_wait_ms = started.elapsed().as_secs_f64() * 1000.0;
    let result:Result<Publication,String>=async {
        let mut outcome=Publication::default();
        for project in &input.projects {
            sqlx::query("INSERT INTO memory_projects (id,name,scope,entry_count,created_at,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,scope=excluded.scope,entry_count=excluded.entry_count,updated_at=excluded.updated_at")
                .bind(&project.id).bind(&project.name).bind(&project.scope).bind(project.entry_count).bind(input.imported_at).bind(input.imported_at)
                .execute(&mut *tx).await.map_err(error)?;
        }
        for source in &sources {
            let (_,created)=put_revision(&mut tx,Kind::Source,source,None,input.imported_at).await?;
            if created {outcome.source_revisions_created+=1;} else {outcome.revisions_reused+=1;}
        }
        for entry in &entries {
            let pins=source_pins(&mut tx,&entry.source_ids,true).await?;
            let (_,created)=put_revision(&mut tx,Kind::Entry,entry,Some(&pins),input.imported_at).await?;
            if created {outcome.entry_revisions_created+=1;} else {outcome.revisions_reused+=1;}
        }
        let entry_ids:BTreeSet<_>=entries.iter().map(|e|e.candidate.id.as_str()).collect();
        let existing:Vec<String>=sqlx::query_scalar("SELECT id FROM memory_entries").fetch_all(&mut *tx).await.map_err(error)?;
        for id in existing {
            if entry_ids.contains(id.as_str()) {continue;}
            let linked:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM preparation_snapshot_kmb_entry_links WHERE entry_id=?)").bind(&id).fetch_one(&mut *tx).await.map_err(error)?;
            if linked {
                sqlx::query("UPDATE memory_entries SET enabled=0,updated_at=? WHERE id=?").bind(input.imported_at).bind(&id).execute(&mut *tx).await.map_err(error)?;
                outcome.retained_stale_entries+=1;
            } else {
                sqlx::query("DELETE FROM memory_entries WHERE id=?").bind(&id).execute(&mut *tx).await.map_err(error)?;
            }
        }
        // Retained revisions keep their exact source lineage, including non-current history.
        let mut retained_sources:BTreeSet<String>=sources.iter().map(|s|s.candidate.id.clone()).collect();
        let references=sqlx::query("SELECT source_ids,project_id FROM memory_entry_revisions").fetch_all(&mut *tx).await.map_err(error)?;
        for row in references {
            if let Ok(ids)=serde_json::from_str::<Vec<String>>(row.get::<&str,_>("source_ids")) {retained_sources.extend(ids);}
            if let Some(id)=row.get::<Option<String>,_>("project_id") {project_ids.insert(id);}
        }
        let existing:Vec<String>=sqlx::query_scalar("SELECT id FROM memory_sources").fetch_all(&mut *tx).await.map_err(error)?;
        for id in existing {
            if !retained_sources.contains(&id) {
                sqlx::query("DELETE FROM memory_sources WHERE id=?").bind(id).execute(&mut *tx).await.map_err(error)?;
            }
        }
        let source_projects:Vec<String>=sqlx::query_scalar("SELECT DISTINCT project_id FROM memory_source_revisions WHERE project_id IS NOT NULL").fetch_all(&mut *tx).await.map_err(error)?;
        project_ids.extend(source_projects);
        let existing:Vec<String>=sqlx::query_scalar("SELECT id FROM memory_projects").fetch_all(&mut *tx).await.map_err(error)?;
        for id in existing {
            if !project_ids.contains(&id) {sqlx::query("DELETE FROM memory_projects WHERE id=?").bind(id).execute(&mut *tx).await.map_err(error)?;}
        }
        Ok(outcome)
    }.await;
    match result {
        Ok(mut outcome) => {
            tx.commit().await.map_err(error)?;
            outcome.transaction_ms = started.elapsed().as_secs_f64() * 1000.0;
            outcome.lock_wait_ms = lock_wait_ms;
            Ok(outcome)
        }
        Err(err) => {
            tx.rollback().await.map_err(error)?;
            Err(err)
        }
    }
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
