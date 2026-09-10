use super::*;
use sqlx::{sqlite::SqliteConnectOptions, Executor};

fn event(id: &str, session: &str) -> Value {
    json!({
        "schemaVersion": 2, "eventId": id, "sessionId": session,
        "subject": {"attemptId": "attempt", "questionId": "question", "traceIds": ["trace"], "sourceTurnIds": ["turn"]},
        "fact": {"kind": "expected-runtime-action", "expectedAction": "advise"},
        "provenance": {"source": "explicit-ui", "actor": "human", "collection": "organic", "recordedAt": 100,
            "interaction": {"startedAt": 90, "durationMs": 10, "clickCount": 1, "expandedRegions": []}},
        "confirmation": "confirmed"
    })
}

fn projection(id: &str, event: &Value) -> Value {
    json!({
        "schemaVersion": 2, "projectionId": id, "sessionId": event["sessionId"], "subject": event["subject"],
        "derivationVersion": "human-evaluation-v2.11", "inputEventIds": [event["eventId"]],
        "semanticInputEventIds": [event["eventId"]], "interventionOnlyEventIds": [], "inputTraceHashes": ["original-hash"],
        "observed": {"traceId": "trace", "traceHash": "original-hash", "runtimeAction": "buffer", "answerCommitted": false,
            "meetingMetadata": {"sourceCompany": null}},
        "activeFacts": {"expected-runtime-action": event}, "verdicts": {"runtimeActionCorrect": false},
        "conflicts": [], "computedAt": 110
    })
}

fn input(event: Value, id: &str) -> AppendInput {
    AppendInput {
        projection: projection(id, &event),
        event,
    }
}

fn import_input(events: Vec<Value>, projections: Vec<Value>) -> ImportInput {
    ImportInput {
        source_id: "local-v2-fixture".into(),
        events,
        projections,
        report: json!({"preserved": 2, "excludedFields": ["primaryAskCorrect"], "source": {"unchanged": true}}),
    }
}

async fn database() -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    pool.execute(include_str!("migrations/human-evaluation.sql"))
        .await
        .unwrap();
    pool
}

async fn counts(pool: &SqlitePool) -> (i64, i64, i64) {
    sqlx::query_as("SELECT (SELECT COUNT(*) FROM human_evaluation_events), (SELECT COUNT(*) FROM human_evaluation_projections), (SELECT COUNT(*) FROM human_evaluation_imports)")
        .fetch_one(pool).await.unwrap()
}

