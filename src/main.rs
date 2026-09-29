mod acp;
mod agent;
mod api;
mod auth;
mod embedded;
mod engine;
mod fs;
mod git;
mod health;
mod models;
mod presets;
mod process_identity;
mod proxy;

mod update;
mod utils;
mod workspaces;
mod ws;

#[cfg(test)]
mod test_utils;

use anyhow::Context;
use axum::Router;
use axum::body::Body;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::serve::ListenerExt;
use clap::{Parser, Subcommand};
use sqlx::sqlite::SqlitePoolOptions;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use tokio::signal::unix::{self, SignalKind};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[cfg(unix)]
use std::os::unix::io::{AsRawFd, RawFd};

#[derive(Parser)]
#[command(name = "omniterm", version, about = "Web-based terminal session manager")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the server (foreground by default; add -d/--daemonize to run in background, Unix only)
    Start(StartArgs),
    /// Stop the background server (sends SIGTERM via the PID file)
    Stop(StopArgs),
    /// Show server running status
    Status(StatusArgs),
    /// Delete all user accounts (use after forgetting the password, then start to set a new one)
    ResetAuth(ResetAuthArgs),
    /// Self-update to the latest release
    Update(update::UpdateArgs),
}

#[derive(Parser)]
struct StopArgs {
    /// Database connection string (used to locate the PID file)
    #[arg(long, env = "OMNITERM_DB")]
    db: Option<String>,
}

#[derive(Parser)]
struct StatusArgs {
    /// Database connection string (used to locate the PID file)
    #[arg(long, env = "OMNITERM_DB")]
    db: Option<String>,
}

#[derive(Parser)]
struct ResetAuthArgs {
    /// Database connection string
    #[arg(long, env = "OMNITERM_DB")]
    db: Option<String>,
}

#[derive(Parser)]
struct StartArgs {
    /// Listen port (priority: CLI > env > fallback)
    #[arg(short = 'p', long, env = "OMNITERM_PORT", default_value = "9077")]
    port: u16,

    /// Database connection string
    #[arg(long, env = "OMNITERM_DB")]
    db: Option<String>,

    /// JWT signing key (no public default; auto-generates a random per-instance key under ~/.omniterm/ if unset)
    #[arg(long, env = "OMNITERM_JWT_SECRET")]
    jwt_secret: Option<String>,

    /// Force password verification (overrides the DB setting and writes back; DB value used if unset).
    /// Set to 1 for Docker/public deployments: without auth, anyone who can reach the port fully controls this machine.
    #[arg(
        long,
        env = "OMNITERM_AUTH_ENABLED",
        num_args = 0..=1,
        default_missing_value = "true",
        value_parser = parse_bool_flag,
    )]
    auth_enabled: Option<bool>,

    /// Explicitly accept the risk of listening on a non-loopback address with password verification
    /// disabled: without it, startup is refused (fail-closed). Intended for isolated networks where
    /// you deliberately run unauthenticated and control who can reach the port.
    #[arg(
        long,
        env = "OMNITERM_INSECURE_NO_AUTH",
        num_args = 0..=1,
        default_missing_value = "true",
        value_parser = parse_bool_flag,
    )]
    insecure_no_auth: Option<bool>,

    /// Listen address (default 127.0.0.1; set 0.0.0.0 to listen on all interfaces)
    #[arg(short = 'H', long, env = "OMNITERM_HOST", default_value = "127.0.0.1")]
    host: String,

    /// Run in background after startup (Unix only; not supported on Windows). Logs appended to ~/.omniterm/<binary>.log
    #[arg(short = 'd', long)]
    daemonize: bool,

    /// Delete all users before startup (for forgotten passwords; re-set a new password after restart)
    #[arg(long, env = "OMNITERM_RESET_AUTH")]
    reset_auth: bool,

    /// Force omniterm debug logging (equivalent to RUST_LOG=omniterm=debug, takes precedence over the omniterm level in RUST_LOG)
    #[arg(long)]
    debug: bool,

    /// Base domain for subdomain reverse proxy (e.g. `omniterm.lan`). When set, requests to
    /// `{port}.{domain}` are routed to `127.0.0.1:{port}` via the Host header, so absolute-path
    /// SPAs (Next.js/Vite) load correctly. Unset disables subdomain routing (path-prefix only).
    #[arg(long, env = "OMNITERM_PROXY_DOMAIN")]
    proxy_domain: Option<String>,

    /// Max request body size in bytes for the reverse proxy (default 2 MiB). Raise it to proxy
    /// large uploads to the target dev server (e.g. `--proxy-max-body 104857600`).
    #[arg(long, env = "OMNITERM_PROXY_MAX_BODY")]
    proxy_max_body: Option<usize>,

    /// Max total request body size in bytes for file uploads via the file manager
    /// (default 200 MiB; e.g. `--max-upload-body 524288000`).
    #[arg(long, env = "OMNITERM_MAX_UPLOAD_BODY")]
    max_upload_body: Option<usize>,

    /// Extra browser origins allowed to read the API cross-origin (comma-separated,
    /// e.g. `https://term.example.com,http://192.168.1.10:9778`). Same-origin requests
    /// are always allowed without configuring this. Needed when a reverse proxy rewrites
    /// `Host` (nginx default `proxy_set_header Host $proxy_host`), where the browser's
    /// `Origin` no longer matches the `Host` OmniTerm sees. Unset = same-origin only.
    /// Maximum 32 entries, each up to 256 bytes; no derivation, no built-in fallback.
    #[arg(long, env = "OMNITERM_CORS_ALLOWED_ORIGINS")]
    cors_allowed_origins: Option<String>,
}

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub jwt_secret: String,
    /// 本实例的 auth cookie 名（按 db 实例加后缀，见 [`token_cookie_name`]）：
    /// 读写 token 一律用它，避免同 host 下不同实例互相覆盖 cookie。
    pub token_cookie: String,
    /// API keys for ACP agent models (SENSENOVA_API_KEY, STEPFUN_API_KEY, AMD_API_KEY).
    /// Loaded from `~/.omniterm/api_keys.toml` at startup, injected into ACP agent subprocess env.
    pub api_keys: HashMap<String, String>,
    /// Password-verification master switch (mirrors `settings.auth_enabled`).
    pub auth_enabled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// 本地访问是否同样要求密码验证（mirrors `settings.local_auth_required`，D4）。
    /// 仅当 `auth_enabled` 开启时生效：`false` = 本地回环形态免密、远程防线不变。
    pub local_auth_required: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// ACP 静默待命回收阈值（秒），由 settings 表 `acp_idle_recycle_min` 注入，
    /// reaper 每个 tick 动态读取（运行时热更新）。
    pub acp_idle_recycle_secs: std::sync::Arc<std::sync::atomic::AtomicU64>,
    /// 权限请求超时配置（模式 + 秒级阈值），由 settings 表
    /// `acp_perm_timeout_mode` / `acp_perm_timeout_min` 注入，reaper 每个 tick
    /// 动态读取（运行时热更新）。
    pub acp_perm_timeout: std::sync::Arc<acp::reaper::PermissionTimeoutConfig>,
    pub login_guard: auth::LoginGuard,
    /// 会话引擎注册表（D9）：持有复用器引擎 + agent 屏幕检测注册表。
    pub engines: engine::EngineRegistry,
    pub acp_supervisor: acp::AcpSupervisor,
    /// 端口转发反向代理状态：reqwest 客户端单例 + 自身监听端口（防回环）。
    pub proxy: proxy::ProxyState,
    /// 文件上传请求体总量上限（字节），files 路由的 DefaultBodyLimit 与
    /// 流式写入的落盘中止阈值共用此值（见 api::files::MAX_UPLOAD_BODY_DEFAULT）。
    pub max_upload_body: usize,
}

/// Fallback handler that serves static files from embedded assets.
/// First tries exact file match, then SPA fallback (index.html).
async fn embedded_static_handler(uri: axum::http::Uri) -> impl IntoResponse {
    let path = uri.path();
    if let Some((data, mime)) = embedded::serve_embedded(path) {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", mime)
            .body(Body::from(data))
            .unwrap();
    }
    if let Some((data, mime)) = embedded::serve_spa_fallback(path) {
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", mime)
            .body(Body::from(data))
            .unwrap();
    }
    (StatusCode::NOT_FOUND, "Not Found").into_response()
}

/// 从 db 连接串提取 sqlite 文件路径（`sqlite:<path>?<query>` → `<path>`）。
fn db_file_path(db_url: &str) -> &str {
    let path = db_url.strip_prefix("sqlite:").unwrap_or(db_url);
    path.split('?').next().unwrap_or("")
}

fn pid_path(db_url: &str) -> String {
    format!("{}.pid", db_file_path(db_url))
}

/// 进程是否为 `start -d` daemon 形态（daemon 子进程置位）。exec 自重启会剥离
/// argv 里的 `-d`（见 `update::strip_daemon_flag`）但进程仍是 daemon，前端手动
/// 重启提示组装命令时需据此补回 `-d`（见 `update::restart_command`）。
pub static DAEMONIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(unix)]
fn pid_exists(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(not(unix))]
fn pid_exists(_pid: i32) -> bool {
    false
}

