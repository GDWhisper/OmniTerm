mod acp;
mod api;
mod auth;
mod embedded;
mod fs;
mod git;
mod models;
mod presets;
mod tmux;
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
use axum::response::{IntoResponse, Response};
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
use sqlx::sqlite::SqlitePoolOptions;
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
use std::os::unix::io::AsRawFd;

#[derive(Parser)]
#[command(name = "omniterm", version, about = "Web-based tmux terminal manager")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// 启动服务（默认前台运行；加 -d/--daemonize 可转入后台，Unix only）
    Start(StartArgs),
    /// 停止后台运行的服务（通过 PID 文件发 SIGTERM）
    Stop(StopArgs),
    /// 查看服务运行状态
    Status(StatusArgs),
    /// 清空所有用户（忘记密码后，先用此命令再 start 设新密码）
    ResetAuth(ResetAuthArgs),
    /// 自更新到最新发布版本
    Update(update::UpdateArgs),
}

#[derive(Parser)]
struct StopArgs {
    /// 数据库连接字符串（用于定位 PID 文件）
    #[arg(long, env = "DATABASE_URL")]
    db: Option<String>,
}

#[derive(Parser)]
struct StatusArgs {
    /// 数据库连接字符串（用于定位 PID 文件）
    #[arg(long, env = "DATABASE_URL")]
    db: Option<String>,
}

#[derive(Parser)]
struct ResetAuthArgs {
    /// 数据库连接字符串
    #[arg(long, env = "DATABASE_URL")]
    db: Option<String>,
}

#[derive(Parser)]
struct StartArgs {
    /// 监听端口（优先级：CLI > 环境变量 > fallback）
    #[arg(short = 'p', long, env = "BACKEND_PORT", default_value = "9077")]
    port: u16,

    /// 数据库连接字符串
    #[arg(long, env = "DATABASE_URL")]
    db: Option<String>,

    /// JWT 签名密钥（不设公开默认值；缺省时自动生成随机密钥并持久化到 ~/.omniterm/jwt_secret）
    #[arg(long, env = "JWT_SECRET")]
    jwt_secret: Option<String>,

