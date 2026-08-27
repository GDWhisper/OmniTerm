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
// 自重启延迟：先让 POST /system/update 的响应完整 flush 回前端（keep-alive
// 连接在 exec 后即断，响应体未读完会触发前端 fetch 异常），再 exec 新二进制。
const RELAUNCH_DELAY: Duration = Duration::from_secs(3);
// 自重启前回收 ACP 子进程的最长等待：shutdown_all 内部依赖子进程退出确认，
// 任一环节卡住会让 exec 永远执行不到且无日志（静默不重启）。超时后放弃等待
// 照常 exec——进程换血优先，残留子进程过继给 init 并留 warn 日志。
const RELAUNCH_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

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
            // 容器环境：一键升级替换的二进制在容器重启后还原为镜像旧版，属无效更新
            "container": update::in_container(),
        })),
    )
}

async fn run_update(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    let Ok(_guard) = UPDATE_LOCK.try_lock() else {
        return (StatusCode::CONFLICT, Json(json!({ "error": "update already in progress" })));
    };

    // 容器内自更新不持久（容器重启还原镜像），Web 端直接拒绝并提示重新拉取镜像
    if update::in_container() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "container_environment" })));
    }

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
        Ok(()) => {
            // 更新成功。Unix 上调度延迟自重启：响应先 flush 回前端（见
            // RELAUNCH_DELAY），随后回收 ACP 子进程并 exec 新二进制（PID 不变，
            // 见 `update::relaunch`）。exec 失败时服务继续跑旧版本，仅留 error
            // 日志，前端倒计时超时后兜底显示手动重启提示。
            #[cfg(unix)]
            let auto_restart = {
                let supervisor = state.acp_supervisor.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(RELAUNCH_DELAY).await;
                    if tokio::time::timeout(RELAUNCH_SHUTDOWN_TIMEOUT, supervisor.shutdown_all())
                        .await
                        .is_err()
                    {
                        tracing::warn!(
                            "ACP shutdown exceeded {:?}, relaunching anyway; stale agent children may linger",
                            RELAUNCH_SHUTDOWN_TIMEOUT,
                        );
                    }
                    if let Err(e) = update::relaunch() {
                        tracing::error!("auto-relaunch failed, restart manually: {e:#}");
                    }
                });
                true
            };
            // Windows 无 exec 等价物（stop 亦不支持），保持手动重启提示
            #[cfg(not(unix))]
            let auto_restart = false;

            (
                StatusCode::OK,
                Json(json!({
                    "status": "updated",
                    "version": release.version.to_string(),
                    "restart_required": true,
                    "auto_restart": auto_restart,
                })),
            )
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": format!("{e:#}") }))),
    }
}