/// 按二进制名推导数据文件名（binary 名如 `omniterm-dev`，含 worktree 后缀）。
fn binary_name() -> String {
    std::env::args()
        .next()
        .and_then(|a| Path::new(&a).file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "omniterm".to_string())
}

/// OmniTerm 用户数据目录 `~/.omniterm`（HOME/USERPROFILE 缺失时回退 `.`，与既有约定一致）。
/// db、jwt_secret、daemon 日志统一落盘于此，避免数据与日志分家。
pub(crate) fn omniterm_data_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    Path::new(&home).join(".omniterm")
}

/// 是否判定为开发构建。cargo 产物（debug 构建，或任何 target/ 下的 release）一律按
/// 开发构建处理：无 `--db` 时默认走开发库，绝不静默连正式版库。
fn is_dev_build() -> bool {
    if cfg!(debug_assertions) {
        return true;
    }
    std::env::args()
        .next()
        .map(|a| {
            let parent = Path::new(&a).parent();
            parent.is_some_and(|d| d.ends_with("target/debug") || d.ends_with("target/release"))
        })
        .unwrap_or(false)
}

/// 默认 db / daemon 日志文件名（无后缀）。
///
/// - release 正式安装（npm / crates.io / Docker / cargo install）：按 binary 名推导，
///   正式版连 `~/.omniterm/omniterm.db`（既有行为，不变）。
/// - 开发构建（`cargo run` / `target/debug|release/omniterm` 裸跑，未显式 `--db`）：
///   固定 `omniterm-dev`，落 `~/.omniterm/omniterm-dev.db`。历史事故中 dev/preview
///   的 target/debug 二进制因 Cargo.toml name 统一为 `omniterm` 而按 argv0 推导撞上
///   正式版库并应用新 migration（20260812 / 20260823 两次），从代码层根治。
fn default_db_stem() -> String {
    if is_dev_build() { "omniterm-dev".to_string() } else { binary_name() }
}

/// daemon 模式的日志文件路径：`~/.omniterm/<stem>.log`（与 db / jwt_secret 同目录，
/// 前缀与默认 db 保持一致）。
#[cfg(unix)]
fn daemon_log_path() -> PathBuf {
    omniterm_data_dir().join(format!("{}.log", default_db_stem()))
}

/// 未指定 `--db` 时，按 binary 名推导：`~/.omniterm/<binary>.db`（开发构建走 dev 库，
/// 见 [`default_db_stem`]）。
fn default_db_url() -> String {
    let dir = omniterm_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    format!("sqlite:{}?mode=rwc", dir.join(format!("{}.db", default_db_stem())).display())
}

/// 实例名统一前缀：cookie 名与 JWT 密钥文件名都以它起头。
const INSTANCE_PREFIX: &str = "omniterm";
/// Auth cookie 基础名（正式版历史名，勿改——老用户登录态挂在它上面）。
pub const TOKEN_COOKIE_BASE: &str = "omniterm_token";
/// JWT 密钥基础文件名（正式版历史名，勿改）。
const JWT_SECRET_FILE_BASE: &str = "jwt_secret";

/// 实例标识：由**实际生效的 db**（`--db` / `OMNITERM_DB` / 默认值）的文件名 stem
/// 推导（`omniterm` / `omniterm-dev` / `omniterm-preview`）。
///
/// 「一个 db = 一个实例」是既有约定（dev.sh 用 `BRANCH_BINARY_NAME` 拼 db 路径，
/// docker-compose 用卷内 `omniterm.db`），auth cookie 名与 JWT 密钥据此隔离。
/// 必要性：浏览器 cookie **不区分端口**，同一 host 下 dev(127.0.0.1:9777) 与正式版
/// (0.0.0.0:9077) 若共用 `omniterm_token`，后登录者会覆盖前者的 cookie；若两者
/// 又共用同一签名密钥，被覆盖的那一方只会因 `token_version` 不匹配而 401，
/// 表现为「一边登录、另一边自动登出」（反之若 ver 巧合相等则直接串号登录）。
fn instance_id(db_url: &str) -> String {
    let path = db_file_path(db_url);
    if path.is_empty() || path.contains(":memory:") {
        return default_db_stem();
    }
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_db_stem)
}

/// 实例后缀：剥掉（可选的）`omniterm` 前缀，并清洗为 cookie 名 / 文件名安全字符。
/// 正式版（db 名 `omniterm`）得到**空串** ⇒ 沿用无后缀历史名，已登录用户不掉线；
/// dev / preview 各得 `dev` / `preview`；不含前缀的自定义 db 名整体保留。
fn instance_suffix(instance: &str) -> String {
    let rest = instance.strip_prefix(INSTANCE_PREFIX).unwrap_or(instance);
    rest.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

/// 本实例的 auth cookie 名：`omniterm_token`（正式版）/ `omniterm_token_dev`（dev）。
fn token_cookie_name(suffix: &str) -> String {
    if suffix.is_empty() {
        TOKEN_COOKIE_BASE.to_string()
    } else {
        format!("{TOKEN_COOKIE_BASE}_{suffix}")
    }
}

/// 本实例的 JWT 密钥文件名：`jwt_secret`（正式版）/ `jwt_secret_dev`（dev）。
fn jwt_secret_file_name(suffix: &str) -> String {
    if suffix.is_empty() {
        JWT_SECRET_FILE_BASE.to_string()
    } else {
        format!("{JWT_SECRET_FILE_BASE}_{suffix}")
    }
}

/// Lenient bool parser for `--auth-enabled` / `OMNITERM_AUTH_ENABLED`:
/// clap's built-in bool parser rejects "1"/"0", which is what docker-compose
/// and shell scripts naturally pass.
fn parse_bool_flag(s: &str) -> Result<bool, String> {
    match s.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        other => Err(format!("invalid boolean value '{other}' (expected true/false/1/0)")),
    }
}

/// Resolve the JWT signing secret:
/// - explicit `--jwt-secret` / `JWT_SECRET` wins;
/// - otherwise load `~/.omniterm/<jwt_secret_file_name(suffix)>` (0600),
///   generating and persisting a fresh random secret on first run.
///
/// 密钥**按实例隔离**（suffix 来自 [`instance_suffix`]）：不同实例共用同一密钥时，
/// 一方签发的 token 在另一方签名校验会通过，只剩 `token_version` 兜底——两者巧合
/// 相等即串号登录。正式版 suffix 为空，仍读历史的 `~/.omniterm/jwt_secret`。
///
/// There is deliberately no public default value: a predictable secret is
/// equivalent to no authentication (an attacker can forge admin tokens).
fn resolve_jwt_secret(explicit: Option<String>, suffix: &str) -> anyhow::Result<String> {
    if let Some(s) = explicit {
        if s.trim().is_empty() {
            anyhow::bail!("JWT_SECRET must not be empty");
        }
        return Ok(s);
    }

    let dir = omniterm_data_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(jwt_secret_file_name(suffix));
    let path = path.to_string_lossy().into_owned();

    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim();
        if !existing.is_empty() {
            return Ok(existing.to_string());
        }
    }

    // 256 bits of entropy (two v4 UUIDs).
    let secret = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()).replace('-', "");
    match write_secret_file(&path, &secret) {
        Ok(()) => Ok(secret),
        // Lost a race with a concurrent process that just created the file — reuse it.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let s = std::fs::read_to_string(&path)?.trim().to_string();
            if s.is_empty() {
                anyhow::bail!("jwt secret file {} is empty", path);
            }
            Ok(s)
        }
        Err(e) => Err(e.into()),
    }
}

/// Resolve API keys for ACP agent models.
/// Reads `~/.omniterm/api_keys.toml` (if exists) and returns a map of env-var-name → value.
/// If the file doesn't exist, returns an empty map (no error — models without
/// API key config simply won't have access to the corresponding provider).
/// Keys can also be set via environment variables (backward-compatible with
/// shell export / systemd Environment), taking precedence over the TOML file.
/// Environment variable fallback allows existing dev.sh exports to continue working.
fn resolve_api_keys() -> HashMap<String, String> {
    let mut keys = HashMap::new();

    // 1. Load from TOML config file
    let path = omniterm_data_dir().join("api_keys.toml");
    if let Ok(content) = std::fs::read_to_string(&path)
        && let Ok(parsed) = content.parse::<toml::Table>()
    {
        for (k, v) in parsed {
            if let Some(val) = v.as_str()
                && !val.is_empty()
            {
                keys.insert(k, val.to_string());
            }
        }
        tracing::info!("loaded {} API key(s) from {}", keys.len(), path.display());
    }

    // 2. Environment variables take precedence (allows dev.sh export / systemd Environment)
    for var in ["SENSENOVA_API_KEY", "STEPFUN_API_KEY", "AMD_API_KEY"] {
        if let Ok(val) = std::env::var(var)
            && !val.is_empty()
        {
            keys.insert(var.to_string(), val);
        }
    }

    if !keys.is_empty() {
        let names: Vec<&str> = keys.keys().map(|s| s.as_str()).collect();
        tracing::info!("ACP agent API keys configured: {}", names.join(", "));
    } else {
        tracing::warn!(
            "no ACP model API keys configured (create ~/.omniterm/api_keys.toml or set env vars)"
        );
    }

    keys
}

