mod acp;
mod agent;
mod api;
mod auth;
mod embedded;
mod engine;
mod fs;
mod git;
mod models;
mod presets;
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
use axum::http::StatusCode;
use axum::middleware;
use axum::response::{IntoResponse, Response};
use clap::{Parser, Subcommand};
use sqlx::sqlite::SqlitePoolOptions;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use tokio::signal::unix::{self, SignalKind};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::info;
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

    /// JWT signing key (no public default; auto-generates a random key persisted to ~/.omniterm/jwt_secret if unset)
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
}

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub jwt_secret: String,
    /// API keys for ACP agent models (SENSENOVA_API_KEY, STEPFUN_API_KEY, AMD_API_KEY).
    /// Loaded from `~/.omniterm/api_keys.toml` at startup, injected into ACP agent subprocess env.
    pub api_keys: HashMap<String, String>,
    /// Password-verification master switch (mirrors `settings.auth_enabled`).
    pub auth_enabled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// ACP 静默待命回收阈值（秒），由 settings 表 `acp_idle_recycle_min` 注入，
    /// reaper 每个 tick 动态读取（运行时热更新）。
    pub acp_idle_recycle_secs: std::sync::Arc<std::sync::atomic::AtomicU64>,
    pub login_guard: auth::LoginGuard,
    /// 会话引擎注册表（D9）：持有复用器引擎 + agent 屏幕检测注册表。
    pub engines: engine::EngineRegistry,
    pub acp_supervisor: acp::AcpSupervisor,
    /// 端口转发反向代理状态：reqwest 客户端单例 + 自身监听端口（防回环）。
    pub proxy: proxy::ProxyState,
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

fn pid_path(db_url: &str) -> String {
    let path = db_url.strip_prefix("sqlite:").unwrap_or(db_url);
    let path = path.split('?').next().unwrap_or("");
    format!("{}.pid", path)
}

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
fn omniterm_data_dir() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    Path::new(&home).join(".omniterm")
}

/// daemon 模式的日志文件路径：`~/.omniterm/<binary>.log`（与 db / jwt_secret 同目录）。
#[cfg(unix)]
fn daemon_log_path() -> PathBuf {
    omniterm_data_dir().join(format!("{}.log", binary_name()))
}

