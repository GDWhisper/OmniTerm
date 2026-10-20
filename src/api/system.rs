use axum::{
    Json, Router,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use semver::Version;
use serde::Deserialize;
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::AppState;
use crate::auth::local_access::is_local_request;
use crate::fs::{self, SortKey};
use crate::native_picker::{self, PickError, PickOutcome};
use crate::update;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/system/info", get(system_info))
        .route("/system/dirs", get(list_dirs))
        .route("/system/exists", get(check_exists))
        .route("/system/pick-directory", post(pick_directory))
        .route("/system/multiplexer", get(multiplexer_status))
        .route("/system/tmux/mouse", get(get_mouse_mode).post(set_mouse_mode))
        .route("/system/version", get(version_check))
        .route("/system/update", post(run_update))
        .route("/system/restart", post(run_restart))
}

#[derive(Deserialize)]
struct PickDirectoryRequest {
    /// 仅作为对话框起始目录；不存在时后端回溯到最近存在的祖先目录。
    #[serde(default)]
    initial_dir: Option<String>,
}

/// 调起运行 OmniTerm 的机器上的系统目录选择器。
///
/// 只在浏览器与后端同机时有意义：远程访问时对话框会开在服务器上，用户既看不到
/// 也无法操作。故复用本地免密判据（`is_local_request`）显式拒绝远程请求。
async fn pick_directory(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<PickDirectoryRequest>,
) -> (StatusCode, Json<Value>) {
    if !is_local_request(&headers, Some(addr)) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                // 稳定协议值：前端据此把提示本地化（勿只按 403 判断——
                // auth 中间件也可能返回 403）。
                "code": "native_picker_local_only",
                "error": "The native folder picker is only available when OmniTerm is opened locally (localhost). Use the directory browser in the dialog instead."
            })),
        );
    }

    // 单飞：系统对话框是模态的，并发请求只会叠加窗口。
    let Ok(_guard) = native_picker::PICK_LOCK.try_lock() else {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "A folder picker is already open." })),
        );
    };

    let initial = req
        .initial_dir
        .as_deref()
        .filter(|path| path.len() <= native_picker::MAX_INITIAL_DIR_BYTES)
        .map(Path::new);

    match native_picker::pick_directory(initial).await {
        Ok(PickOutcome::Selected(path)) => {
            (StatusCode::OK, Json(json!({ "path": path.to_string_lossy() })))
        }
        Ok(PickOutcome::Cancelled) => (StatusCode::OK, Json(json!({ "cancelled": true }))),
        Err(error) => {
            // HTTP 响应只回到当前标签页；daemon 日志是远程实例唯一的事后证据。
            eprintln!("omniterm-picker: {error:?}");
            let (status, message) = match error {
                PickError::Unsupported(message) => (StatusCode::NOT_IMPLEMENTED, message),
                PickError::TimedOut => (
                    StatusCode::GATEWAY_TIMEOUT,
                    "The folder picker timed out without a selection.".to_string(),
                ),
                PickError::Failed(message) => (StatusCode::INTERNAL_SERVER_ERROR, message),
            };
            (status, Json(json!({ "error": message })))
        }
    }
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

// 成功缓存 15min：版本探测的价值在于「发布后尽快告知」，1h 缓存会让新版本在发布后
// 近一小时仍返回旧值；上游已按渠道降级，不再依赖 GitHub 匿名配额。
const VERSION_CACHE_TTL: Duration = Duration::from_secs(15 * 60);
// 失败负缓存：防止刷新页面连环触发上游探测（GitHub 匿名限流 60 次/时/IP）
const VERSION_CACHE_NEG_TTL: Duration = Duration::from_secs(5 * 60);
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
static RELAUNCH_TARGET: Mutex<Option<PathBuf>> = Mutex::const_new(None);
static PENDING_RESTART: AtomicBool = AtomicBool::new(false);
static TARGET_VERSION: Mutex<Option<String>> = Mutex::const_new(None);

