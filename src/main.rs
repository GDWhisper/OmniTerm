mod acp;
mod api;
mod auth;
mod embedded;
mod fs;
mod git;
mod models;
mod presets;
mod tmux;
mod utils;
mod workspaces;
mod ws;

use axum::Router;
use axum::body::Body;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use clap::{Parser, Subcommand};
use sqlx::sqlite::SqlitePoolOptions;
use std::path::Path;
#[cfg(unix)]
use tokio::signal::unix::{self, SignalKind};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "omniterm", version, about = "Web-based tmux terminal manager")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// 启动服务
    Start(StartArgs),
    /// 停止后台运行的服务（通过 PID 文件发 SIGTERM）
    Stop(StopArgs),
    /// 查看服务运行状态
    Status(StatusArgs),
    /// 清空所有用户（忘记密码后，先用此命令再 start 设新密码）
    ResetAuth(ResetAuthArgs),
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

    /// JWT 签名密钥
    #[arg(long, env = "JWT_SECRET", default_value = "omniterm-default-secret-change-me")]
    jwt_secret: String,

    /// 启动前清空所有用户（忘记密码时使用，重启后需重设密码）
    #[arg(long, env = "OMNITERM_RESET_AUTH")]
    reset_auth: bool,
}

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub jwt_secret: String,
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

/// 未指定 `--db` 时，按 binary 名推导：`~/.omniterm/<binary>.db`。
fn default_db_url() -> String {
    let name = std::env::args()
        .next()
        .and_then(|a| Path::new(&a).file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "omniterm".to_string());

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());

    let dir = format!("{}/.omniterm", home);
    let _ = std::fs::create_dir_all(&dir);
    format!("sqlite:{}/{}.db?mode=rwc", dir, name)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("omniterm_dev=debug".parse()?))
        .init();

    let cli = Cli::parse();

    match cli.command {
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
            return Ok(());
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
            #[cfg(unix)]
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
            #[cfg(windows)]
            {
                eprintln!("stop is not supported on Windows");
                std::process::exit(1);
            }
            for _ in 0..100 {
                if !pid_exists(pid) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            if pid_exists(pid) {
                eprintln!("Server did not stop within 10s. Killing forcefully.");
                #[cfg(unix)]
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
            let _ = std::fs::remove_file(&pid_file);
            eprintln!("Stopped.");
            return Ok(());
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
            return Ok(());
        }
        Commands::Start(args) => {
            let db_url = args.db.unwrap_or_else(default_db_url);

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

            // Seed built-in agent presets for commands actually installed on this machine.
            presets::seed_builtin_presets(&db).await;

            if args.reset_auth {
                sqlx::query("DELETE FROM users").execute(&db).await?;
                tracing::warn!("All user accounts deleted. Set a new password via the web UI.");
            }

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
                jwt_secret: args.jwt_secret,
                activity_monitor,
                acp_supervisor: acp::AcpSupervisor::default(),
                agent_watcher: tmux::agent_watch::AgentWatcher::default(),
            };

            // 启动 agent 屏幕检测轮询：周期扫描 tmux 会话前台进程 + 可见屏，
            // 识别 Claude/Codex/Qoder 的 Running/Waiting/Idle 状态（herdr 借鉴，见 docs/reference/herdr-reference.md）。
            tmux::agent_watch::spawn(state.agent_watcher.clone());

            // 启动 ACP 空闲回收看护任务：静默待命超时的 codebuddy --acp 进程会被自动回收，
            // 释放内存（活跃工作中 / 有未决权限的进程不会被回收）。
            let reaper_supervisor = state.acp_supervisor.clone();
            tokio::spawn(async move {
                acp::reaper::run_reaper(reaper_supervisor).await;
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
            let host = std::env::var("OMNITERM_HOST").unwrap_or_else(|_| "127.0.0.1".into());
            let bind =
                std::env::var("BIND_ADDR").unwrap_or_else(|_| format!("{}:{}", host, args.port));

            let listener = tokio::net::TcpListener::bind(&bind).await?;

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

            axum::serve(listener, app).with_graceful_shutdown(shutdown_signal).await?;

            Ok(())
        }
    }
}
