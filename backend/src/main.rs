mod analysis;
mod db;
mod vision;

use std::{
    env, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, PoisonError},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path as RoutePath, Query, State, rejection::JsonRejection},
    http::{StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use tower_http::services::{ServeDir, ServeFile};

use analysis::{Analysis, AnalysisRequest, Report};
use db::{Guidance, GuidanceQuery, SensorReport, Snapshot, Store};
use vision::{Recognition, Recognize, Vision};

#[derive(Debug)]
struct ApiError(StatusCode, &'static str);

impl ApiError {
    const fn new(status: StatusCode, message: &'static str) -> Self {
        Self(status, message)
    }

    const fn bad_request(message: &'static str) -> Self {
        Self(StatusCode::BAD_REQUEST, message)
    }

    fn store_lock<T>(_error: PoisonError<T>) -> Self {
        Self(StatusCode::INTERNAL_SERVER_ERROR, "无法访问状态库")
    }
}

impl From<rusqlite::Error> for ApiError {
    fn from(error: rusqlite::Error) -> Self {
        eprintln!("SQLite: {error}");
        Self(StatusCode::INTERNAL_SERVER_ERROR, "状态库操作失败")
    }
}

impl From<JsonRejection> for ApiError {
    fn from(error: JsonRejection) -> Self {
        Self(error.status(), "请求 JSON 格式错误或内容过大")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

#[derive(Clone)]
struct AppState {
    store: Arc<Store>,
    vision: Vision,
    analysis: Analysis,
}

impl AppState {
    fn open(path: &Path, vision: Vision, analysis: Analysis) -> rusqlite::Result<Self> {
        Ok(Self {
            store: Arc::new(Store::open(path)?),
            vision,
            analysis,
        })
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn api(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/state", get(snapshot))
        .route("/guidance", get(guidance))
        .route("/sensor", post(sensor))
        .route("/tickets/{id}/collect", post(collect))
        .route("/demo/reset", post(reset))
        .route(
            "/analysis",
            post(analyze).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/recognize",
            post(recognize).layer(DefaultBodyLimit::max(1_500_000)),
        )
        .fallback(async || ApiError::new(StatusCode::NOT_FOUND, "找不到该接口"))
        .layer(middleware::map_response(async |mut response: Response| {
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
            response
        }))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({ "status": "ok", "live_vision": state.vision.configured() }))
}

async fn snapshot(State(state): State<AppState>) -> Result<Json<Snapshot>, ApiError> {
    state.store.snapshot().map(Json)
}

async fn guidance(
    State(state): State<AppState>,
    Query(query): Query<GuidanceQuery>,
) -> Result<Json<Guidance>, ApiError> {
    state.store.guidance(query).map(Json)
}

async fn sensor(
    State(state): State<AppState>,
    input: Result<Json<SensorReport>, JsonRejection>,
) -> Result<Json<Snapshot>, ApiError> {
    let Json(event) = input?;
    state.store.sensor(event, now_ms()).map(Json)
}

async fn collect(
    State(state): State<AppState>,
    RoutePath(id): RoutePath<i64>,
) -> Result<Json<Snapshot>, ApiError> {
    state.store.collect(id, now_ms()).map(Json)
}

async fn reset(State(state): State<AppState>) -> Result<Json<Snapshot>, ApiError> {
    state.store.reset().map(Json)
}

async fn recognize(
    State(state): State<AppState>,
    input: Result<Json<Recognize>, JsonRejection>,
) -> Result<Json<Recognition>, ApiError> {
    let Json(input) = input?;
    state.vision.recognize(input).await.map(Json)
}

async fn analyze(
    State(state): State<AppState>,
    input: Result<Json<AnalysisRequest>, JsonRejection>,
) -> Result<Json<Report>, ApiError> {
    let Json(input) = input?;
    let snapshot = state.store.snapshot()?;
    state
        .analysis
        .report(snapshot, input.days, now_ms())
        .await
        .map(Json)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let address: SocketAddr = env::var("WASTE_BIND")
        .unwrap_or_else(|_| "127.0.0.1:8080".to_owned())
        .parse()?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let database = env::var_os("WASTE_DB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("data/campus-waste.sqlite3"));
    if let Some(parent) = database
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    let web_root = env::var_os("WASTE_WEB_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("frontend/dist"));
    let state = AppState::open(&database, Vision::from_env()?, Analysis::from_env()?)?;
    let app = Router::new().nest("/api", api(state)).fallback_service(
        ServeDir::new(&web_root).fallback(ServeFile::new(web_root.join("index.html"))),
    );
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("校园垃圾分类与清运 http://{}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