/// 持锁查询 latest 版本：命中 TTL 内缓存直接返回，否则打 GitHub API 并回填。
///
/// GitHub API 失败（匿名配额 403 / 不可达）时按渠道降级到该渠道自己的版本源
/// （`update::fetch_latest_version`）：npm/cargo 的安装源与 GitHub releases 页都
/// 不受 60 次/时/IP 的匿名配额限制。降级成功按正常结果缓存 15min；降级也失败才
/// 回填错误（负缓存 5min），并 `eprintln` 两个源的具体错误——HTTP 响应只回到当前
/// 标签页，daemon 日志是远程实例唯一的事后取证来源。
async fn cached_latest(channel: update::Channel) -> Result<Version, String> {
    let mut cache = VERSION_CACHE.lock().await;
    if let Some(entry) = cache.as_ref() {
        let ttl = if entry.result.is_ok() { VERSION_CACHE_TTL } else { VERSION_CACHE_NEG_TTL };
        if entry.at.elapsed() < ttl {
            return entry.result.clone();
        }
    }
    let result = match update::fetch_latest().await {
        Ok(r) => Ok(r.version),
        Err(primary) => match update::fetch_latest_version(channel).await {
            Ok(version) => {
                eprintln!(
                    "omniterm-update: GitHub API check failed ({primary:#}); {channel:?} fallback reports v{version}"
                );
                Ok(version)
            }
            Err(fallback) => {
                eprintln!(
                    "omniterm-update: version check failed on both sources: GitHub API: {primary:#}; {channel:?} fallback: {fallback:#}"
                );
                Err(format!("{primary:#}"))
            }
        },
    };
    *cache = Some(CacheEntry { at: Instant::now(), result: result.clone() });
    result
}

async fn version_check() -> (StatusCode, Json<Value>) {
    let current = env!("CARGO_PKG_VERSION");
    // 渠道判定先于版本查询：降级源按渠道选择（npm/cargo 安装源 / releases 页）
    let channel = match update::current_exe_channel() {
        Ok((_, c)) => c,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })));
        }
    };
    let latest = match cached_latest(channel).await {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_GATEWAY, Json(json!({ "error": e }))),
    };
    let update_available = match Version::parse(current) {
        Ok(cur) => latest > cur,
        Err(_) => false,
    };
    let pending_restart = PENDING_RESTART.load(Ordering::Relaxed);
    let target_version = TARGET_VERSION.lock().await.clone();
    (
        StatusCode::OK,
        Json(json!({
            "current": current,
            "latest": latest.to_string(),
            "update_available": update_available,
            "channel": channel,
            // 容器环境：一键升级替换的二进制在容器重启后还原为镜像旧版，属无效更新
            "container": update::in_container(),
            // 忠实复现本进程启动形态的重启命令（前端手动重启提示用，见 update::restart_command）
            "restart_command": update::restart_command(
                &std::env::args_os().collect::<Vec<_>>(),
                crate::DAEMONIZED.load(std::sync::atomic::Ordering::Relaxed),
            ),
            "pending_restart": pending_restart,
            "target_version": target_version,
            "restart_supported": cfg!(unix),
        })),
    )
}