#[cfg(unix)]
fn write_secret_file(path: &str, secret: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    f.write_all(secret.as_bytes())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_secret_file(path: &str, secret: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(secret.as_bytes())?;
    Ok(())
}

/// Unix daemonization: double-fork + setsid + stdio 重定向。
/// stdin → /dev/null；stdout/stderr → `log_file`（追加模式）。
/// Must be called before the tokio runtime starts (fork safety).
///
/// 日志文件在 fork 前打开：double-fork 后父进程已退出，无法再向用户报告打开失败。
///
/// 通过 pipe 向父进程反馈启动结果：父进程阻塞等待，daemon 子进程完成端口绑定并
/// 写入 PID 文件后调用 `daemon_notify_ready` 通知成功；任何启动失败经
/// `daemon_notify_fail` 透传错误原文给父进程终端。否则 daemon 模式下 stdout/stderr
/// 已重定向到日志，用户对启动失败毫无感知（命令"看似成功"却返回 0）。
///
/// 返回 daemon 子进程持有的 pipe 写端，调用方用 `daemon_notify_ready` /
/// `daemon_notify_fail` 上报结果；前台模式不用此返回值。
#[cfg(unix)]
fn daemonize(log_file: &Path) -> std::io::Result<RawFd> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::process;

    // 日志文件必须在 fork 前打开并设 0600：fork 后父进程已退出，无法再向前台报错；
    // 日志可能含会话/agent 活动痕迹，权限与 jwt_secret（0600）对齐。
    if let Some(parent) = log_file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let log = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(log_file)?;

    // 握手 pipe：父进程据此获知 daemon 是否真正启动成功。
    let mut fds = [0 as RawFd; 2];
    if unsafe { libc::pipe(fds.as_mut_ptr()) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let (read_fd, write_fd) = (fds[0], fds[1]);

    // First fork — detach from terminal
    match unsafe { libc::fork() } {
        -1 => return Err(std::io::Error::last_os_error()),
        0 => unsafe {
            libc::close(read_fd);
        }, // child (P1) keeps write end
        _ => {
            // Parent (P0): 阻塞等 daemon 就绪/失败通知，把结果如实反馈给终端后退出。
            // P0 的 stderr 尚未重定向，eprintln 直达用户终端。
            unsafe { libc::close(write_fd) };
            let mut buf = [0u8; 4096];
            let n =
                unsafe { libc::read(read_fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
            if n > 0 && buf[0] == 1 {
                // daemon 就绪：打印成功消息（含端口/PID），后台启动不再静默
                if n > 1 {
                    let msg = String::from_utf8_lossy(&buf[1..n as usize]);
                    eprintln!("{}", msg);
                } else {
                    eprintln!("OmniTerm started in the background");
                }
                process::exit(0);
            } else if n > 0 && buf[0] == 0 {
                let msg = String::from_utf8_lossy(&buf[1..n as usize]);
                eprintln!("Error: {}", msg);
                process::exit(1);
            } else {
                // 子进程未通知即退出（崩溃）或读取失败
                eprintln!(
                    "Error: server exited before it was ready (see {} for details)",
                    log_file.display()
                );
                process::exit(1);
            }
        }
    }

    // Create new session (become session leader, detach from controlling terminal)
    unsafe {
        libc::setsid();
    }

    // Second fork — ensure we cannot re-acquire a controlling terminal
    match unsafe { libc::fork() } {
        -1 => return Err(std::io::Error::last_os_error()),
        0 => {}                // child continues
        _ => process::exit(0), // intermediate session leader exits
    }

    // Redirect stdin → /dev/null; stdout/stderr → log file
    let devnull = std::fs::OpenOptions::new().read(true).open("/dev/null")?;
    unsafe {
        if libc::dup2(devnull.as_raw_fd(), 0) < 0
            || libc::dup2(log.as_raw_fd(), 1) < 0
            || libc::dup2(log.as_raw_fd(), 2) < 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }

    Ok(write_fd)
}

/// 通知父进程 daemon 启动成功并携带成功消息（如监听端口/PID），由父进程打印到终端。
/// 前台模式 pipe 为 None 时 no-op。
#[cfg(unix)]
fn daemon_notify_ready(pipe_write: Option<RawFd>, msg: &str) {
    if let Some(fd) = pipe_write {
        let body = &msg.as_bytes()[..msg.len().min(4000)];
        let mut buf = Vec::with_capacity(1 + body.len());
        buf.push(1u8);
        buf.extend_from_slice(body);
        unsafe {
            let _ = libc::write(fd, buf.as_ptr() as *const libc::c_void, buf.len());
            libc::close(fd);
        }
    }
}

/// 通知父进程 daemon 启动失败并透传错误信息（daemon 子进程内调用）。
/// 错误原文截断到 4KB，避免 pipe 写阻塞（父进程只读一次）。
#[cfg(unix)]
fn daemon_notify_fail(pipe_write: Option<RawFd>, msg: &str) {
    if let Some(fd) = pipe_write {
        let body = &msg.as_bytes()[..msg.len().min(4000)];
        let mut buf = Vec::with_capacity(1 + body.len());
        buf.push(0u8);
        buf.extend_from_slice(body);
        unsafe {
            let _ = libc::write(fd, buf.as_ptr() as *const libc::c_void, buf.len());
            libc::close(fd);
        }
    }
}

#[cfg(not(unix))]
fn daemon_notify_ready(_pipe_write: (), _msg: &str) {}

#[cfg(not(unix))]
fn daemon_notify_fail(_pipe_write: (), _msg: &str) {}

/// 启动配置只认 `OMNITERM_*` 前缀的环境变量。曾经支持的通用变量名
/// (`BIND_ADDR` / `BACKEND_PORT` / `DATABASE_URL` / `JWT_SECRET`) 一律忽略：
/// 它们会被开发环境或用户自己项目的环境（`DATABASE_URL` 尤其常见）意外继承，
/// 劫持正式版的端口与数据库（实测：npm 正式版在开发实例的终端里启动会被
/// `BIND_ADDR=127.0.0.1:9075` 劫持，报 "Address already in use"）。
/// 仅在检测到残留旧变量时提示改名，不做兼容回退。
fn warn_legacy_env() {
    const RENAMED: &[(&str, &str)] = &[
        ("BIND_ADDR", "OMNITERM_HOST + OMNITERM_PORT"),
        ("BACKEND_PORT", "OMNITERM_PORT"),
        ("DATABASE_URL", "OMNITERM_DB"),
        ("JWT_SECRET", "OMNITERM_JWT_SECRET"),
    ];
    for (legacy, replacement) in RENAMED {
        if std::env::var_os(legacy).is_some() {
            tracing::warn!(
                "ignoring legacy env var {} — omniterm only reads {} now (rename or unset it)",
                legacy,
                replacement
            );
        }
    }
}

/// 检查 RUST_LOG 是否已包含 omniterm target 的 directive（或全局 level）。
/// `--debug` 与 RUST_LOG 兜底逻辑都以此为前置：显式配置未覆盖本 crate 时
/// 追加保底 directive，避免「设置了 RUST_LOG 但写的是别的 crate 名」导致
/// 整个服务零日志（历史踩坑：dev shell 残留旧 crate 名 directive）。
fn rust_log_covers_omniterm(rust_log: Option<&str>) -> bool {
    let Some(rust_log) = rust_log else {
        return false;
    };
    rust_log.split(',').any(|seg| {
        let seg = seg.trim();
        if seg.is_empty() {
            return false;
        }
        // directive 无 `=`：全局 level（trace/debug/info/off/...），覆盖一切 target
        let Some((target, _)) = seg.split_once('=') else {
            return true;
        };
        let target = target.trim();
        target == "omniterm" || target.starts_with("omniterm::") || target.starts_with("omniterm-")
    })
}

fn main() -> anyhow::Result<()> {
    // Parse CLI synchronously *before* initializing the tokio runtime,
    // so daemonization can fork safely.
    let cli = Cli::parse();

    // `--debug` 由 start 子命令携带（日志初始化在 daemonize 之后，需提前提取）
    let debug_logging = matches!(&cli.command, Commands::Start(args) if args.debug);

    // Daemonize before tokio runtime. 父进程阻塞等待 daemon 子进程的就绪/失败握手，
    // 保证 `start -d` 能如实反馈启动结果：失败时错误打印到终端并以非零退出。
    #[cfg(unix)]
    let daemon_pipe: Option<RawFd> = if let Commands::Start(ref args) = cli.command
        && args.daemonize
    {
        let log_path = daemon_log_path();
        let fd =
            Some(daemonize(&log_path).with_context(|| {
                format!("failed to daemonize (log file: {})", log_path.display())
            })?);
        // daemonize() 父进程在其内部握手后已退出，走到这里只可能是 daemon 子进程
        DAEMONIZED.store(true, std::sync::atomic::Ordering::Relaxed);
        fd
    } else {
        None
    };
    #[cfg(not(unix))]
    let daemon_pipe: () = ();
    #[cfg(not(unix))]
    if let Commands::Start(ref args) = cli.command
        && args.daemonize
    {
        anyhow::bail!("--daemonize is only supported on Unix");
    }

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async {
        // EnvFilter 无 catch-all：RUST_LOG 显式设置但不覆盖本 crate（实测：
        // 开发 shell 残留的旧 crate 名 directive 自 daemon 继承，正式版整个
        // 零日志）时，未设置的兜底 `omniterm=info` 不生效。这里在显式过滤
        // 之上强制保底：本 crate 至少 info 可见，其余 target 尊重用户配置。
        let filter = if debug_logging {
            // --debug 显式开启：覆盖 RUST_LOG 中 omniterm 级别的设置，但保留其他 target 的 directive
            EnvFilter::from_default_env().add_directive("omniterm=debug".parse()?)
        } else if rust_log_covers_omniterm(std::env::var("RUST_LOG").ok().as_deref()) {
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("omniterm=info"))
        } else {
            // RUST_LOG 显式设置但不覆盖本 crate（实测：开发 shell 残留的旧 crate 名
            // directive 自 daemon 继承，正式版整个零日志）时，追加兜底 directive：
            // 本 crate 至少 info 可见，其余 target 尊重用户配置（显式 off 的全局
            // 静音会被此兜底顶起，属预期取舍——自重启失败等 error 必须可见）。
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("omniterm=info"))
                .add_directive("omniterm=info".parse()?)
        };
        tracing_subscriber::fmt().with_env_filter(filter).init();

        warn_legacy_env();

        // 启动逻辑整体包一层：daemon 子进程任何启动失败（DB 连接/bind 等）都把错误
        // 原文透传给父进程终端（前台模式 pipe 为 None，notify 为 no-op，错误仍由
        // anyhow 直接打印）。成功路径由 Start 分支在 bind 后显式调用 notify_ready。
        let result: anyhow::Result<()> = async {
            match cli.command {
        Commands::Update(args) => update::run(args).await,
        Commands::ResetAuth(args) => {
            let db_url = args.db.unwrap_or_else(default_db_url);
            let db = SqlitePoolOptions::new().max_connections(1).connect(&db_url).await?;
            sqlx::migrate!("./migrations").run(&db).await?;
            let count: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM users").fetch_one(&db).await?;
            if count == 0 {
                eprintln!("No user accounts to delete.");
                return Ok(());
            }
            sqlx::query("DELETE FROM users").execute(&db).await?;
            eprintln!(
                "Deleted {} user account(s). Start the server with `omniterm start` and set a new password.",
                count
            );
            Ok(())
        }
        Commands::Stop(args) => {
            let db_url = args.db.unwrap_or_else(default_db_url);
            let pid_file = pid_path(&db_url);
            let pid: i32 = match std::fs::read_to_string(&pid_file) {
                Ok(s) => s.trim().parse().unwrap_or(0),
                Err(_) => {
                    eprintln!("Not running (no PID file at {})", pid_file);
                    std::process::exit(1);
                }
            };
            if pid == 0 || !pid_exists(pid) {
                let _ = std::fs::remove_file(&pid_file);
                eprintln!("Server is not running (stale PID file removed).");
                std::process::exit(1);
            }
            // 发信号前归属校验（P1-3，封 stale pidfile + PID 复用误杀盲区，见
            // docs/dev/plans/2026-09-22-tmux-server-shutdown-hang.md §3.2）。谓词
            // 真源 process_identity::pidfile_pid_is_omniterm（dev.sh 的 pidfile kill
            // 有 bash 镜像实现，改一处须同步另一处）。身份只读一次，校验结果贯穿
            // SIGTERM → 轮询 → SIGKILL 升级链全程（其间身份不会变，勿重复读）。
            let ident = crate::process_identity::process_identity(pid as u32);
            if ident.is_none() {
                // 身份读不到（进程已消亡）⇒ 走既有 stale 路径，行为不变
                let _ = std::fs::remove_file(&pid_file);
                eprintln!("Server is not running (stale PID file removed).");
                std::process::exit(1);
            }
            if !crate::process_identity::pidfile_pid_is_omniterm(ident.as_ref()) {
                // 不过校验 ⇒ 不发任何信号，按 stale 处理（删除 pid 文件）后退出
                eprintln!("PID {} 不是 omniterm 进程（疑似 PID 复用），未发送信号", pid);
                let _ = std::fs::remove_file(&pid_file);
                std::process::exit(1);
            }
            #[cfg(windows)]
            {
                eprintln!("stop is not supported on Windows");
                std::process::exit(1);
            }
            // Windows 分支已 exit，后续仅在 unix 编译，避免 unreachable_code
            #[cfg(unix)]
            {
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
                for _ in 0..100 {
                    if !pid_exists(pid) {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
                if pid_exists(pid) {
                    eprintln!("Server did not stop within 10s. Killing forcefully.");
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
                let _ = std::fs::remove_file(&pid_file);
                eprintln!("Stopped.");
                Ok(())
            }
        }
        Commands::Status(args) => {
            let db_url = args.db.unwrap_or_else(default_db_url);
            let pid_file = pid_path(&db_url);
            let pid: i32 = match std::fs::read_to_string(&pid_file) {
                Ok(s) => s.trim().parse().unwrap_or(0),
                Err(_) => {
                    eprintln!("Not running");
                    return Ok(());
                }
            };
            if pid == 0 || !pid_exists(pid) {
                let _ = std::fs::remove_file(&pid_file);
                eprintln!("Not running (stale PID file cleaned)");
                return Ok(());
            }
            eprintln!("Running (PID: {})", pid);
            Ok(())
        }
        Commands::Start(args) => {
            let db_url = args.db.unwrap_or_else(default_db_url);
            // 实例身份取自实际生效的 db（见 instance_id）：cookie 名与 jwt 密钥据此隔离。
            let suffix = instance_suffix(&instance_id(&db_url));
            let jwt_secret = resolve_jwt_secret(args.jwt_secret.clone(), &suffix)?;

            let db = SqlitePoolOptions::new().max_connections(5).connect(&db_url).await?;

            sqlx::migrate!("./migrations").run(&db).await?;

            // 引擎注册表在 DB 就绪后构建：pty 引擎的 cwd 回写任务要更新 sessions 表；
            // 监听端口注入 pty 引擎（spawn 时拼 OMNITERM_HOOK_URL，hook 信道 D7）
            let engines = engine::EngineRegistry::new(db.clone(), args.port);

            // 复用器缺失不再阻断启动：ACP runtime 不依赖它。
            // 复用器会话会在运行时按需失败并返回错误，前端可查 /system/multiplexer。
            if let Err(e) = engines.check_multiplexer() {
                tracing::warn!(
                    "{} — multiplexer-backed sessions will fail until installed; ACP sessions unaffected.",
                    e
                );
            }

            // 启动自愈：进程重启后不可能有进行中的 turn，任何残留的 'streaming' 行
            // 都是被中断的 turn，统一收尾为 'complete'，避免前端把陈旧行当作活跃流。
            if let Err(e) =
                sqlx::query("UPDATE chat_messages SET status = 'complete' WHERE status = 'streaming'")
                    .execute(&db)
                    .await
            {
                tracing::warn!("failed to reconcile orphaned streaming chat messages: {}", e);
            }

            // Seed built-in agent presets for commands actually installed on this machine.
            presets::seed_builtin_presets(&db).await;

            if args.reset_auth {
                sqlx::query("DELETE FROM users").execute(&db).await?;
                tracing::warn!("All user accounts deleted. Set a new password via the web UI.");
            }

            // Password-verification master switch: DB is the source of truth;
            // `OMNITERM_AUTH_ENABLED` (CLI/env) overrides and writes back so the
            // UI and the running flag never diverge.
            let mut auth_enabled =
                sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
                    .bind(auth::SETTING_AUTH_ENABLED)
                    .fetch_optional(&db)
                    .await?
                    .map(|v| v == "1")
                    .unwrap_or(false);
            if let Some(forced) = args.auth_enabled {
                auth_enabled = forced;
                sqlx::query(
                    "INSERT INTO settings (key, value) VALUES (?, ?) \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(auth::SETTING_AUTH_ENABLED)
                .bind(if forced { "1" } else { "0" })
                .execute(&db)
                .await?;
            }

            // 本地免密开关（D4）：DB 是唯一真相源，缺失默认 true（本地也要求密码，
            // 不静默弱化既有部署的姿态）。仅字面量 "0" 关闭；"1" 之外的脏值按 true
            // fail-closed 处理。
            let local_auth_required =
                sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = ?")
                    .bind(auth::SETTING_LOCAL_AUTH_REQUIRED)
                    .fetch_optional(&db)
                    .await?
                    .map(|v| v != "0")
                    .unwrap_or(true);

            // ACP 静默待命回收阈值（分钟）：DB 是唯一真相源，记录缺失/解析失败
            // 回退到 reaper 默认 300 秒（与硬编码时代行为完全一致）。
            let acp_idle_recycle_secs = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key = 'acp_idle_recycle_min'",
            )
            .fetch_optional(&db)
            .await?
            .as_deref()
            .map(|v| acp_idle_recycle_secs_from_setting(Some(v)))
            .unwrap_or(acp::reaper::IDLE_RECYCLE_SECS);
            let acp_idle_recycle_secs = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(
                acp_idle_recycle_secs,
            ));

            // 权限请求超时配置：模式白名单校验（非法值回退 abort），分钟解析
            // 失败回退 30 分钟——DB 无配置时行为与硬编码时代完全一致。
            let acp_perm_timeout = std::sync::Arc::new(
                acp::reaper::PermissionTimeoutConfig::new(
                    permission_timeout_mode_from_setting(
                        sqlx::query_scalar::<_, String>(
                            "SELECT value FROM settings WHERE key = 'acp_perm_timeout_mode'",
                        )
                        .fetch_optional(&db)
                        .await?
                        .as_deref(),
                    ),
                    permission_timeout_secs_from_setting(
                        sqlx::query_scalar::<_, String>(
                            "SELECT value FROM settings WHERE key = 'acp_perm_timeout_min'",
                        )
                        .fetch_optional(&db)
                        .await?
                        .as_deref(),
                    ),
                ),
            );

            let pid_file = pid_path(&db_url);

            // P0-2 启动对账（docs/dev/plans/2026-09-22-tmux-server-shutdown-hang.md）：
            // ① 控制客户端登记表挂到本实例（`<stem>-<pid>.clients`，stem 即实例
            // 身份 = dev.sh 的 BRANCH_BINARY_NAME）；② 扫描**全部**登记文件，杀掉
            // 上一实例/跨实例崩塌残留的 tmux -C 孤儿客户端（pidfd + 三元组谓词，
            // 见 `engine/tmux/client_registry.rs`）。
            let client_registry = engine::tmux::client_registry::init_global(
                &instance_id(&db_url),
                std::process::id(),
            );
            let reconcile_report = engine::tmux::client_registry::reconcile_all();
            if reconcile_report != Default::default() {
                info!(?reconcile_report, "启动对账完成：清理 tmux -C 孤儿控制客户端");
            }

            // 端口转发反向代理客户端：连接超时 5s（连接拒绝/超时快速失败），
            // 不设整体读超时——SSE/长连接/大文件下载需要长生命周期（D5）。
            let proxy_client = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .build()
                .context("failed to build proxy HTTP client")?;

            let state = AppState {
                db,
                jwt_secret,
                token_cookie: token_cookie_name(&suffix),
                api_keys: resolve_api_keys(),
                auth_enabled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(auth_enabled)),
                local_auth_required: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
                    local_auth_required,
                )),
                acp_idle_recycle_secs,
                acp_perm_timeout,
                login_guard: auth::LoginGuard::new(),
                engines,
                acp_supervisor: acp::AcpSupervisor::default(),
                proxy: proxy::ProxyState {
                    client: proxy_client,
                    self_port: args.port,
                    base_host: args.proxy_domain.clone(),
                    max_request_body: args.proxy_max_body.unwrap_or(proxy::MAX_REQUEST_BODY),
                    audited_ports: std::sync::Arc::new(std::sync::Mutex::new(
                        proxy::PortAuditLog::default(),
                    )),
                },
                max_upload_body: args.max_upload_body.unwrap_or(api::files::MAX_UPLOAD_BODY_DEFAULT),
            };

            // 启动 agent 屏幕检测轮询：经引擎注册表枚举活动会话前台进程 + 可见屏，
            // 识别 Claude/Codex/Qoder 的 Running/Waiting/Idle 状态（herdr 借鉴，见 docs/reference/herdr-reference.md）。
            agent::watch::spawn(state.engines.watcher().clone(), state.engines.clone());

            // P1-1/P1-2（docs/dev/plans/2026-09-22-tmux-server-shutdown-hang.md）：
            // 聋 server 检测 + 内建自愈 + 孤儿堆积监控（引擎无关健康模块，ADR D4）。
            health::init_global();
            health::spawn_monitor();

            // 启动 ACP 空闲回收看护任务：静默待命超时的 codebuddy --acp 进程会被自动回收，
            // 释放内存（活跃工作中 / 有未决权限的进程不会被回收）。idle 阈值经
            // `state.acp_idle_recycle_secs` 注入（settings 表可运行时热更新）。
            let reaper_supervisor = state.acp_supervisor.clone();
            let reaper_idle_secs = state.acp_idle_recycle_secs.clone();
            let reaper_perm_timeout = state.acp_perm_timeout.clone();
            let reaper_db = state.db.clone();
            tokio::spawn(async move {
                acp::reaper::run_reaper(
                    reaper_supervisor,
                    reaper_db,
                    reaper_idle_secs,
                    reaper_perm_timeout,
                )
                .await;
            });
            // ── 前端服务 ─────────────────────────────────────────────
            // 文件系统前端仅在显式 FRONTEND_DIR 或 debug 构建时启用（见
            // fs_frontend_source），目录不存在时回退内嵌资源。
            let fs_frontend = fs_frontend_source(
                std::env::var("FRONTEND_DIR").ok(),
                cfg!(debug_assertions),
            )
            .filter(|dir| Path::new(dir).is_dir());
            let dev_mode = fs_frontend.is_some();

            let app = Router::new().merge(api::routes(state.clone()));

            let app = if let Some(dir) = &fs_frontend {
                let static_service = ServeDir::new(dir)
                    .not_found_service(ServeFile::new(format!("{}/index.html", dir)));
                tracing::info!("Serving frontend from {}", dir);
                app.fallback_service(static_service)
            } else {
                tracing::debug!("Serving from embedded assets");
                app.fallback(embedded_static_handler)
            };

            let app = app
                .layer(build_cors_layer(args.cors_allowed_origins.as_deref()))
                .layer(TraceLayer::new_for_http());

            // 子域名代理：仅配置 base_host 时挂最外层 Host 路由中间件。
            // layer 顺序「后加的先执行」，加在 CorsLayer/TraceLayer 之后 = 最外层，
            // 先于 Router/fallback 拦截 `{port}.{base}` 请求；未配置则不挂（避免每请求空跑）。
            let app = if state.proxy.base_host.is_some() {
                app.layer(middleware::from_fn_with_state(state.clone(), proxy::proxy_host_mw))
            } else {
                app
            };

            // ── 绑定 ─────────────────────────────────────────────────
            // 监听地址只由 `-H/--host` + `-p/--port`（含各自的 `OMNITERM_*` env）决定，
            // 不再有部署层 `BIND_ADDR` 兜底：通用变量名会被继承的开发环境劫持。
            let bind = format!("{}:{}", args.host, args.port);

            // 终端是交互式小包流（键盘字节、30fps cell_frame 差分帧、viewport
            // 请求）。开 Nagle 的话，紧随一个大帧发出的小帧要等前一个包的 ACK，
            // 与对端 Delayed ACK（Linux 默认 40ms）叠加后，实测 viewport 请求→
            // 响应的尾延迟 p95 从 5.4ms 涨到 42ms、max 50ms（见
            // `docs/dev/plans/archive/2026-08-28-pty-frame-rle.md` §10.2）。HTTP 响应同理受益。
            let listener = tokio::net::TcpListener::bind(&bind).await?.tap_io(|stream| {
                if let Err(e) = stream.set_nodelay(true) {
                    warn!("failed to set TCP_NODELAY on accepted connection: {e}");
                }
            });

            // PID 文件在 bind 成功后才写入：启动失败（端口被占/DB 连不上）不会留下
            // stale PID 文件，也不会覆盖已在运行实例的 PID 文件（否则 stop 会误杀）。
            if let Some(parent) = Path::new(&pid_file).parent()
                && !parent.as_os_str().is_empty()
            {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&pid_file, std::process::id().to_string())?;

            // 非回环监听 + 鉴权关闭 = 全网裸奔：拒绝启动，除非显式 `--insecure-no-auth`。
            // 纯函数见 enforce_listen_auth（四格真值表有单测）；bail! 经 async 块上抛到
            // main() 的错误处理：前台直接打到 stderr；--daemonize 路径由 daemon_notify_fail
            // 回传父进程并 exit(1)（该路径 stderr 已重定向到日志）。
            //
            // 位置必须在 daemon_notify_ready 之前：否则 daemon 模式会先向父进程报「启动成功」、
            // 再在校验处退出，父进程拿到假成功信号（实测该时序 bug：rc=0 而进程根本没起来）。
            // 放在 bind 之后而非之前：监听地址要等 bind 才知道是否可绑，且端口被占时由 bind
            // 自己报错（更准确），两者不重叠。
            let listen_host = bind.split_once(':').map(|(h, _)| h).unwrap_or(&bind);
            enforce_listen_auth(listen_host, auth_enabled, args.insecure_no_auth.unwrap_or(false))?;

            // daemon 模式：通知父进程启动成功，并附带监听地址/PID 由父进程打印到终端
            // （前台模式 pipe 为 None，no-op，启动提示走下面的 dev/prod 分支）。
            daemon_notify_ready(
                daemon_pipe,
                &format!(
                    "OmniTerm v{} started in the background — http://{} (PID: {})",
                    env!("CARGO_PKG_VERSION"),
                    bind,
                    std::process::id()
                ),
            );

            // ── 启动提示 ──────────────────────────────────────────────
            // dev 模式：详细日志（分支、版本、端口）
            // 生产模式：简洁一行（OmniTerm vX.Y.Z — http://host:port）
            if dev_mode {
                let branch = std::env::var("BRANCH_NAME").unwrap_or_else(|_| "dev".into());
                let version = env!("CARGO_PKG_VERSION");
                info!("starting omniterm branch={} version={}", branch, version);
                tracing::info!("OmniTerm server listening on {}", bind);
            } else {
                eprintln!("OmniTerm v{} — http://{}", env!("CARGO_PKG_VERSION"), bind);
            }

            // ── 优雅退出 ─────────────────────────────────────────────
            // 收到 SIGTERM/SIGINT 时，先显式回收所有 ACP agent 子进程
            // （codebuddy --acp 等），避免它们被 init 收养成孤儿持续占用内存；
            // 随后 axum 进入优雅关闭。注意：SIGKILL / panic / 崩溃来不及运行，
            // 这类场景产生的孤儿仍需下次启动时由用户手动清理或恢复。
            let shutdown_supervisor = state.acp_supervisor.clone();
            let shutdown_registry = client_registry.clone();
            let shutdown_signal = {
                let shutdown_pid = pid_file.clone();
                async move {
                    #[cfg(unix)]
                    {
                        let mut term =
                            unix::signal(SignalKind::terminate()).expect("install SIGTERM handler");
                        let mut int =
                            unix::signal(SignalKind::interrupt()).expect("install SIGINT handler");
                        tokio::select! {
                            _ = term.recv() => {}
                            _ = int.recv() => {}
                        }
                    }
                    #[cfg(windows)]
                    {
                        let _ = tokio::signal::ctrl_c().await;
                    }
                    info!("shutdown signal received, recycling ACP agent subprocesses");
                    shutdown_supervisor.shutdown_all().await;
                    // P0-2 优雅退出注销：删本实例的登记文件（显式 shutdown 路径，
                    // 不挂 Drop——axum 关闭是否 drop AppState 未验证；漏删也会被
                    // 下次启动对账幂等收敛）。
                    shutdown_registry.remove_file();
                    let _ = std::fs::remove_file(&shutdown_pid);
                }
            };

            axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(shutdown_signal)
                .await?;

            Ok(())
        }
    }
        }
        .await;
        if let Err(ref e) = result {
            daemon_notify_fail(daemon_pipe, &format!("{e:#}"));
        }
        result
    })
}