/// 未指定 `--db` 时，按 binary 名推导：`~/.omniterm/<binary>.db`。
fn default_db_url() -> String {
    let dir = omniterm_data_dir();
    let _ = std::fs::create_dir_all(&dir);
    format!("sqlite:{}?mode=rwc", dir.join(format!("{}.db", binary_name())).display())
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
/// - otherwise load `~/.omniterm/jwt_secret` (0600), generating and
///   persisting a fresh random secret on first run.
///
/// There is deliberately no public default value: a predictable secret is
/// equivalent to no authentication (an attacker can forge admin tokens).
fn resolve_jwt_secret(explicit: Option<String>) -> anyhow::Result<String> {
    if let Some(s) = explicit {
        if s.trim().is_empty() {
            anyhow::bail!("JWT_SECRET must not be empty");
        }
        return Ok(s);
    }

    let dir = omniterm_data_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("jwt_secret");
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

fn main() -> anyhow::Result<()> {
    // Parse CLI synchronously *before* initializing the tokio runtime,
    // so daemonization can fork safely.
    let cli = Cli::parse();

    // `--debug` 由 start 子命令携带（日志初始化在 daemonize 之后，需提前提取）
    let debug_logging = matches!(&cli.command, Commands::Start(args) if args.debug);

    // Daemonize before tokio runtime. 父进程阻塞等待 daemon 子进程的就绪/失败握手，
    // 保证 `start -d` 能如实反馈启动结果：失败时错误打印到终端并以非零退出。
    #[cfg(unix)]
    let daemon_pipe: Option<RawFd> =
        if let Commands::Start(ref args) = cli.command
            && args.daemonize
        {
            let log_path = daemon_log_path();
            Some(daemonize(&log_path).with_context(|| {
                format!("failed to daemonize (log file: {})", log_path.display())
            })?)
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
        let filter = if debug_logging {
            // --debug 显式开启：覆盖 RUST_LOG 中 omniterm 级别的设置，但保留其他 target 的 directive
            EnvFilter::from_default_env().add_directive("omniterm=debug".parse()?)
        } else {
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("omniterm=info"))
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
            let jwt_secret = resolve_jwt_secret(args.jwt_secret.clone())?;

            let db = SqlitePoolOptions::new().max_connections(5).connect(&db_url).await?;

            sqlx::migrate!("./migrations").run(&db).await?;

            // 引擎注册表在 DB 就绪后构建：pty 引擎的 cwd 回写任务要更新 sessions 表
            let engines = engine::EngineRegistry::new(db.clone());

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
            let mut auth_enabled = sqlx::query_scalar::<_, String>(
                "SELECT value FROM settings WHERE key = 'auth_enabled'",
            )
            .fetch_optional(&db)
            .await?
            .map(|v| v == "1")
            .unwrap_or(false);
            if let Some(forced) = args.auth_enabled {
                auth_enabled = forced;
                sqlx::query(
                    "INSERT INTO settings (key, value) VALUES ('auth_enabled', ?) \
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                )
                .bind(if forced { "1" } else { "0" })
                .execute(&db)
                .await?;
            }

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

            let pid_file = pid_path(&db_url);

            // 端口转发反向代理客户端：连接超时 5s（连接拒绝/超时快速失败），
            // 不设整体读超时——SSE/长连接/大文件下载需要长生命周期（D5）。
            let proxy_client = reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(5))
                .build()
                .context("failed to build proxy HTTP client")?;

            let state = AppState {
                db,
                jwt_secret,
                api_keys: resolve_api_keys(),
                auth_enabled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(auth_enabled)),
                acp_idle_recycle_secs,
                login_guard: auth::LoginGuard::new(),
                engines,
                acp_supervisor: acp::AcpSupervisor::default(),
                proxy: proxy::ProxyState {
                    client: proxy_client,
                    self_port: args.port,
                    base_host: args.proxy_domain.clone(),
                    max_request_body: args.proxy_max_body.unwrap_or(proxy::MAX_REQUEST_BODY),
                },
            };

            // 启动 agent 屏幕检测轮询：经引擎注册表枚举活动会话前台进程 + 可见屏，
            // 识别 Claude/Codex/Qoder 的 Running/Waiting/Idle 状态（herdr 借鉴，见 docs/reference/herdr-reference.md）。
            agent::watch::spawn(state.engines.watcher().clone(), state.engines.clone());

            // 启动 ACP 空闲回收看护任务：静默待命超时的 codebuddy --acp 进程会被自动回收，
            // 释放内存（活跃工作中 / 有未决权限的进程不会被回收）。idle 阈值经
            // `state.acp_idle_recycle_secs` 注入（settings 表可运行时热更新）。
            let reaper_supervisor = state.acp_supervisor.clone();
            let reaper_idle_secs = state.acp_idle_recycle_secs.clone();
            tokio::spawn(async move {
                acp::reaper::run_reaper(reaper_supervisor, reaper_idle_secs).await;
            });
            let frontend_dir =
                std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "frontend/dist".into());

            let app = Router::new().merge(api::routes(state.clone()));

            // Serve frontend: filesystem in dev mode, embedded in release mode
            // ── 前端服务 ─────────────────────────────────────────────
            // 检测运行模式：前端目录存在 = dev 模式（前后端分离），否则 = 生产模式（内嵌前端）
            let dev_mode = Path::new(&frontend_dir).is_dir();

            let app = if dev_mode {
                let static_service = ServeDir::new(&frontend_dir)
                    .not_found_service(ServeFile::new(format!("{}/index.html", frontend_dir)));
                tracing::info!("Serving frontend from {}", frontend_dir);
                app.fallback_service(static_service)
            } else {
                tracing::debug!("Serving from embedded assets");
                app.fallback(embedded_static_handler)
            };

            let app = app.layer(CorsLayer::permissive()).layer(TraceLayer::new_for_http());

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

            let listener = tokio::net::TcpListener::bind(&bind).await?;

            // PID 文件在 bind 成功后才写入：启动失败（端口被占/DB 连不上）不会留下
            // stale PID 文件，也不会覆盖已在运行实例的 PID 文件（否则 stop 会误杀）。
            if let Some(parent) = Path::new(&pid_file).parent()
                && !parent.as_os_str().is_empty()
            {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&pid_file, std::process::id().to_string())?;

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

            // 非回环监听 = 全网暴露，鉴权关闭时必须醒目告警。
            let listen_host = bind.split_once(':').map(|(h, _)| h).unwrap_or(&bind);
            let is_loopback = matches!(listen_host, "127.0.0.1" | "localhost" | "::1" | "[::1]");
            if !auth_enabled && !is_loopback {
                tracing::warn!(
                    "密码验证已关闭且监听非回环地址 {} — 任何能访问该端口的人都可完全控制本机。\
                     请在设置中开启密码验证，或设置环境变量 OMNITERM_AUTH_ENABLED=1。",
                    listen_host
                );
            }

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

#[cfg(test)]
mod tests {
    use super::acp_idle_recycle_secs_from_setting;
    use crate::acp::reaper::IDLE_RECYCLE_SECS;

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
}