async fn run_update(State(_state): State<AppState>) -> (StatusCode, Json<Value>) {
    let Ok(_guard) = UPDATE_LOCK.try_lock() else {
        return (StatusCode::CONFLICT, Json(json!({ "error": "update already in progress" })));
    };

    // 容器内自更新不持久（容器重启还原镜像），Web 端直接拒绝并提示重新拉取镜像
    if update::in_container() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "container_environment" })));
    }

    if PENDING_RESTART.load(Ordering::Relaxed) {
        let ver = TARGET_VERSION
            .lock()
            .await
            .clone()
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());
        return (
            StatusCode::OK,
            Json(json!({
                "status": "updated",
                "version": ver,
                "restart_required": true,
                "restart_supported": cfg!(unix),
                "auto_restart": false,
            })),
        );
    }

    let current = match Version::parse(env!("CARGO_PKG_VERSION")) {
        Ok(v) => v,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })));
        }
    };
    let (exe, channel) = match update::current_exe_channel() {
        Ok(v) => v,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })));
        }
    };
    // 升级前强制 fresh 查询，避免缓存期内版本已变。npm 渠道的升级不依赖 assets
    // （走 npm install），GitHub API 限流时用渠道版本源拿到 latest 即可继续；
    // 其余渠道保持原明确报错（github_release 的自替换需要 assets，cargo 不支持一键）。
    let release = match update::fetch_latest().await {
        Ok(r) => r,
        Err(primary) => {
            if channel == update::Channel::Npm {
                match update::fetch_latest_version(channel).await {
                    Ok(version) => update::LatestRelease::version_only(version),
                    Err(_) => {
                        return (
                            StatusCode::BAD_GATEWAY,
                            Json(json!({ "error": format!("{primary:#}") })),
                        );
                    }
                }
            } else {
                return (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("{primary:#}") })));
            }
        }
    };
    if release.version <= current {
        return (StatusCode::CONFLICT, Json(json!({ "error": "already up to date" })));
    }

    let result = match channel {
        update::Channel::Cargo => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "unsupported_channel" })));
        }
        update::Channel::Npm => {
            match tokio::time::timeout(
                UPDATE_TIMEOUT,
                npm_upgrade_and_verify(&exe, &release.version),
            )
            .await
            {
                Err(_) => {
                    return (
                        StatusCode::GATEWAY_TIMEOUT,
                        Json(json!({ "error": "npm install timed out" })),
                    );
                }
                Ok(Ok(())) => Ok(()),
                Ok(Err(e)) => Err(e),
            }
        }
        update::Channel::GithubRelease => update::self_replace(&exe, &release).await,
    };

    match result {
        Ok(()) => {
            // 更新成功。记录待重启状态、目标版本以及捕获的可执行文件路径。
            // 重启时机选择权交给用户（前端提供手动重启按钮），不自动调度自重启。
            *RELAUNCH_TARGET.lock().await = Some(exe);
            PENDING_RESTART.store(true, Ordering::Relaxed);
            *TARGET_VERSION.lock().await = Some(release.version.to_string());

            #[cfg(unix)]
            let restart_supported = true;
            #[cfg(not(unix))]
            let restart_supported = false;

            (
                StatusCode::OK,
                Json(json!({
                    "status": "updated",
                    "version": release.version.to_string(),
                    "restart_required": true,
                    "restart_supported": restart_supported,
                    "auto_restart": false,
                })),
            )
        }
        Err(e) => {
            // 升级失败必须留痕：HTTP 响应只回到当前标签页，daemon 日志是远程实例
            // 唯一的事后取证来源（历史上 exec 失败的 error 曾被 EnvFilter 吞掉，
            // 排查无从下手；eprintln 绕过 EnvFilter 直写 stderr → 日志文件）。
            eprintln!("omniterm-update: update failed: {e:#}");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": format!("{e:#}") })))
        }
    }
}