/// 解析 `settings` 表中 ACP 静默待命回收阈值。`acp_idle_recycle_min` 以分钟存储，
/// 换算成秒返回；记录缺失或非数字（解析失败）时回退到 reaper 默认 300 秒，
/// 保证 DB 无该 key 时行为与硬编码常量时代完全一致。抽成纯函数便于单测。
fn acp_idle_recycle_secs_from_setting(setting_min: Option<&str>) -> u64 {
    match setting_min.and_then(|v| v.trim().parse::<u64>().ok()) {
        Some(min) => min.saturating_mul(60),
        None => acp::reaper::IDLE_RECYCLE_SECS,
    }
}

/// 解析 `settings` 表中权限请求超时模式。记录缺失或非白名单值（解析失败）时
/// 回退到默认 `abort`（2026-08-18 起的安全策略）。抽成纯函数便于单测。
fn permission_timeout_mode_from_setting(
    setting: Option<&str>,
) -> acp::reaper::PermissionTimeoutMode {
    setting.and_then(acp::reaper::PermissionTimeoutMode::from_str_opt).unwrap_or_default()
}

/// 解析 `settings` 表中权限请求超时时长（分钟→秒）。记录缺失或非数字（解析
/// 失败）时回退到 reaper 默认 1800 秒，保证 DB 无该 key 时行为与硬编码常量
/// 时代完全一致。抽成纯函数便于单测。
fn permission_timeout_secs_from_setting(setting_min: Option<&str>) -> u64 {
    match setting_min.and_then(|v| v.trim().parse::<u64>().ok()) {
        Some(min) => min.saturating_mul(60),
        None => acp::reaper::REQUIRES_ACTION_RECYCLE_SECS,
    }
}

