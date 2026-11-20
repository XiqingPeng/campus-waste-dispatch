use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::{AppState, api, now_ms, vision::Vision};

fn test_app() -> Router {
    Router::new().nest(
        "/api",
        api(AppState::open(":memory:".as_ref(), Vision::default()).unwrap()),
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
            .all(|bin| bin["status"] == "available")
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