#[tokio::test]
async fn append_reopen_preserves_json_and_observed_exactly() {
    let path = std::env::temp_dir().join(format!("task167-{}.sqlite", uuid::Uuid::new_v4()));
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let pool = SqlitePool::connect_with(options.clone()).await.unwrap();
    pool.execute(include_str!("migrations/human-evaluation.sql"))
        .await
        .unwrap();
    let mut original = event("one", "s1");
    original["confirmation"] = json!("suggested");
    original["provenance"]["collection"] = json!("scripted-validation");
    original["provenance"]["evaluationTarget"] =
        json!({"attemptId": "attempt", "sourceTurnIds": ["turn"], "frozenAt": 90});
    let original_projection = projection("p1", &original);
    let result = append(&pool, input(original.clone(), "p1")).await.unwrap();
    assert_eq!(result.event, original);
    assert_eq!(result.projection, original_projection);
    pool.close().await;
    let pool = SqlitePool::connect_with(options).await.unwrap();
    let stored = read(&pool, "s1").await.unwrap();
    assert_eq!(stored.events, vec![original]);
    assert_eq!(stored.projections, vec![original_projection]);
    assert!(read(&pool, "s2").await.unwrap().events.is_empty());
    pool.close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn identical_event_is_idempotent_and_same_id_uses_serde_equality() {
    let pool = database().await;
    let original = event("one", "s1");
    append(&pool, input(original.clone(), "p1")).await.unwrap();
    let reordered: Value = serde_json::from_str(&original.to_string()).unwrap();
    let mut retry = input(reordered, "unused");
    retry.projection["observed"]["runtimeAction"] = json!("ignore");
    let saved = append(&pool, retry).await.unwrap();
    assert_eq!(saved.projection, projection("p1", &original));
    assert_eq!(counts(&pool).await, (1, 1, 0));
    let mut conflict = original.clone();
    conflict["provenance"]["recordedAt"] = json!(101);
    assert!(append(&pool, input(conflict, "p2"))
        .await
        .unwrap_err()
        .contains("eventId conflict"));
    assert_eq!(read(&pool, "s1").await.unwrap().events, vec![original]);
    assert_eq!(counts(&pool).await, (1, 1, 0));
}

#[tokio::test]
async fn action_retry_returns_persisted_event_and_projection_and_rejects_changed_truth() {
    let pool = database().await;
    let mut original = event("one", "s1");
    original["provenance"]["actionId"] = json!("click");
    append(&pool, input(original.clone(), "p1")).await.unwrap();
    let mut retry = original.clone();
    retry["eventId"] = json!("two");
    retry["provenance"]["recordedAt"] = json!(200);
    retry["subject"]["traceIds"] = json!(["another-trace"]);
    let saved = append(&pool, input(retry.clone(), "p2")).await.unwrap();
    assert_eq!(saved.event, original);
    assert_eq!(saved.projection, projection("p1", &original));
    assert_eq!(counts(&pool).await, (1, 1, 0));
    for field in [
        "fact",
        "confirmation",
        "supersedesEventId",
        "source",
        "collection",
    ] {
        let mut conflicting = retry.clone();
        match field {
            "fact" => conflicting["fact"]["expectedAction"] = json!("ignore"),
            "confirmation" => conflicting["confirmation"] = json!("suggested"),
            "supersedesEventId" => conflicting["supersedesEventId"] = json!("older"),
            "source" => conflicting["provenance"]["source"] = json!("imported-legacy"),
            "collection" => conflicting["provenance"]["collection"] = json!("scripted-validation"),
            _ => unreachable!(),
        }
        assert!(append(&pool, input(conflicting, "p2"))
            .await
            .unwrap_err()
            .contains("actionId conflict"));
        assert_eq!(counts(&pool).await, (1, 1, 0));
    }
}

#[test]
fn subjects_match_has_typescript_precedence_and_no_task_only_match() {
    let subject = |fields: Value| {
        let mut subject = json!({"traceIds": ["shared"], "sourceTurnIds": []});
        subject
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        subject
    };
    for (left, right, expected) in [
        (
            json!({"attemptId":"a"}),
            json!({"attemptId":"a","questionId":"different"}),
            true,
        ),
        (json!({"attemptId":"a"}), json!({}), false),
        (json!({"attemptId":"a"}), json!({"attemptId":"b"}), false),
        (
            json!({"questionId":"a"}),
            json!({"questionId":"b","momentId":"m"}),
            false,
        ),
        (
            json!({"questionId":"a"}),
            json!({"questionId":"a","momentId":"different"}),
            true,
        ),
        (
            json!({"questionId":"a","momentId":"m"}),
            json!({"momentId":"m"}),
            true,
        ),
        (json!({"momentId":"a"}), json!({"momentId":"b"}), false),
        (json!({"questionId":"a"}), json!({}), true),
        (
            json!({"taskId":"task","traceIds":[]}),
            json!({"taskId":"task","traceIds":[]}),
            false,
        ),
        (
            json!({"traceIds":["a","b"]}),
            json!({"traceIds":["b","c"]}),
            true,
        ),
    ] {
        assert_eq!(
            subjects_match(&subject(left.clone()), &subject(right.clone())),
            expected,
            "{left} vs {right}"
        );
    }
}

#[tokio::test]
async fn action_dedup_is_scoped_to_session_fact_kind_and_matching_subject() {
    let pool = database().await;
    let mut original = event("one", "s1");
    original["provenance"]["actionId"] = json!("click");
    append(&pool, input(original.clone(), "p1")).await.unwrap();
    let mut other_session = original.clone();
    other_session["eventId"] = json!("two");
    other_session["sessionId"] = json!("s2");
    append(&pool, input(other_session.clone(), "p2"))
        .await
        .unwrap();
    let mut other_kind = original.clone();
    other_kind["eventId"] = json!("three");
    other_kind["fact"] =
        json!({"kind":"primary-ask-correction","correctedPrimaryAsk":"Correct text"});
    append(&pool, input(other_kind, "p3")).await.unwrap();
    let mut other_subject = original.clone();
    other_subject["eventId"] = json!("four");
    other_subject["subject"]["attemptId"] = json!("other-attempt");
    append(&pool, input(other_subject, "p4")).await.unwrap();
    assert_eq!(counts(&pool).await, (4, 4, 0));
    assert_eq!(read(&pool, "s1").await.unwrap().events.len(), 3);
    assert_eq!(read(&pool, "s2").await.unwrap().events, vec![other_session]);
    let mut reused_global_id = original;
    reused_global_id["sessionId"] = json!("s2");
    assert!(append(&pool, input(reused_global_id, "p5"))
        .await
        .unwrap_err()
        .contains("eventId conflict"));
}

#[tokio::test]
async fn projection_sql_failure_rolls_back_event_and_retry_succeeds() {
    let pool = database().await;
    pool.execute("CREATE TRIGGER fail_projection BEFORE INSERT ON human_evaluation_projections BEGIN SELECT RAISE(ABORT, 'fixture projection failure'); END;").await.unwrap();
    assert!(append(&pool, input(event("one", "s1"), "p1"))
        .await
        .unwrap_err()
        .contains("fixture projection failure"));
    assert_eq!(counts(&pool).await, (0, 0, 0));
    pool.execute("DROP TRIGGER fail_projection").await.unwrap();
    append(&pool, input(event("one", "s1"), "p1"))
        .await
        .unwrap();
    assert_eq!(counts(&pool).await, (1, 1, 0));
}

#[tokio::test]
async fn projection_session_collision_rolls_back_new_event() {
    let pool = database().await;
    append(&pool, input(event("one", "s1"), "p1"))
        .await
        .unwrap();
    assert!(append(&pool, input(event("two", "s2"), "p1"))
        .await
        .unwrap_err()
        .contains("projectionId conflict"));
    assert_eq!(counts(&pool).await, (1, 1, 0));
    assert!(read(&pool, "s2").await.unwrap().events.is_empty());
}

#[tokio::test]
async fn supersession_appends_history_and_can_replace_same_projection_cache() {
    let pool = database().await;
    let original = event("one", "s1");
    append(&pool, input(original.clone(), "p1")).await.unwrap();
    let mut revision = event("two", "s1");
    revision["supersedesEventId"] = json!("one");
    revision["fact"]["expectedAction"] = json!("ignore");
    let mut update = input(revision.clone(), "p1");
    update.projection["inputEventIds"] = json!(["one", "two"]);
    let updated_projection = update.projection.clone();
    append(&pool, update).await.unwrap();
    let stored = read(&pool, "s1").await.unwrap();
    assert_eq!(stored.events, vec![original, revision]);
    assert_eq!(stored.projections, vec![updated_projection]);
}

#[tokio::test]
async fn import_receipt_failure_rolls_back_all_writes_then_retry_replays_saved_receipt() {
    let pool = database().await;
    let first = event("one", "s1");
    let second = event("two", "s2");
    let events = vec![first.clone(), second.clone()];
    let projections = vec![projection("p1", &first), projection("p2", &second)];
    pool.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON human_evaluation_imports BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END;").await.unwrap();
    assert!(
        import(&pool, import_input(events.clone(), projections.clone()))
            .await
            .unwrap_err()
            .contains("fixture receipt failure")
    );
    assert_eq!(counts(&pool).await, (0, 0, 0));
    pool.execute("DROP TRIGGER fail_receipt").await.unwrap();
    let receipt = import(&pool, import_input(events.clone(), projections.clone()))
        .await
        .unwrap();
    assert_eq!(
        receipt,
        json!({"sourceId":"local-v2-fixture", "report":import_input(vec![],vec![]).report})
    );
    assert_eq!(counts(&pool).await, (2, 2, 1));
    let stored_receipt: String = sqlx::query_scalar("SELECT receipt FROM human_evaluation_imports")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&stored_receipt).unwrap(),
        receipt
    );
    let mut retry = import_input(vec![json!({"invalid":"ignored after receipt"})], vec![]);
    retry.report = json!({"changed":true});
    assert_eq!(import(&pool, retry).await.unwrap(), receipt);
    assert_eq!(read(&pool, "s1").await.unwrap().events, vec![first]);
    assert_eq!(
        read(&pool, "s2").await.unwrap().projections,
        vec![projections[1].clone()]
    );
    assert_eq!(counts(&pool).await, (2, 2, 1));
}