/// 构造 CORS 层：默认仅同源 + 显式 origin 白名单（S3）。
///
/// 取代此前的 `CorsLayer::permissive()`（对所有来源回 `Access-Control-Allow-Origin: *`）。
/// 三条允许规则与判据真源见 [`crate::ws::cors_policy`]，其中**「无 `Origin` 一律放行」
/// 是框架保证而非谓词功劳**（`AllowOrigin::to_future` 的 `origin.filter(...)`
/// 在 Origin 缺失时不调用 predicate），谓词实际只决定「有 Origin 时放不放」。
///
/// 放进纯函数的理由：判定的三条分支必须可穷举单测（仿 `enforce_listen_auth`），
/// 而 tower-http 的 builder 只有在真实请求经过时才暴露行为。
///
/// **不**设 `allow_credentials(true)`：本项目凭据是 cookie（同源自动携带）或
/// `Authorization: Bearer`。开 credentials 还要求 origin 非 `*`——我们的谓词
/// 已保证这点，但它会把 `ensure_usable_cors_rules` 的组合断言（credentials
/// 不能与 `Any` 的 header/method/origin/expose 并存，否则 `poll_ready` panic）
/// 拉进可能触发的范围，而收益为零：跨源要带 Bearer 必须先过预检，预检本身
/// 已被同源/白名单分支放行。保持 off 让该断言不可能被触发。
fn build_cors_layer(cors_allowed_origins: Option<&str>) -> CorsLayer {
    let allowed: std::sync::Arc<[HeaderValue]> =
        ws::cors_policy::parse_allowed_origins(cors_allowed_origins.unwrap_or("")).into();
    ws::cors_policy::log_cors_policy(&allowed);
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, parts| {
            ws::cors_policy::origin_is_allowed(origin, parts, &allowed)
        }))
        // 显式列出本前端实际用到的 header：`content-type`（JSON 请求体）与
        // `authorization`（Bearer）。不用 `AllowHeaders::any()`——那会把
        // preflight 对所有自定义头放行，正是本轮要收窄的面。
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        // 方法集 = 本服务实际注册的（GET/POST/PUT/PATCH/DELETE，由 src/api/*.rs
        // 的 handler 形态枚举而来）。**不能省**：`AllowMethods` 默认
        // `Const(None)` ⇒ 预检拿不到 `Access-Control-Allow-Methods`，跨源部署下
        // 非简单方法的请求会被浏览器拦在预检上（`cors_layer_preflight_answers_
        // allowed_methods_and_headers` 钉住这一点）。代理路由是 `routing::any`，
        // 但其流量被最外层 `proxy_host_mw` 拦在 CorsLayer 之前，不经过本层。
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE])
    // **不设 max_age**：`MaxAge::exact(ZERO)` 并不「关掉缓存」——它照样
    // 发 `Access-Control-Max-Age: 0` 头（tower-http 0.6.11 `max_age.rs`
    // 的 `Exact(Some(0))` 仍产出头）。真正不发头的方式就是保持默认
    // `MaxAge::default()`（`Exact(None)`），即本处不调用 `.max_age()`。
    // 语义上：max-age > 0 会让浏览器在白名单变更后仍按旧预检结果放行，
    // 排障时难理解；不设则每次 preflight，而本服务的白名单部署本就是
    // 少数场景，成本可忽略（`cors_layer_preflight_omits_max_age` 钉住）。
}

