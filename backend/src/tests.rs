use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::{AppState, access::Access, analysis::Analysis, api, now_ms, vision::Vision};

fn test_app() -> Router {
    test_app_with_access(Access::default())
}

fn test_app_with_access(access: Access) -> Router {
    Router::new().nest(
        "/api",
        api(AppState::open(
            ":memory:".as_ref(),
            Vision::default(),
            Analysis::offline(),
            access,
        )
        .unwrap()),
    )
}

async fn request(router: &Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let payload = to_bytes(response.into_body(), 2_000_000).await.unwrap();
    (status, serde_json::from_slice(&payload).unwrap())
}

async fn send(router: &Router, method: &str, path: &str, body: Value) -> Value {
    let (status, payload) = request(router, method, path, body).await;
    assert_eq!(status, StatusCode::OK, "{method} {path}: {payload}");
    payload
}

fn event(id: &str, bin: &str, status: &str, time: i64) -> Value {
    json!({"event_id": id, "bin_id": bin, "status": status, "observed_at": time})
}

#[tokio::test]
async fn team_access_preserves_public_browsing_and_guards_writes_and_model_calls() {
    const PASSCODE: &str = "test-only-not-a-production-passcode";
    let app = test_app_with_access(Access::configured(PASSCODE, true));
    assert_eq!(
        send(&app, "GET", "/api/access", Value::Null).await,
        json!({ "required": true, "signed_in": false })
    );
    assert_eq!(
        send(&app, "GET", "/api/analysis?days=7", Value::Null).await["source"],
        "rules"
    );
    assert_eq!(
        send(
            &app,
            "POST",
            "/api/recognize",
            json!({ "mode": "replay", "sample": "bottle" })
        )
        .await["source"],
        "replay"
    );
    let full = event("protected-full", "a-recycle", "full", now_ms());
    for (path, body) in [
        ("/api/sensor", full.clone()),
        ("/api/tickets/1/collect", json!({})),
        ("/api/demo/reset", json!({})),
        ("/api/analysis", json!({ "days": 7 })),
        (
            "/api/recognize",
            json!({ "mode": "live", "image": "ignored" }),
        ),
        ("/api/access", json!({ "passcode": "incorrect" })),
    ] {
        assert_eq!(
            request(&app, "POST", path, body).await.0,
            StatusCode::UNAUTHORIZED,
            "{path}"
        );
    }
    let login = app
        .clone()
        .oneshot(
            Request::post("/api/access")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "passcode": PASSCODE }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = login.headers()[header::SET_COOKIE].to_str().unwrap();
    assert!(
        cookie.contains("HttpOnly")
            && cookie.contains("SameSite=Strict")
            && cookie.contains("Secure")
    );
    assert!(!cookie.contains(PASSCODE));
    let session = cookie.split(';').next().unwrap();
    let full_result = app
        .clone()
        .oneshot(
            Request::post("/api/sensor")
                .header(header::COOKIE, session)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(full.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(full_result.status(), StatusCode::OK);
    let state = send(&app, "GET", "/api/state", Value::Null).await;
    assert_eq!(state["tickets"].as_array().unwrap().len(), 1);

    let tampered = app
        .clone()
        .oneshot(
            Request::post("/api/demo/reset")
                .header(header::COOKIE, format!("{session}Z"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(tampered.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(send(&app, "GET", "/api/state", Value::Null).await, state);
}

#[tokio::test]
async fn analysis_uses_verified_closure_and_selected_window() {
    let app = test_app();
    let now = now_ms();
    let older = now - 8 * 86_400_000;
    send(
        &app,
        "POST",
        "/api/sensor",
        event("old", "a-food", "full", older),
    )
    .await;
    send(
        &app,
        "POST",
        "/api/sensor",
        event("old-clear", "a-food", "available", older + 60_000),
    )
    .await;
    send(
        &app,
        "POST",
        "/api/sensor",
        event("new", "b-recycle", "full", now - 1_500_000),
    )
    .await;

    let week = send(&app, "GET", "/api/analysis?days=7", Value::Null).await;
    let month = send(&app, "POST", "/api/analysis", json!({ "days": 28 })).await;

    assert_eq!(week["source"], "rules");
    assert_eq!(week["lang"], "zh-CN");
    assert_eq!(week["stats"]["opened"], 1);
    assert_eq!(week["stats"]["long_wait"], 1);
    assert_eq!(week["stats"]["mean_minutes"], Value::Null);
    assert_eq!(month["stats"]["opened"], 2);
    assert_eq!(month["stats"]["closed"], 1);
    assert_eq!(month["stats"]["mean_minutes"], 1.0);
    let english = send(&app, "GET", "/api/analysis?days=7&lang=en", Value::Null).await;
    assert_eq!(english["lang"], "en");
    assert_eq!(english["stats"]["opened"], week["stats"]["opened"]);
    assert_eq!(
        english["stats"]["stations"][0]["name"],
        "Residence Station A"
    );
    assert_eq!(
        english["suggestions"][0]["evidence"],
        "Open tickets waiting at least 20 minutes: 1."
    );
    assert!(
        month["suggestions"][0]["evidence"]
            .as_str()
            .unwrap()
            .contains("20 分钟")
    );
    let (status, _) = request(&app, "POST", "/api/analysis", json!({ "days": 9 })).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn full_redirects_and_requires_fresh_verification_after_collection() {
    let app = test_app();
    let time = now_ms() - 300;
    let path = "/api/guidance?station_id=a&category=recycle";
    assert_eq!(
        send(&app, "GET", path, Value::Null).await["action"],
        "local"
    );

    let full = event("full", "a-recycle", "full", time);
    let state = send(&app, "POST", "/api/sensor", full.clone()).await;
    let id = state["tickets"][0]["id"].as_i64().unwrap();
    assert_eq!(state["recommendation"], id);

    let repeated = send(&app, "POST", "/api/sensor", full).await;
    assert_eq!(state, repeated);
    let newer = event("full-again", "a-recycle", "full", time + 1);
    let repeated = send(&app, "POST", "/api/sensor", newer).await;
    assert_eq!(repeated["tickets"].as_array().unwrap().len(), 1);
    assert_eq!(
        send(&app, "GET", path, Value::Null).await["station_id"],
        "b"
    );

    let collect_path = format!("/api/tickets/{id}/collect");
    let awaiting = send(&app, "POST", &collect_path, json!({})).await;
    assert_eq!(awaiting["tickets"][0]["status"], "awaiting_verify");
    assert!(awaiting["recommendation"].is_null());

    let late = event("late-clear", "a-recycle", "available", time + 2);
    let unchanged = send(&app, "POST", "/api/sensor", late).await;
    assert_eq!(awaiting, unchanged);

    let report_time = now_ms() + 20;
    let full = event("still-full", "a-recycle", "full", report_time);
    let review = send(&app, "POST", "/api/sensor", full).await;
    assert_eq!(review["tickets"][0]["status"], "needs_review");
    assert_eq!(review["recommendation"], id);

    let clear = event("cleared", "a-recycle", "available", report_time + 1);
    let cleared = send(&app, "POST", "/api/sensor", clear).await;
    assert_eq!(cleared["tickets"][0]["status"], "closed");
    assert_eq!(
        send(&app, "GET", path, Value::Null).await["action"],
        "local"
    );

    let full = event("next-full", "a-recycle", "full", report_time + 2);
    let subsequent = send(&app, "POST", "/api/sensor", full).await;
    assert_eq!(subsequent["tickets"].as_array().unwrap().len(), 2);
    assert_ne!(subsequent["recommendation"], id);
}

#[tokio::test]
async fn unknown_bins_are_excluded_from_same_category_guidance() {
    let app = test_app();
    let time = now_ms();
    for station in ["a", "b", "c"] {
        let bin = format!("{station}-recycle");
        let report = event(station, &bin, "unknown", time);
        let state = send(&app, "POST", "/api/sensor", report).await;
        assert!(state["tickets"].as_array().unwrap().is_empty());
    }
    let wait = send(
        &app,
        "GET",
        "/api/guidance?station_id=a&category=recycle",
        Value::Null,
    )
    .await;
    assert_eq!(
        wait,
        json!({"action": "wait", "bin_id": null, "station_id": null})
    );
    let reset = send(&app, "POST", "/api/demo/reset", json!({})).await;
    assert!(
        reset["bins"]
            .as_array()
            .unwrap()
            .iter()
            .all(|bin| bin["status"]
                == if bin["id"].as_str().unwrap().starts_with("GZ-") {
                    "unknown"
                } else {
                    "available"
                })
    );
}

#[tokio::test]
async fn older_reports_win_outside_the_travel_tie_window() {
    let app = test_app();
    let time = now_ms() - 300_000;
    send(
        &app,
        "POST",
        "/api/sensor",
        event("older", "c-recycle", "full", time),
    )
    .await;
    let near_tie = send(
        &app,
        "POST",
        "/api/sensor",
        event("nearer", "a-recycle", "full", time + 60_000),
    )
    .await;
    assert_eq!(near_tie["recommendation"], near_tie["tickets"][1]["id"]);
    let new = send(&app, "POST", "/api/demo/reset", json!({})).await;
    assert!(new["recommendation"].is_null());
    send(
        &app,
        "POST",
        "/api/sensor",
        event("older", "c-recycle", "full", time),
    )
    .await;
    let oldest = send(
        &app,
        "POST",
        "/api/sensor",
        event("nearer", "a-recycle", "full", time + 60_001),
    )
    .await;
    assert_eq!(oldest["recommendation"], oldest["tickets"][0]["id"]);
}

#[tokio::test]
async fn replay_is_explicit_and_live_never_returns_a_fixture() {
    let app = test_app();
    let sample = send(
        &app,
        "POST",
        "/api/recognize",
        json!({"mode":"replay","sample":"cup"}),
    )
    .await;
    assert_eq!(sample["source"], "replay");
    assert!(sample["category"].is_null());
    assert!(sample["question"].is_string());
    let (status, body) = request(
        &app,
        "POST",
        "/api/recognize",
        json!({"mode":"live", "sample":"bottle"}),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.get("error").is_some());
}

#[tokio::test]
async fn collection_catalog_and_analysis_are_separate_from_sorting() {
    let app = test_app();
    let initial = send(&app, "GET", "/api/state", Value::Null).await;
    let points = initial["collection_points"].as_array().unwrap();
    assert_eq!(points.len(), 50);
    let ids: std::collections::HashSet<_> = points
        .iter()
        .map(|point| point["bin_id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 50);
    for number in 1..=50 {
        assert!(ids.contains(format!("GZ-{number:03}").as_str()));
    }
    for point in points {
        for field in ["map_x", "map_y"] {
            assert!((0.0..=1.0).contains(&point[field].as_f64().unwrap()));
        }
    }
    let bins = initial["bins"].as_array().unwrap();
    assert_eq!(bins.len(), 62);
    assert!(
        bins.iter()
            .filter(|bin| bin["id"].as_str().unwrap().starts_with("GZ-"))
            .all(|bin| bin["status"] == "unknown" && bin["received_at"].is_null())
    );
    let now = now_ms();
    send(
        &app,
        "POST",
        "/api/sensor",
        event("collection-first", "GZ-017", "full", now - 1_500_000),
    )
    .await;
    send(
        &app,
        "POST",
        "/api/sensor",
        event("collection-repeat", "GZ-017", "full", now - 1_000_000),
    )
    .await;
    let state = send(&app, "GET", "/api/state", Value::Null).await;
    assert_eq!(state["tickets"].as_array().unwrap().len(), 1);
    assert_eq!(state["tickets"][0]["opened_at"], now - 1_500_000);
    let bin = state["bins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|bin| bin["id"] == "GZ-017")
        .unwrap();
    assert!(bin["received_at"].as_i64().unwrap() >= now);
    let collection = send(
        &app,
        "GET",
        "/api/analysis?days=7&scope=collection",
        Value::Null,
    )
    .await;
    assert_eq!(collection["stats"]["opened"], 1);
    assert_eq!(collection["stats"]["zones"].as_array().unwrap().len(), 7);
    assert_eq!(
        collection["stats"]["zones"]
            .as_array()
            .unwrap()
            .iter()
            .map(|z| z["bin_count"].as_u64().unwrap())
            .sum::<u64>(),
        50
    );
    assert_eq!(
        collection["stats"]["hourly"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .sum::<u64>(),
        1
    );
    let sorting = send(&app, "GET", "/api/analysis?days=7", Value::Null).await;
    assert_eq!(sorting["stats"]["opened"], 0);
    let id = state["tickets"][0]["id"].as_i64().unwrap();
    let waiting = send(
        &app,
        "POST",
        &format!("/api/tickets/{id}/collect"),
        json!({}),
    )
    .await;
    assert_eq!(waiting["tickets"][0]["status"], "awaiting_verify");
    let done = send(
        &app,
        "POST",
        "/api/sensor",
        event("collection-cleared", "GZ-017", "available", now_ms() + 1),
    )
    .await;
    assert_eq!(done["tickets"][0]["status"], "closed");
}

#[test]
fn old_database_migrates_idempotently_without_resetting_existing_data() {
    let path = std::env::temp_dir().join(format!(
        "campus-migration-{}-{}.sqlite3",
        std::process::id(),
        now_ms()
    ));
    {
        let connection = rusqlite::Connection::open(&path).unwrap();
        connection.execute_batch("CREATE TABLE bins(id TEXT PRIMARY KEY, station_id TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL, observed_at INTEGER);
            INSERT INTO bins VALUES ('a-recycle','a','recycle','full',1234);").unwrap();
    }
    for _ in 0..2 {
        let store = crate::db::Store::open(&path).unwrap();
        let state = serde_json::to_value(store.snapshot().unwrap()).unwrap();
        assert_eq!(state["bins"].as_array().unwrap().len(), 62);
        let original = state["bins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|bin| bin["id"] == "a-recycle")
            .unwrap();
        assert_eq!(original["status"], "full");
        assert_eq!(original["observed_at"], 1234);
    }
    std::fs::remove_file(path).unwrap();
}

#[tokio::test]
async fn shared_model_configuration_requires_sign_in_and_never_exposes_secrets() {
    let locked = test_app_with_access(Access::configured(
        "test-only-not-a-production-passcode",
        true,
    ));
    for path in ["/api/model-config", "/api/model-config/test"] {
        assert_eq!(
            request(
                &locked,
                "POST",
                path,
                json!({"api_key":"test-secret-key","model":"deepseek-flash"})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        request(&locked, "GET", "/api/model-config", Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let app = test_app();
    assert_eq!(
        send(&app, "GET", "/api/model-config", Value::Null).await["configured"],
        false
    );
    let saved = send(
        &app,
        "POST",
        "/api/model-config",
        json!({"api_key":"test-secret-key","model":"deepseek-flash"}),
    )
    .await;
    assert_eq!(saved["configured"], true);
    assert!(!saved.to_string().contains("test-secret-key"));
    let fetched = send(&app, "GET", "/api/model-config", Value::Null).await;
    assert_eq!(fetched, saved);
    send(
        &app,
        "POST",
        "/api/model-config",
        json!({"api_key":"","model":"another-model"}),
    )
    .await;
    assert_eq!(
        send(&app, "GET", "/api/model-config", Value::Null).await["model"],
        "another-model"
    );
    let preview = send(&app, "GET", "/api/analysis?days=7", Value::Null).await;
    assert!(!preview.to_string().contains("test-secret-key"));
}