#[tokio::test]
async fn import_id_and_projection_conflicts_roll_back_earlier_batch_inserts() {
    let pool = database().await;
    let original = event("one", "s1");
    append(&pool, input(original.clone(), "p1")).await.unwrap();
    let added = event("two", "s1");
    let mut conflict = original.clone();
    conflict["confirmation"] = json!("suggested");
    assert!(
        import(&pool, import_input(vec![added.clone(), conflict], vec![]))
            .await
            .unwrap_err()
            .contains("eventId conflict")
    );
    assert_eq!(counts(&pool).await, (1, 1, 0));
    let mut changed_projection = projection("p1", &original);
    changed_projection["observed"]["runtimeAction"] = json!("ignore");
    assert!(import(
        &pool,
        import_input(
            vec![added.clone()],
            vec![projection("p2", &added), changed_projection]
        )
    )
    .await
    .unwrap_err()
    .contains("projectionId conflict"));
    assert_eq!(counts(&pool).await, (1, 1, 0));
    import(
        &pool,
        import_input(
            vec![added.clone(), original.clone()],
            vec![projection("p2", &added)],
        ),
    )
    .await
    .unwrap();
    assert_eq!(counts(&pool).await, (2, 2, 1));
    assert_eq!(
        read(&pool, "s1").await.unwrap().projections[0],
        projection("p1", &original)
    );
}