/// 启动期 fail-closed 校验：监听非回环地址 + 鉴权关闭时拒绝启动，除非显式
/// 逃生门 `--insecure-no-auth`。
///
/// 真值表（`Ok` = 允许启动，`Err` = 拒绝）：
///
/// | listen_host | auth_enabled | insecure_no_auth | 结果 |
/// |-------------|--------------|------------------|------|
/// | 127.0.0.1 / ::1 | false | false | Ok（仅本机可达，无暴露面） |
/// | 0.0.0.0 等 | true  | false | Ok（有鉴权保护） |
/// | 0.0.0.0 等 | false | true  | Ok（用户显式接受裸奔风险） |
/// | 0.0.0.0 等 | false | false | **Err**（默认拒绝） |
///
/// 回环判定收敛为 `auth::local_access::is_loopback_host`（2026-09-27 计划 D3：
/// 与本地免密判据同一函数，不许两份实现）；不认识的 host 一律按非回环处理
/// （fail-closed：误判为回环 = 静默暴露，比误拒更危险）。
fn enforce_listen_auth(
    listen_host: &str,
    auth_enabled: bool,
    insecure_no_auth: bool,
) -> anyhow::Result<()> {
    let is_loopback = auth::local_access::is_loopback_host(listen_host);
    if auth_enabled || insecure_no_auth || is_loopback {
        return Ok(());
    }
    anyhow::bail!(
        "监听非回环地址 {} 且密码验证已关闭——任何能访问该端口的人都可完全控制本机。\
         请开启密码验证（设置页，或 --auth-enabled=1 / OMNITERM_AUTH_ENABLED=1），\
         或确认风险后显式加 --insecure-no-auth。",
        listen_host
    )
}

