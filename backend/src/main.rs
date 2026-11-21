mod access;
mod analysis;
mod db;
mod model_settings;
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
    http::{HeaderMap, StatusCode, header},
    middleware,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use tower_http::services::{ServeDir, ServeFile};

use access::{Access, Login, Status as AccessStatus};
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
    model_settings: model_settings::ModelSettings,
    access: Access,
}

impl AppState {
    fn open(
        path: &Path,
        vision: Vision,
        analysis: Analysis,
        access: Access,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        Ok(Self {
            store: Arc::new(Store::open(path)?),
            vision,
            model_settings: model_settings::ModelSettings::open(path, analysis.credentials())?,
            access,
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
        .route(
            "/access",
            get(access_status)
                .post(access_login)
                .layer(DefaultBodyLimit::max(1024)),
        )
        .route("/access/logout", post(access_logout))
        .route(
            "/model-config",
            get(model_config)
                .post(save_model_config)
                .layer(DefaultBodyLimit::max(2048)),
        )
        .route(
            "/model-config/test",
            post(test_model_config).layer(DefaultBodyLimit::max(2048)),
        )
        .route("/sensor", post(sensor))
        .route("/tickets/{id}/collect", post(collect))
        .route("/demo/reset", post(reset))
        .route(
            "/demo/connectivity",
            post(connectivity).layer(DefaultBodyLimit::max(1024)),
        )
        .route(
            "/analysis",
            get(analysis_preview)
                .post(analyze)
                .layer(DefaultBodyLimit::max(1024)),
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

async fn access_status(State(state): State<AppState>, headers: HeaderMap) -> Json<AccessStatus> {
    state.access.status(&headers)
}

async fn access_login(
    State(state): State<AppState>,
    input: Result<Json<Login>, JsonRejection>,
) -> Result<(HeaderMap, Json<AccessStatus>), ApiError> {
    let Json(input) = input?;
    state.access.login(input)
}

async fn access_logout(State(state): State<AppState>) -> (HeaderMap, Json<AccessStatus>) {
    state.access.logout()
}

async fn sensor(
    State(state): State<AppState>,
    headers: HeaderMap,
    input: Result<Json<SensorReport>, JsonRejection>,
) -> Result<Json<Snapshot>, ApiError> {
    state.access.require(&headers)?;
    let Json(event) = input?;
    state.store.sensor(event, now_ms()).map(Json)
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectivityInput {
    #[serde(default = "connectivity_scope")]
    scope: String,
    target: String,
    online: bool,
}

fn connectivity_scope() -> String {
    "bin".into()
}

async fn connectivity(
    State(state): State<AppState>,
    headers: HeaderMap,
    input: Result<Json<ConnectivityInput>, JsonRejection>,
) -> Result<Json<Snapshot>, ApiError> {
    state.access.require(&headers)?;
    let Json(input) = input?;
    state
        .store
        .connectivity(&input.target, input.online, &input.scope, now_ms())
        .map(Json)
}

async fn collect(
    State(state): State<AppState>,
    RoutePath(id): RoutePath<i64>,
    headers: HeaderMap,
) -> Result<Json<Snapshot>, ApiError> {
    state.access.require(&headers)?;
    state.store.collect(id, now_ms()).map(Json)
}

async fn reset(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Snapshot>, ApiError> {
    state.access.require(&headers)?;
    state.store.reset().map(Json)
}

async fn recognize(
    State(state): State<AppState>,
    headers: HeaderMap,
    input: Result<Json<Recognize>, JsonRejection>,
) -> Result<Json<Recognition>, ApiError> {
    let Json(input) = input?;
    if input.is_live() {
        state.access.require(&headers)?;
    }
    state.vision.recognize(input).await.map(Json)
}

async fn model_config(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<model_settings::ConfigStatus>, ApiError> {
    state.access.require(&headers)?;
    state.model_settings.status().map(Json)
}

async fn save_model_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    input: Result<Json<model_settings::ConfigInput>, JsonRejection>,
) -> Result<Json<model_settings::ConfigStatus>, ApiError> {
    state.access.require(&headers)?;
    state.model_settings.save(input?.0).map(Json)
}

async fn test_model_config(
    State(state): State<AppState>,
    headers: HeaderMap,
    input: Result<Json<model_settings::ConfigInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    state.access.require(&headers)?;
    let credentials = state.model_settings.draft(input?.0)?;
    Analysis::configured(Some(credentials))?
        .test_connection()
        .await?;
    Ok(Json(json!({"ok": true})))
}

async fn analyze(
    State(state): State<AppState>,
    headers: HeaderMap,
    input: Result<Json<AnalysisRequest>, JsonRejection>,
) -> Result<Json<Report>, ApiError> {
    state.access.require(&headers)?;
    let Json(input) = input?;
    let snapshot = state.store.snapshot()?;
    Analysis::configured(state.model_settings.credentials()?)?
        .report(snapshot, input, now_ms(), true)
        .await
        .map(Json)
}

async fn analysis_preview(
    State(state): State<AppState>,
    Query(input): Query<AnalysisRequest>,
) -> Result<Json<Report>, ApiError> {
    let snapshot = state.store.snapshot()?;
    Analysis::configured(state.model_settings.credentials()?)?
        .report(snapshot, input, now_ms(), false)
        .await
        .map(Json)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let railway = env::var_os("RAILWAY_ENVIRONMENT_ID").is_some();
    let access = Access::from_env(railway)?;
    let default_address = if railway {
        format!(
            "0.0.0.0:{}",
            env::var("PORT").unwrap_or_else(|_| "8080".to_owned())
        )
    } else {
        "127.0.0.1:8080".to_owned()
    };
    let address: SocketAddr = env::var("WASTE_BIND").unwrap_or(default_address).parse()?;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let database = if railway {
        let mount = env::var_os("RAILWAY_VOLUME_MOUNT_PATH")
            .filter(|value| !value.is_empty())
            .ok_or("Attach a persistent Railway volume before starting Campus Loop")?;
        PathBuf::from(mount).join("campus-waste.sqlite3")
    } else {
        env::var_os("WASTE_DB_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("data/campus-waste.sqlite3"))
    };
    if let Some(parent) = database
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)?;
    }
    let web_root = env::var_os("WASTE_WEB_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("frontend/dist"));
    let state = AppState::open(
        &database,
        Vision::from_env()?,
        Analysis::from_env()?,
        access,
    )?;
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