#[tokio::test]
async fn import_preserves_original_action_duplicates_without_normalizing_or_dropping_fields() {
    let pool = database().await;
    let mut first = event("one", "s1");
    first["provenance"]["actionId"] = json!("legacy-click");
    first["provenance"]["source"] = json!("imported-legacy");
    first["confirmation"] = json!("suggested");
    let mut second = first.clone();
    second["eventId"] = json!("two");
    second["fact"]["expectedAction"] = json!("ignore");
    let original_projection = projection("p1", &first);
    import(
        &pool,
        import_input(
            vec![first.clone(), second.clone()],
            vec![original_projection.clone()],
        ),
    )
    .await
    .unwrap();
    let stored = read(&pool, "s1").await.unwrap();
    assert_eq!(stored.events, vec![first.clone(), second]);
    assert_eq!(stored.projections, vec![original_projection]);
    let mut new_click = first;
    new_click["eventId"] = json!("three");
    assert!(append(&pool, input(new_click, "p3"))
        .await
        .unwrap_err()
        .contains("actionId conflict"));
    assert_eq!(counts(&pool).await, (2, 1, 1));
}

#[tokio::test]
async fn malformed_and_wrong_session_input_never_persists_and_closed_pool_errors() {
    let pool = database().await;
    for field in [
        "schemaVersion",
        "subject",
        "fact",
        "provenance",
        "confirmation",
        "eventId",
    ] {
        let mut malformed = event("one", "s1");
        malformed.as_object_mut().unwrap().remove(field);
        assert!(
            append(&pool, input(malformed, "p1")).await.is_err(),
            "{field}"
        );
    }
    let mut mismatched = input(event("one", "s1"), "p1");
    mismatched.projection["sessionId"] = json!("s2");
    assert!(append(&pool, mismatched).await.is_err());
    let mut mismatched = input(event("one", "s1"), "p1");
    mismatched.projection["subject"]["attemptId"] = json!("other");
    assert!(append(&pool, mismatched).await.is_err());
    let mut mismatched = input(event("one", "s1"), "p1");
    mismatched.projection["inputEventIds"] = json!([]);
    assert!(append(&pool, mismatched).await.is_err());
    assert!(read(&pool, "").await.is_err());
    assert_eq!(counts(&pool).await, (0, 0, 0));
    pool.close().await;
    assert!(append(&pool, input(event("one", "s1"), "p1"))
        .await
        .is_err());
    assert!(read(&pool, "s1").await.is_err());
}

#[tokio::test]
async fn imported_event_without_projection_requires_persisted_id_for_action_retry() {
    let pool = database().await;
    let mut original = event("one", "s1");
    original["provenance"]["actionId"] = json!("click");
    import(&pool, import_input(vec![original.clone()], vec![]))
        .await
        .unwrap();
    let mut retry = original.clone();
    retry["eventId"] = json!("two");
    assert!(append(&pool, input(retry, "p2"))
        .await
        .unwrap_err()
        .contains("no saved projection"));
    assert_eq!(counts(&pool).await, (1, 0, 1));
    let saved = append(&pool, input(original.clone(), "p1")).await.unwrap();
    assert_eq!(saved.event, original);
    assert_eq!(counts(&pool).await, (1, 1, 1));
}