/// 解析文件系统前端来源：显式设置 `FRONTEND_DIR` 优先（Docker 镜像以 ENV 注入；
/// release 二进制亦可自定义前端根），仅 **debug 构建**回退默认相对路径
/// `frontend/dist`（dev.sh 的 cwd=worktree + `pnpm build` 产物）。
///
/// release 二进制不做隐式回退：否则正式版在含 `frontend/dist` 的源码目录启动时
/// 会静默改用本地旧 dist，页面版本号/内容与二进制不符（2026-09-29 实测：正式版
/// 更新到 0.2.26 后页面仍显示 0.2.25）。
fn fs_frontend_source(explicit: Option<String>, debug_build: bool) -> Option<String> {
    explicit.or_else(|| debug_build.then(|| "frontend/dist".into()))
}

#[cfg(test)]
mod tests {
    use super::{
        acp_idle_recycle_secs_from_setting, build_cors_layer, default_db_stem, enforce_listen_auth,
        fs_frontend_source, instance_id, instance_suffix, jwt_secret_file_name,
        permission_timeout_mode_from_setting, permission_timeout_secs_from_setting,
        rust_log_covers_omniterm, token_cookie_name,
    };
    use crate::acp::reaper::{
        IDLE_RECYCLE_SECS, PermissionTimeoutMode, REQUIRES_ACTION_RECYCLE_SECS,
    };
    use axum::body::Body;
    use axum::http::{HeaderMap, HeaderValue, header};
    use tower::ServiceExt;
    use tower_http::cors::CorsLayer;

    #[test]
    fn instance_suffix_separates_dev_from_release() {
        // 正式版（db 名 omniterm）沿用无后缀历史名：已登录用户不掉线
        assert_eq!(instance_suffix("omniterm"), "");
        assert_eq!(token_cookie_name(""), "omniterm_token");
        assert_eq!(jwt_secret_file_name(""), "jwt_secret");
        // 各分支实例各得独立后缀：cookie 键位与密钥文件都不再冲突
        assert_eq!(instance_suffix("omniterm-dev"), "dev");
        assert_eq!(token_cookie_name("dev"), "omniterm_token_dev");
        assert_eq!(jwt_secret_file_name("dev"), "jwt_secret_dev");
        assert_eq!(instance_suffix("omniterm-preview"), "preview");
        // 不含前缀的自定义 db 名整体保留，并清洗为文件名安全字符
        assert_eq!(instance_suffix("my db"), "my_db");
    }

    #[test]
    fn instance_id_follows_effective_db() {
        // dev.sh 显式传 --db：实例取自实际生效的库（能区分同仓库不同 worktree），
        // 而非「是否开发构建」——后者对所有 debug 二进制都返回同一个名字。
        assert_eq!(
            instance_id("sqlite:/home/pax/.omniterm/omniterm-dev.db?mode=rwc"),
            "omniterm-dev"
        );
        assert_eq!(
            instance_id("sqlite:/home/pax/.omniterm/omniterm-preview.db?mode=rwc"),
            "omniterm-preview"
        );
        // docker-compose 的卷内库名不变 ⇒ 沿用历史 cookie 名与密钥文件
        let docker = "sqlite:/app/data/omniterm.db?mode=rwc";
        assert_eq!(instance_id(docker), "omniterm");
        assert_eq!(instance_suffix(&instance_id(docker)), "");
        // 无文件路径的库（内存库）回退默认实例名
        assert_eq!(instance_id("sqlite::memory:"), default_db_stem());
    }

    #[test]
    fn fs_frontend_requires_explicit_dir_in_release_builds() {
        // release 二进制不做隐式回退：否则正式版在源码目录启动时会静默服务
        // 本地旧 dist（2026-09-29：更新到 0.2.26 后页面仍显示 0.2.25 的根因）
        assert_eq!(fs_frontend_source(None, false), None);
        // 显式 FRONTEND_DIR 优先（Docker 镜像 ENV；release 亦可自定义前端根）
        assert_eq!(
            fs_frontend_source(Some("/srv/frontend".into()), false).as_deref(),
            Some("/srv/frontend")
        );
        // debug 构建（dev.sh）回退默认相对路径；显式值仍然优先
        assert_eq!(fs_frontend_source(None, true).as_deref(), Some("frontend/dist"));
        assert_eq!(
            fs_frontend_source(Some("custom/dist".into()), true).as_deref(),
            Some("custom/dist")
        );
    }

    #[test]
    fn missing_setting_falls_back_to_default() {
        assert_eq!(acp_idle_recycle_secs_from_setting(None), IDLE_RECYCLE_SECS);
    }

    #[test]
    fn unparseable_setting_falls_back_to_default() {
        assert_eq!(acp_idle_recycle_secs_from_setting(Some("abc")), IDLE_RECYCLE_SECS);
        assert_eq!(acp_idle_recycle_secs_from_setting(Some("")), IDLE_RECYCLE_SECS);
        assert_eq!(acp_idle_recycle_secs_from_setting(Some("  ")), IDLE_RECYCLE_SECS);
    }

    #[test]
    fn minutes_are_converted_to_seconds() {
        assert_eq!(acp_idle_recycle_secs_from_setting(Some("1")), 60);
        assert_eq!(acp_idle_recycle_secs_from_setting(Some("5")), 300);
        assert_eq!(acp_idle_recycle_secs_from_setting(Some("30")), 1800);
        assert_eq!(acp_idle_recycle_secs_from_setting(Some("  10  ")), 600);
    }

    #[test]
    fn permission_timeout_mode_from_setting_falls_back_to_abort() {
        assert_eq!(permission_timeout_mode_from_setting(None), PermissionTimeoutMode::Abort);
        // 非法值（含大小写不符）回退默认，与白名单校验同一口径。
        for bad in ["", "abc", "Abort", "AUTO"] {
            assert_eq!(
                permission_timeout_mode_from_setting(Some(bad)),
                PermissionTimeoutMode::Abort,
                "bad mode: {bad:?}"
            );
        }
        assert_eq!(
            permission_timeout_mode_from_setting(Some(" auto ")),
            PermissionTimeoutMode::Auto
        );
        assert_eq!(permission_timeout_mode_from_setting(Some("wait")), PermissionTimeoutMode::Wait);
    }

    #[test]
    fn permission_timeout_secs_from_setting_converts_and_falls_back() {
        assert_eq!(permission_timeout_secs_from_setting(None), REQUIRES_ACTION_RECYCLE_SECS);
        assert_eq!(permission_timeout_secs_from_setting(Some("abc")), REQUIRES_ACTION_RECYCLE_SECS);
        assert_eq!(permission_timeout_secs_from_setting(Some("")), REQUIRES_ACTION_RECYCLE_SECS);
        assert_eq!(permission_timeout_secs_from_setting(Some("1")), 60);
        assert_eq!(permission_timeout_secs_from_setting(Some("30")), 1800);
        assert_eq!(permission_timeout_secs_from_setting(Some(" 45 ")), 2700);
    }

    #[test]
    fn rust_log_covering_omniterm_skips_floor() {
        assert!(rust_log_covers_omniterm(Some("omniterm=debug")));
        assert!(rust_log_covers_omniterm(Some("warn,omniterm=info")));
        assert!(rust_log_covers_omniterm(Some("omniterm::engine=debug,sqlx=warn")));
        assert!(rust_log_covers_omniterm(Some("info"))); // 全局 level 覆盖一切 target
    }

    #[test]
    fn rust_log_without_omniterm_target_gets_floor() {
        // 实锤劫持案例：旧仓库双 crate 名 directive（dev shell 残留继承）
        assert!(!rust_log_covers_omniterm(Some("omniterm_main=info,omniterm_server=info")));
        assert!(!rust_log_covers_omniterm(Some("sqlx=warn,tower_http=info")));
        assert!(!rust_log_covers_omniterm(Some(""))); // 无任何 directive 视为未覆盖
        // RUST_LOG 未设置：兜底逻辑本就该生效，此处视为未覆盖
        assert!(!rust_log_covers_omniterm(None));
    }

    /// 四格真值表穷举：非回环 + auth 关 + 无逃生门 = 唯一拒绝组合。
    #[test]
    fn enforce_listen_auth_truth_table() {
        // 仅本机可达：无暴露面，一律放行（含 auth 关 + 无逃生门）
        for host in ["127.0.0.1", "localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1"] {
            assert!(
                enforce_listen_auth(host, false, false).is_ok(),
                "loopback {host} without auth must be allowed"
            );
        }
        // 非回环（IPv4 全网卡 / IPv6 any / 具体 LAN IP）
        for host in ["0.0.0.0", "::", "[::]", "192.168.1.10", "term-dev.tokitoken.com"] {
            // 有鉴权 → 放行
            assert!(
                enforce_listen_auth(host, true, false).is_ok(),
                "non-loopback {host} with auth must be allowed"
            );
            // 显式逃生门 → 放行
            assert!(
                enforce_listen_auth(host, false, true).is_ok(),
                "non-loopback {host} with escape hatch must be allowed"
            );
            // 默认组合 → 拒绝
            assert!(
                enforce_listen_auth(host, false, false).is_err(),
                "non-loopback {host} without auth must be refused"
            );
        }
    }

    /// 逃生门不能在有鉴权时被滥用，也不能反向掩盖（常识护栏）。
    #[test]
    fn enforce_listen_auth_requires_escape_only_when_needed() {
        // 回环 + 显式逃生门：Ok（无害），且不得因逃生门改变 loopback 判定
        assert!(enforce_listen_auth("127.0.0.1", false, true).is_ok());
        // 非回环 + auth 开 + 逃生门：Ok（逃生门不覆盖 auth，两者独立）
        assert!(enforce_listen_auth("0.0.0.0", true, true).is_ok());
    }

