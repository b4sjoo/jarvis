use serde::Serialize;
use serde_json::{Map, Value as JsonValue};
use sqlx::{
    query::Query,
    sqlite::{SqliteArguments, SqliteConnectOptions, SqliteConnection, SqliteRow},
    Column, Connection, Row, Sqlite, TypeInfo, ValueRef,
};
use std::{collections::HashMap, path::PathBuf, str::FromStr, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;
use uuid::Uuid;

const DATABASE_NAME: &str = "moss.db";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const TRANSACTION_LEASE: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct PreparationTransactionState {
    connections: Arc<Mutex<HashMap<String, SqliteConnection>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransactionExecuteResult {
    rows_affected: u64,
    last_insert_id: i64,
}

fn database_path<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|path| path.join(DATABASE_NAME))
        .map_err(|error| format!("MOSS database path is unavailable: {error}"))
}

fn bind_values<'q>(
    mut statement: Query<'q, Sqlite, SqliteArguments<'q>>,
    values: Vec<JsonValue>,
) -> Query<'q, Sqlite, SqliteArguments<'q>> {
    for value in values {
        if value.is_null() {
            statement = statement.bind(None::<JsonValue>);
        } else if let Some(value) = value.as_str() {
            statement = statement.bind(value.to_owned());
        } else if let Some(value) = value.as_number() {
            statement = statement.bind(value.as_f64().unwrap_or_default());
        } else {
            statement = statement.bind(value);
        }
    }
    statement
}

fn decode_row(row: &SqliteRow) -> Result<Map<String, JsonValue>, String> {
    let mut result = Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let raw = row
            .try_get_raw(index)
            .map_err(|error| format!("Failed to read transaction result: {error}"))?;
        let value = if raw.is_null() {
            JsonValue::Null
        } else {
            match raw.type_info().name() {
                "TEXT" => JsonValue::String(
                    row.try_get::<String, _>(index)
                        .map_err(|error| format!("Failed to decode transaction text: {error}"))?,
                ),
                "INTEGER" | "NUMERIC" => JsonValue::Number(
                    row.try_get::<i64, _>(index)
                        .map_err(|error| format!("Failed to decode transaction integer: {error}"))?
                        .into(),
                ),
                "REAL" => JsonValue::from(
                    row.try_get::<f64, _>(index)
                        .map_err(|error| format!("Failed to decode transaction real: {error}"))?,
                ),
                "BOOLEAN" => {
                    JsonValue::Bool(row.try_get::<bool, _>(index).map_err(|error| {
                        format!("Failed to decode transaction boolean: {error}")
                    })?)
                }
                "BLOB" => JsonValue::Array(
                    row.try_get::<Vec<u8>, _>(index)
                        .map_err(|error| format!("Failed to decode transaction blob: {error}"))?
                        .into_iter()
                        .map(|value| JsonValue::Number(value.into()))
                        .collect(),
                ),
                "NULL" => JsonValue::Null,
                kind => return Err(format!("Unsupported transaction result type: {kind}")),
            }
        };
        result.insert(column.name().to_string(), value);
    }
    Ok(result)
}

async fn open_connection(path: PathBuf) -> Result<SqliteConnection, String> {
    let options = SqliteConnectOptions::from_str(
        path.to_str()
            .ok_or_else(|| "MOSS database path is not valid UTF-8.".to_string())?,
    )
    .map_err(|error| format!("Failed to configure MOSS transaction database: {error}"))?
    .create_if_missing(false)
    .busy_timeout(BUSY_TIMEOUT);
    let mut connection = SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("Failed to open MOSS transaction database: {error}"))?;
    sqlx::query("PRAGMA foreign_keys = ON")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Failed to enable transaction foreign keys: {error}"))?;
    Ok(connection)
}

async fn begin_at_path(
    path: PathBuf,
    state: &PreparationTransactionState,
) -> Result<String, String> {
    let mut connection = open_connection(path).await?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut connection)
        .await
        .map_err(|error| format!("Failed to begin MOSS transaction: {error}"))?;
    let transaction_id = format!("preparation_transaction_{}", Uuid::new_v4());
    state
        .connections
        .lock()
        .await
        .insert(transaction_id.clone(), connection);
    Ok(transaction_id)
}

async fn execute_in_transaction(
    transaction_id: &str,
    query: String,
    values: Vec<JsonValue>,
    state: &PreparationTransactionState,
) -> Result<TransactionExecuteResult, String> {
    let mut connections = state.connections.lock().await;
    let connection = connections
        .get_mut(transaction_id)
        .ok_or_else(|| "Preparation transaction is no longer active.".to_string())?;
    let result = bind_values(sqlx::query(&query), values)
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("Preparation transaction write failed: {error}"))?;
    Ok(TransactionExecuteResult {
        rows_affected: result.rows_affected(),
        last_insert_id: result.last_insert_rowid(),
    })
}

async fn select_in_transaction(
    transaction_id: &str,
    query: String,
    values: Vec<JsonValue>,
    state: &PreparationTransactionState,
) -> Result<Vec<Map<String, JsonValue>>, String> {
    let mut connections = state.connections.lock().await;
    let connection = connections
        .get_mut(transaction_id)
        .ok_or_else(|| "Preparation transaction is no longer active.".to_string())?;
    let rows = bind_values(sqlx::query(&query), values)
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| format!("Preparation transaction read failed: {error}"))?;
    rows.iter().map(decode_row).collect()
}

