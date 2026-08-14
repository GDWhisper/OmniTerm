use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use semver::Version;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::AppState;
use crate::fs::{self, SortKey};
use crate::update;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/system/info", get(system_info))
        .route("/system/dirs", get(list_dirs))
        .route("/system/exists", get(check_exists))
        .route("/system/multiplexer", get(multiplexer_status))
        .route("/system/tmux/mouse", get(get_mouse_mode).post(set_mouse_mode))
        .route("/system/version", get(version_check))
        .route("/system/update", post(run_update))
}

#[derive(Deserialize)]
struct ListDirsQuery {
    path: String,
}

async fn system_info(State(state): State<AppState>) -> Json<Value> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".into());

    Json(json!({
        "home_dir": home,
        // 平台终端复用器名称（按平台编译期确定），供前端 UI 文案使用
        "multiplexer": state.engines.multiplexer_name(),
        // 子域名代理 base（`--proxy-domain`）；`null` = 未启用，前端据此决定是否生成子域名 URL
        "proxy_domain": state.proxy.base_host,
    }))
}

/// List directory entries for a given absolute path.
///
/// Used by the new-project modal to let users browse the filesystem
/// before they have any project/workspace context. Returns ALL entries
/// (directories and files); the frontend filters to directories only.
async fn list_dirs(
    State(_state): State<AppState>,
    Query(q): Query<ListDirsQuery>,
) -> (axum::http::StatusCode, Json<Value>) {
    let path = std::path::Path::new(&q.path);

    // Canonicalize to resolve `..` and symlinks; reject non-existent paths.
    let canonical = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return (axum::http::StatusCode::NOT_FOUND, Json(json!({ "error": "path not found" })));
        }
    };

    if !canonical.is_dir() {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({ "error": "not a directory" })));
    }

    match fs::list_dir(&canonical, "", SortKey::Name, false).await {
        Ok(entries) => (axum::http::StatusCode::OK, Json(json!({ "files": entries }))),
        Err(e) => {
            (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
        }
    }
}

#[derive(Deserialize)]
struct ExistsQuery {
    path: String,
}

/// Check if a path exists on disk.
/// Used by the frontend to detect stale project paths.
async fn check_exists(Query(q): Query<ExistsQuery>) -> (StatusCode, Json<Value>) {
    let exists = std::path::Path::new(&q.path).exists();
    (StatusCode::OK, Json(json!({ "exists": exists })))
}

async fn multiplexer_status(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    match state.engines.check_multiplexer() {
        Ok(()) => (StatusCode::OK, Json(json!({ "available": true }))),
        Err(e) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({
                "available": false,
                "error": e.to_string(),
                "install_hints": state.engines.multiplexer_install_hints(),
            })),
        ),
    }
}

async fn get_mouse_mode(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    match state.engines.mouse_enabled().await {
        Ok(enabled) => (StatusCode::OK, Json(json!({ "enabled": enabled }))),
        Err(e) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": e.to_string() }))),
    }
}

async fn set_mouse_mode(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let enabled = body.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
    match state.engines.set_mouse_enabled(enabled).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true, "enabled": enabled }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() }))),
    }
}

const VERSION_CACHE_TTL: Duration = Duration::from_secs(3600);
// 失败负缓存：防止刷新页面连环触发 GitHub 匿名限流（60 次/时/IP）
const VERSION_CACHE_NEG_TTL: Duration = Duration::from_secs(300);
const UPDATE_TIMEOUT: Duration = Duration::from_secs(300);

struct CacheEntry {
    at: Instant,
    result: Result<Version, String>,
}

static VERSION_CACHE: Mutex<Option<CacheEntry>> = Mutex::const_new(None);
static UPDATE_LOCK: Mutex<()> = Mutex::const_new(());

/// 持锁查询 latest 版本：命中 TTL 内缓存直接返回，否则打 GitHub API 并回填。
async fn cached_latest() -> Result<Version, String> {
    let mut cache = VERSION_CACHE.lock().await;
    if let Some(entry) = cache.as_ref() {
        let ttl = if entry.result.is_ok() { VERSION_CACHE_TTL } else { VERSION_CACHE_NEG_TTL };
        if entry.at.elapsed() < ttl {
            return entry.result.clone();
        }
    }
    let result = update::fetch_latest().await.map(|r| r.version).map_err(|e| format!("{e:#}"));
    *cache = Some(CacheEntry { at: Instant::now(), result: result.clone() });
    result
}

async fn version_check() -> (StatusCode, Json<Value>) {
    let current = env!("CARGO_PKG_VERSION");
    let latest = match cached_latest().await {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    };
    let channel = match update::current_exe_channel() {
        Ok((_, c)) => c,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })));
        }
    };
    let update_available = match Version::parse(current) {
        Ok(cur) => latest > cur,
        Err(_) => false,
    };
    (
        StatusCode::OK,
        Json(json!({
            "current": current,
            "latest": latest.to_string(),
            "update_available": update_available,
            "channel": channel,
        })),
    )
}

async fn run_update() -> (StatusCode, Json<Value>) {
    let Ok(_guard) = UPDATE_LOCK.try_lock() else {
        return (StatusCode::CONFLICT, Json(json!({ "error": "update already in progress" })));
    };

    let current = match Version::parse(env!("CARGO_PKG_VERSION")) {
        Ok(v) => v,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })));
        }
    };
    // 升级前强制 fresh 查询，避免缓存期内版本已变
    let release = match update::fetch_latest().await {
        Ok(r) => r,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("{e:#}") }))),
    };
    if release.version <= current {
        return (StatusCode::CONFLICT, Json(json!({ "error": "already up to date" })));
    }

    let (exe, channel) = match update::current_exe_channel() {
        Ok(v) => v,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })));
        }
    };

    let result = match channel {
        update::Channel::Cargo => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "unsupported_channel" })));
        }
        update::Channel::Npm => {
            match tokio::time::timeout(
                UPDATE_TIMEOUT,
                update::delegate_captured("npm", update::NPM_UPGRADE_ARGS),
            )
            .await
            {
                Err(_) => {
                    return (
                        StatusCode::GATEWAY_TIMEOUT,
                        Json(json!({ "error": "npm install timed out" })),
                    );
                }
                Ok(r) => r.map(|_| ()),
            }
        }
        update::Channel::GithubRelease => update::self_replace(&exe, &release).await,
    };

    match result {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({
                "status": "updated",
                "version": release.version.to_string(),
                "restart_required": true,
            })),
        ),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": format!("{e:#}") }))),
    }
}