    /// 未知/畸形 host 一律按非回环处理（fail-closed：误判为回环 = 静默暴露）。
    #[test]
    fn enforce_listen_auth_unknown_host_fails_closed() {
        assert!(enforce_listen_auth("", false, false).is_err());
        assert!(enforce_listen_auth("example.invalid", false, false).is_err());
        // 带端口写法不应进入本函数（调用方已 split_once 剥离），但仍须按非回环
        assert!(enforce_listen_auth("0.0.0.0:9077", false, false).is_err());
    }

    /// CORS 层真值表：无 Origin 放行 / 同源放行 / 跨源拒 / 白名单放行。
    ///
    /// 只测 [`ws::cors_policy::origin_is_allowed`] 的谓词不足以证明层的行为：
    /// tower-http 的 `AllowOrigin::to_future` 在**请求没有 Origin 头时压根不调用
    /// predicate**（`origin.filter(...)`），这条「无 Origin 一律放行」的保证来自
    /// 框架而非我们的代码。故这里起真实 layer 打真实请求。
    fn cors_headers(layer: &CorsLayer, req: axum::http::Request<Body>) -> HeaderMap {
        let inner = tower::service_fn(|_req: axum::http::Request<Body>| async {
            Ok::<_, std::convert::Infallible>(axum::response::Response::new(Body::empty()))
        });
        let resp = tower::Layer::layer(layer, inner).oneshot(req);
        let resp =
            tokio::runtime::Builder::new_current_thread().build().expect("rt").block_on(resp);
        resp.expect("infallible").headers().clone()
    }

    #[test]
    fn cors_layer_allows_same_origin() {
        let layer = build_cors_layer(None);
        let h = cors_headers(
            &layer,
            axum::http::Request::builder()
                .header(header::HOST, "127.0.0.1:9077")
                .header(header::ORIGIN, "http://127.0.0.1:9077")
                .body(Body::empty())
                .unwrap(),
        );
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("http://127.0.0.1:9077"))
        );
    }

    #[test]
    fn cors_layer_allows_same_origin_different_port() {
        // 端口与 host 一致性判定无关（同 WS 入口口径）：https 反代后前端
        // 443、后端 9777 的情形仍算同源。
        let layer = build_cors_layer(None);
        let h = cors_headers(
            &layer,
            axum::http::Request::builder()
                .header(header::HOST, "omniterm.lan:9777")
                .header(header::ORIGIN, "https://omniterm.lan")
                .body(Body::empty())
                .unwrap(),
        );
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("https://omniterm.lan"))
        );
    }

    #[test]
    fn cors_layer_allows_proxy_subdomain_origin() {
        // 代理子域形态（{port}.{base_host}）：Origin 与 Host 同 host。
        let layer = build_cors_layer(None);
        let h = cors_headers(
            &layer,
            axum::http::Request::builder()
                .header(header::HOST, "3000.omniterm.lan:9777")
                .header(header::ORIGIN, "http://3000.omniterm.lan:9777")
                .body(Body::empty())
                .unwrap(),
        );
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("http://3000.omniterm.lan:9777"))
        );
    }

    #[test]
    fn cors_layer_rejects_cross_site() {
        let layer = build_cors_layer(None);
        let h = cors_headers(
            &layer,
            axum::http::Request::builder()
                .header(header::HOST, "127.0.0.1:9077")
                .header(header::ORIGIN, "https://evil.com")
                .body(Body::empty())
                .unwrap(),
        );
        // 不回 Allow-Origin ⇒ 浏览器读不到响应（请求本身仍执行，这是 CORS 的
        // 边界：它是「读取权」防线，不是「执行权」防线）。
        assert_eq!(h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN), None);
    }

    #[test]
    fn cors_layer_allows_whitelisted_origin_with_mismatched_host() {
        // nginx 默认 `proxy_set_header Host $proxy_host`：浏览器 Origin 是
        // term.example.com，而后端看到的 Host 是上游名 ⇒ 同源判定必失败，
        // 白名单是唯一活路。
        let layer = build_cors_layer(Some("https://term.example.com"));
        let h = cors_headers(
            &layer,
            axum::http::Request::builder()
                .header(header::HOST, "omniterm:9777")
                .header(header::ORIGIN, "https://term.example.com")
                .body(Body::empty())
                .unwrap(),
        );
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("https://term.example.com"))
        );
    }

    #[test]
    fn cors_layer_still_rejects_unlisted_origin_when_allowlist_set() {
        // 配了白名单不能顺带放开别的来源（并集语义：白名单是「额外允许」）。
        let layer = build_cors_layer(Some("https://term.example.com"));
        let h = cors_headers(
            &layer,
            axum::http::Request::builder()
                .header(header::HOST, "omniterm:9777")
                .header(header::ORIGIN, "https://other.example.com")
                .body(Body::empty())
                .unwrap(),
        );
        assert_eq!(h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN), None);
    }

    #[test]
    fn cors_layer_allows_request_without_origin() {
        // **框架保证而非我们的谓词**：`AllowOrigin::to_future` 在 Origin 缺失时
        // 直接返回 None，predicate 不被调用。这里钉住该行为——若未来误换成
        // 自己写的 middleware 判定，无 Origin 的 curl/脚本会被打死。
        let layer = build_cors_layer(None);
        let h = cors_headers(
            &layer,
            axum::http::Request::builder()
                .header(header::HOST, "127.0.0.1:9077")
                .body(Body::empty())
                .unwrap(),
        );
        // 无 Origin ⇒ 无 Allow-Origin 头，但请求照常通过（inner service 被调用）。
        assert_eq!(h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN), None);
    }

    #[test]
    fn cors_layer_preflight_answers_allowed_methods_and_headers() {
        // preflight 必须真的回答，否则前端带 content-type 的 POST（全部 JSON
        // 接口）在跨源白名单部署下会被浏览器拦在预检上。
        //
        // 注意断言的是**整个配置集的字面值**而非预检请求里请求的那个值：
        // `AllowMethods`/`AllowHeaders` 用 `Const`（非 `mirror_request`）时返回
        // 配置集全量，这是有意为之——预检回答「服务支持什么」而非「你要什么」，
        // 浏览器自行判断自己那个请求是否落在集合内。
        let layer = build_cors_layer(Some("https://term.example.com"));
        let h = cors_headers(
            &layer,
            axum::http::Request::builder()
                .method("OPTIONS")
                .header(header::HOST, "omniterm:9777")
                .header(header::ORIGIN, "https://term.example.com")
                .header("access-control-request-method", "POST")
                .header("access-control-request-headers", "content-type")
                .body(Body::empty())
                .unwrap(),
        );
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("https://term.example.com"))
        );
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_METHODS),
            Some(&HeaderValue::from_static("GET,POST,PUT,PATCH,DELETE"))
        );
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_HEADERS),
            Some(&HeaderValue::from_static("content-type,authorization"))
        );
    }

    #[test]
    fn cors_layer_preflight_rejects_cross_site() {
        // 跨源 preflight 也必须被拒：否则攻击页面能凭预检成功推断「该 origin 被
        // 允许」，且浏览器后续请求同样拿不到放行头。
        let layer = build_cors_layer(None);
        let h = cors_headers(
            &layer,
            axum::http::Request::builder()
                .method("OPTIONS")
                .header(header::HOST, "127.0.0.1:9077")
                .header(header::ORIGIN, "https://evil.com")
                .header("access-control-request-method", "POST")
                .body(Body::empty())
                .unwrap(),
        );
        assert_eq!(h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN), None);
    }

    #[test]
    fn cors_layer_preflight_omits_max_age() {
        // **不发** `Access-Control-Max-Age`（而非发 0）：`MaxAge::exact(ZERO)`
        // 照样产出该头（tower-http 0.6.11 `max_age.rs` 的 `Exact(Some(0))`），
        // 唯一不发的办法就是保持默认、不调用 `.max_age()`。不发的理由：白名单
        // 变更后浏览器不得按旧的预检结果继续放行，排障时行为才可预测。
        let layer = build_cors_layer(Some("https://term.example.com"));
        let h = cors_headers(
            &layer,
            axum::http::Request::builder()
                .method("OPTIONS")
                .header(header::HOST, "omniterm:9777")
                .header(header::ORIGIN, "https://term.example.com")
                .header("access-control-request-method", "POST")
                .body(Body::empty())
                .unwrap(),
        );
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("https://term.example.com"))
        );
        assert_eq!(h.get(header::ACCESS_CONTROL_MAX_AGE), None);
    }

    /// 错误信息必须给出补救动作（开启 auth 或加逃生门），否则用户无法自救。
    #[test]
    fn enforce_listen_auth_error_mentions_remedies() {
        let err =
            enforce_listen_auth("0.0.0.0", false, false).expect_err("must refuse").to_string();
        assert!(err.contains("--auth-enabled"), "{err}");
        assert!(err.contains("--insecure-no-auth"), "{err}");
        assert!(err.contains("0.0.0.0"), "{err}");
    }
}