#[tokio::test]
async fn concurrent_action_retries_use_one_committed_event_and_projection() {
    let path = std::env::temp_dir().join(format!(
        "task167-concurrent-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .unwrap();
    pool.execute(include_str!("migrations/human-evaluation.sql"))
        .await
        .unwrap();
    let mut first = event("one", "s1");
    first["provenance"]["actionId"] = json!("click");
    let mut second = first.clone();
    second["eventId"] = json!("two");
    let (first, second) = tokio::join!(
        append(&pool, input(first, "p1")),
        append(&pool, input(second, "p2"))
    );
    let (first, second) = (first.unwrap(), second.unwrap());
    assert_eq!(first.event, second.event);
    assert_eq!(first.projection, second.projection);
    assert_eq!(counts(&pool).await, (1, 1, 0));
    pool.close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn migration_21_applies_to_existing_schema_in_isolated_fixture() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    let mut count = 0;
    for migration in crate::db::migrations() {
        pool.execute(migration.sql).await.unwrap();
        if migration.version == 21 {
            count += 1;
        }
    }
    assert_eq!(count, 1);
    append(&pool, input(event("one", "s1"), "p1"))
        .await
        .unwrap();
    assert_eq!(counts(&pool).await, (1, 1, 0));
}

#[tokio::test]
async fn observed_only_refresh_reopens_without_creating_human_facts() {
    let path =
        std::env::temp_dir().join(format!("task167-observed-{}.sqlite", uuid::Uuid::new_v4()));
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let pool = SqlitePool::connect_with(options.clone()).await.unwrap();
    pool.execute(include_str!("migrations/human-evaluation.sql"))
        .await
        .unwrap();
    let mut observed = projection("p1", &event("unused", "s1"));
    observed["inputEventIds"] = json!([]);
    observed["semanticInputEventIds"] = json!([]);
    observed["activeFacts"] = json!({});
    observed["verdicts"] = json!({});
    assert_eq!(project(&pool, observed.clone()).await.unwrap(), observed);
    assert_eq!(counts(&pool).await, (0, 1, 0));
    observed["observed"]["runtimeAction"] = json!("advise");
    observed["observed"]["answerCommitted"] = json!(true);
    observed["computedAt"] = json!(200);
    observed["subject"]["traceIds"] = json!(["trace", "refresh-trace"]);
    project(&pool, observed.clone()).await.unwrap();
    pool.close().await;
    let pool = SqlitePool::connect_with(options).await.unwrap();
    let stored = read(&pool, "s1").await.unwrap();
    assert!(stored.events.is_empty());
    assert_eq!(stored.projections, vec![observed]);
    assert!(read(&pool, "s2").await.unwrap().projections.is_empty());
    assert_eq!(counts(&pool).await, (0, 1, 0));
    pool.close().await;
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn projection_refresh_failure_retains_previous_observed_and_all_events() {
    let pool = database().await;
    let original = event("one", "s1");
    let previous = projection("p1", &original);
    append(&pool, input(original.clone(), "p1")).await.unwrap();
    let mut refreshed = previous.clone();
    refreshed["observed"]["runtimeAction"] = json!("advise");
    refreshed["verdicts"]["runtimeActionCorrect"] = json!(true);
    pool.execute("CREATE TRIGGER fail_refresh BEFORE UPDATE ON human_evaluation_projections BEGIN SELECT RAISE(ABORT, 'fixture refresh failure'); END;").await.unwrap();
    assert!(project(&pool, refreshed.clone())
        .await
        .unwrap_err()
        .contains("fixture refresh failure"));
    assert_eq!(
        read(&pool, "s1").await.unwrap().projections,
        vec![previous.clone()]
    );
    pool.execute("DROP TRIGGER fail_refresh").await.unwrap();
    for (field, value) in [
        ("sessionId", json!("s2")),
        (
            "subject",
            json!({"attemptId":"other", "traceIds":[],"sourceTurnIds":[]}),
        ),
    ] {
        let mut wrong_target = refreshed.clone();
        wrong_target[field] = value;
        assert!(project(&pool, wrong_target)
            .await
            .unwrap_err()
            .contains("projectionId conflict"));
    }
    project(&pool, refreshed.clone()).await.unwrap();
    assert_eq!(counts(&pool).await, (1, 1, 0));
    assert_eq!(read(&pool, "s1").await.unwrap().events, vec![original]);
    assert_eq!(
        read(&pool, "s1").await.unwrap().projections,
        vec![refreshed]
    );
}

#[tokio::test]
async fn retrying_superseded_event_keeps_latest_projection() {
    let pool = database().await;
    let original = event("one", "s1");
    append(&pool, input(original.clone(), "p1")).await.unwrap();
    let mut revision = event("two", "s1");
    revision["supersedesEventId"] = json!("one");
    revision["fact"]["expectedAction"] = json!("ignore");
    let latest = projection("p1", &revision);
    append(&pool, input(revision, "p1")).await.unwrap();
    let retry = append(&pool, input(original, "p1")).await.unwrap();
    assert_eq!(retry.projection, latest);
    assert_eq!(read(&pool, "s1").await.unwrap().projections, vec![latest]);
    assert_eq!(counts(&pool).await, (2, 1, 0));
}