/// npm 升级 + 装后校验；用户配置的 registry 失败时自动用官方源重试一次。
///
/// 镜像同步是逐包异步的：主包已更新、某个平台包（optionalDependencies 分发二进制）
/// 仍停留在旧版本时，npm 会静默跳过这个 optional dep 并以 0 退出——结果是旧二进制
/// 被删、新二进制缺失，比升级失败更糟（命令行直接不可用）。校验失败（缺二进制或
/// 版本未变）后必须自动换官方源重装，不能只把「手动重装」写进错误信息。
///
/// 退出码 0 只代表命令跑完；多 node 安装并存时 npm 还可能把包装进别的 prefix，
/// 也只有版本校验能发现（见 `update::npm_upgrade_args` 的 `--prefix` 说明）。
async fn npm_upgrade_and_verify(exe: &Path, expected: &Version) -> anyhow::Result<()> {
    let primary = match update::npm_upgrade(exe).await {
        Ok(_) => update::verify_installed_version(exe, expected).await,
        Err(e) => Err(e),
    };
    let Err(primary_err) = primary else {
        return Ok(());
    };
    eprintln!(
        "omniterm-update: npm upgrade via the configured registry failed, retrying the official registry: {primary_err:#}"
    );
    update::npm_upgrade_from_official(exe).await?;
    update::verify_installed_version(exe, expected).await.map_err(|retry_err| {
        anyhow::anyhow!(
            "npm upgrade failed via the configured registry ({primary_err:#}) and the \
             official-registry retry ({retry_err:#})"
        )
    })
}

async fn run_restart(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    // 仅 unix 分支在 spawn 的任务里移动持有此锁（防重启竞态），Windows 分支
    // 不使用——下划线命名让无锁分支不产生 unused 警告（发版 Windows job 实测）。
    let Ok(_guard) = UPDATE_LOCK.try_lock() else {
        return (StatusCode::CONFLICT, Json(json!({ "error": "update already in progress" })));
    };

    #[cfg(unix)]
    {
        let target = RELAUNCH_TARGET.lock().await;
        let exe = match target.as_ref() {
            Some(p) => p.clone(),
            None => match update::current_exe_channel() {
                Ok((p, _)) => p,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({ "error": e.to_string() })),
                    );
                }
            },
        };

        let supervisor = state.acp_supervisor.clone();
        tokio::spawn(async move {
            let _guard = _guard;
            tokio::time::sleep(RELAUNCH_DELAY).await;
            if tokio::time::timeout(RELAUNCH_SHUTDOWN_TIMEOUT, supervisor.shutdown_all())
                .await
                .is_err()
            {
                eprintln!(
                    "omniterm-update: ACP shutdown exceeded {RELAUNCH_SHUTDOWN_TIMEOUT:?}, relaunching anyway; stale agent children may linger"
                );
            }
            if let Err(e) = update::relaunch(&exe) {
                eprintln!("omniterm-update: manual-relaunch failed, restart manually: {e:#}");
            }
        });

        (StatusCode::OK, Json(json!({ "status": "restarting" })))
    }
    #[cfg(not(unix))]
    {
        let _ = state;
        (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "unsupported_platform",
                "message": "automatic restart is not supported on this platform"
            })),
        )
    }
}

#[cfg(test)]
mod picker_tests {
    use super::*;
    use axum::http::{HeaderValue, header};

    fn loopback_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:9777"));
        headers
    }

    fn loopback_peer() -> ConnectInfo<SocketAddr> {
        ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 50_000)))
    }

    fn request() -> Json<PickDirectoryRequest> {
        Json(PickDirectoryRequest { initial_dir: None })
    }

    #[tokio::test]
    async fn rejects_non_loopback_peer() {
        let peer = ConnectInfo(SocketAddr::from(([192, 168, 5, 216], 50_000)));
        let (status, body) = pick_directory(peer, loopback_headers(), request()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body.0["code"].as_str(), Some("native_picker_local_only"));
    }

    #[tokio::test]
    async fn rejects_non_loopback_host() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("omniterm.example.com"));
        let (status, _) = pick_directory(loopback_peer(), headers, request()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn rejects_proxy_forwarded_requests() {
        let mut headers = loopback_headers();
        headers.insert("x-forwarded-for", HeaderValue::from_static("1.2.3.4"));
        let (status, _) = pick_directory(loopback_peer(), headers, request()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn rejects_a_second_concurrent_picker() {
        let _held = native_picker::PICK_LOCK.lock().await;
        let (status, _) = pick_directory(loopback_peer(), loopback_headers(), request()).await;
        assert_eq!(status, StatusCode::CONFLICT);
    }
}