    /// 强制密码验证开关（覆盖 DB 设置并写回；未指定时用 DB 值）。
    /// Docker/公网部署应显式设为 1：无鉴权时任何能访问端口的人都能完全控制本机。
    #[arg(
        long,
        env = "OMNITERM_AUTH_ENABLED",
        num_args = 0..=1,
        default_missing_value = "true",
        value_parser = parse_bool_flag,
    )]
    auth_enabled: Option<bool>,

    /// 监听地址（默认 127.0.0.1；设为 0.0.0.0 可监听所有网络接口）
    #[arg(short = 'H', long, env = "OMNITERM_HOST", default_value = "127.0.0.1")]
    host: String,

    /// 启动后进入后台运行（Unix only；Windows 不支持）。日志写入 ~/.omniterm/<binary>.log
    #[arg(short = 'd', long)]
    daemonize: bool,

    /// 启动前清空所有用户（忘记密码时使用，重启后需重设密码）
    #[arg(long, env = "OMNITERM_RESET_AUTH")]
    reset_auth: bool,

    /// 强制开启 omniterm 调试日志（等价于 RUST_LOG=omniterm=debug，优先级高于 RUST_LOG 中 omniterm 的级别设置）
    #[arg(long)]
    debug: bool,
}

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub jwt_secret: String,
    /// Password-verification master switch (mirrors `settings.auth_enabled`).
    pub auth_enabled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// ACP 静默待命回收阈值（秒），由 settings 表 `acp_idle_recycle_min` 注入，
    /// reaper 每个 tick 动态读取（运行时热更新）。
    pub acp_idle_recycle_secs: std::sync::Arc<std::sync::atomic::AtomicU64>,
    pub login_guard: auth::LoginGuard,
    pub activity_monitor: tmux::control_mode::SessionActivityMonitor,
    pub acp_supervisor: acp::AcpSupervisor,
    pub agent_watcher: tmux::agent_watch::AgentWatcher,
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
#[cfg(unix)]
fn daemonize(log_file: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::process;

    // 日志文件必须在 fork 前打开并设 0600：fork 后父进程已退出，无法再向前台报错；
    // 日志可能含会话/agent 活动痕迹，权限与 jwt_secret（0600）对齐。
    if let Some(parent) = log_file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let log = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(log_file)?;

    // First fork — detach from terminal
    match unsafe { libc::fork() } {
        -1 => return Err(std::io::Error::last_os_error()),
        0 => {}                // child continues
        _ => process::exit(0), // parent exits
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

    Ok(())
}

fn main() -> anyhow::Result<()> {
    // Parse CLI synchronously *before* initializing the tokio runtime,
    // so daemonization can fork safely.
    let cli_matches = Cli::command().get_matches();
    let cli = Cli::from_arg_matches(&cli_matches)?;

    // `--debug` 由 start 子命令携带（日志初始化在 daemonize 之后，需提前提取）
    let debug_logging = matches!(&cli.command, Commands::Start(args) if args.debug);

    // Daemonize before tokio runtime, if requested
    #[cfg(unix)]
    if let Commands::Start(ref args) = cli.command
        && args.daemonize
    {
        let log_path = daemon_log_path();
        daemonize(&log_path)
            .with_context(|| format!("failed to daemonize (log file: {})", log_path.display()))?;
    }
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

            // tmux 缺失不再阻断启动：ACP runtime 不依赖 tmux。
            // tmux-backed session 会在运行时按需失败并返回错误，前端可查 /system/multiplexer。
            if let Err(e) = tmux::check_multiplexer() {
                tracing::warn!(
                    "{} — tmux-backed sessions will fail until installed; ACP sessions unaffected.",
                    e
                );
            }

            let db = SqlitePoolOptions::new().max_connections(5).connect(&db_url).await?;

            sqlx::migrate!("./migrations").run(&db).await?;

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
            if let Some(parent) = Path::new(&pid_file).parent()
                && !parent.as_os_str().is_empty()
            {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&pid_file, std::process::id().to_string())?;

            let activity_monitor = tmux::control_mode::SessionActivityMonitor::new(
                tmux::control_mode::DEFAULT_ACTIVITY_TIMEOUT,
            );

            let state = AppState {
                db,
                jwt_secret,
                auth_enabled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(auth_enabled)),
                acp_idle_recycle_secs,
                login_guard: auth::LoginGuard::new(),
                activity_monitor,
                acp_supervisor: acp::AcpSupervisor::default(),
                agent_watcher: tmux::agent_watch::AgentWatcher::default(),
            };

            // 启动 agent 屏幕检测轮询：周期扫描 tmux 会话前台进程 + 可见屏，
            // 识别 Claude/Codex/Qoder 的 Running/Waiting/Idle 状态（herdr 借鉴，见 docs/reference/herdr-reference.md）。
            tmux::agent_watch::spawn(state.agent_watcher.clone());

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

            // ── 绑定 ─────────────────────────────────────────────────
            // `BIND_ADDR` 是 dev.sh / docker 的部署层兜底（docker 用它指定 0.0.0.0 host）。
            // 用户显式传了 `-p`/`-H` 时它不得覆盖——否则残留的 dev 环境变量
            // 会劫持正式版用户的端口选择（例如 npm 正式版被 BIND_ADDR=127.0.0.1:9075 劫持）。
            let bind_explicit = cli_matches.subcommand_matches("start").is_some_and(|m| {
                use clap::parser::ValueSource;
                m.value_source("port") == Some(ValueSource::CommandLine)
                    || m.value_source("host") == Some(ValueSource::CommandLine)
            });
            let bind = if bind_explicit {
                format!("{}:{}", args.host, args.port)
            } else {
                std::env::var("BIND_ADDR")
                    .unwrap_or_else(|_| format!("{}:{}", args.host, args.port))
            };

            let listener = tokio::net::TcpListener::bind(&bind).await?;

            // Warning uses the *effective* listen host (BIND_ADDR overrides --host).
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