async fn finish_transaction(
    transaction_id: &str,
    command: &str,
    state: &PreparationTransactionState,
) -> Result<(), String> {
    let Some(mut connection) = state.connections.lock().await.remove(transaction_id) else {
        return if command == "ROLLBACK" {
            Ok(())
        } else {
            Err("Preparation transaction is no longer active.".to_string())
        };
    };
    sqlx::query(command)
        .execute(&mut connection)
        .await
        .map_err(|error| {
            format!(
                "Failed to {} MOSS transaction: {error}",
                command.to_lowercase()
            )
        })?;
    Ok(())
}

async fn rollback_if_active(
    transaction_id: &str,
    connections: &Mutex<HashMap<String, SqliteConnection>>,
) -> bool {
    let Some(mut connection) = connections.lock().await.remove(transaction_id) else {
        return false;
    };
    let _ = sqlx::query("ROLLBACK").execute(&mut connection).await;
    true
}

#[tauri::command]
pub async fn begin_preparation_transaction(
    app: AppHandle,
    state: State<'_, PreparationTransactionState>,
) -> Result<String, String> {
    let transaction_id = begin_at_path(database_path(&app)?, &state).await?;
    let leased_transaction_id = transaction_id.clone();
    let connections = Arc::clone(&state.connections);
    tokio::spawn(async move {
        tokio::time::sleep(TRANSACTION_LEASE).await;
        if rollback_if_active(&leased_transaction_id, &connections).await {
            tracing::warn!(
                transaction_id = %leased_transaction_id,
                "Rolled back abandoned preparation transaction after its lease expired"
            );
        }
    });
    Ok(transaction_id)
}

#[tauri::command]
pub async fn execute_preparation_transaction(
    transaction_id: String,
    query: String,
    values: Vec<JsonValue>,
    state: State<'_, PreparationTransactionState>,
) -> Result<TransactionExecuteResult, String> {
    execute_in_transaction(&transaction_id, query, values, &state).await
}

#[tauri::command]
pub async fn select_preparation_transaction(
    transaction_id: String,
    query: String,
    values: Vec<JsonValue>,
    state: State<'_, PreparationTransactionState>,
) -> Result<Vec<Map<String, JsonValue>>, String> {
    select_in_transaction(&transaction_id, query, values, &state).await
}

#[tauri::command]
pub async fn commit_preparation_transaction(
    transaction_id: String,
    state: State<'_, PreparationTransactionState>,
) -> Result<(), String> {
    finish_transaction(&transaction_id, "COMMIT", &state).await
}

#[tauri::command]
pub async fn rollback_preparation_transaction(
    transaction_id: String,
    state: State<'_, PreparationTransactionState>,
) -> Result<(), String> {
    finish_transaction(&transaction_id, "ROLLBACK", &state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transaction_session_keeps_one_connection_until_commit_or_rollback() {
        let path = std::env::temp_dir().join(format!("moss-transaction-{}.db", Uuid::new_v4()));
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .busy_timeout(BUSY_TIMEOUT);
        let mut setup = SqliteConnection::connect_with(&options).await.unwrap();
        sqlx::query("CREATE TABLE items (id TEXT PRIMARY KEY NOT NULL)")
            .execute(&mut setup)
            .await
            .unwrap();
        drop(setup);

        let state = PreparationTransactionState::default();
        let transaction_id = begin_at_path(path.clone(), &state).await.unwrap();
        execute_in_transaction(
            &transaction_id,
            "INSERT INTO items (id) VALUES (?)".to_string(),
            vec![JsonValue::String("committed".to_string())],
            &state,
        )
        .await
        .unwrap();
        let inside = select_in_transaction(
            &transaction_id,
            "SELECT COUNT(*) AS count FROM items".to_string(),
            vec![],
            &state,
        )
        .await
        .unwrap();
        assert_eq!(inside[0].get("count"), Some(&JsonValue::from(1)));
        finish_transaction(&transaction_id, "COMMIT", &state)
            .await
            .unwrap();

        let rollback_id = begin_at_path(path.clone(), &state).await.unwrap();
        execute_in_transaction(
            &rollback_id,
            "INSERT INTO items (id) VALUES (?)".to_string(),
            vec![JsonValue::String("rolled-back".to_string())],
            &state,
        )
        .await
        .unwrap();
        finish_transaction(&rollback_id, "ROLLBACK", &state)
            .await
            .unwrap();

        let abandoned_id = begin_at_path(path.clone(), &state).await.unwrap();
        execute_in_transaction(
            &abandoned_id,
            "INSERT INTO items (id) VALUES (?)".to_string(),
            vec![JsonValue::String("abandoned".to_string())],
            &state,
        )
        .await
        .unwrap();
        assert!(rollback_if_active(&abandoned_id, &state.connections).await);
        assert!(!rollback_if_active(&abandoned_id, &state.connections).await);

        let mut observer = open_connection(path.clone()).await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM items")
            .fetch_one(&mut observer)
            .await
            .unwrap();
        assert_eq!(count, 1);
        drop(observer);
        std::fs::remove_file(path).unwrap();
    }
}
