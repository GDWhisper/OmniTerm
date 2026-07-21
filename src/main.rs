mod acp;
mod api;
mod auth;
mod embedded;
mod fs;
mod git;
mod models;
mod tmux;
mod utils;
mod workspaces;
mod ws;

use axum::Router;
use axum::body::Body;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use clap::Parser;
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
struct Args {
    /// 监听端口（优先级：CLI > 环境变量 > fallback）
    #[arg(short = 'p', long, env = "BACKEND_PORT", default_value = "9077")]
    port: u16,

    /// 数据库连接字符串
    #[arg(long, env = "DATABASE_URL", default_value = "sqlite:omniterm.db?mode=rwc")]
    db: String,

    /// JWT 签名密钥
    #[arg(long, env = "JWT_SECRET", default_value = "omniterm-default-secret-change-me")]
    jwt_secret: String,
}

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::SqlitePool,
    pub jwt_secret: String,
    pub activity_monitor: tmux::control_mode::SessionActivityMonitor,
    pub acp_supervisor: acp::AcpSupervisor,
}

/// Fallback handler that serves static files from embedded assets.
/// First tries exact file match, then SPA fallback (index.html).
async fn embedded_static_handler(
    uri: axum::http::Uri,
) -> impl IntoResponse {
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("omniterm_dev=debug".parse()?),
        )
        .init();

    let args = Args::parse();

    // tmux 缺失不再阻断启动：ACP runtime 不依赖 tmux。
    // tmux-backed session 会在运行时按需失败并返回错误，前端可查 /system/multiplexer。
    if let Err(e) = tmux::check_multiplexer() {
        tracing::warn!(
            "{} — tmux-backed sessions will fail until installed; ACP sessions unaffected.",
            e
        );
    }

    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&args.db)
        .await?;

    sqlx::migrate!("./migrations").run(&db).await?;

    let activity_monitor =
        tmux::control_mode::SessionActivityMonitor::new(tmux::control_mode::DEFAULT_ACTIVITY_TIMEOUT);

    let state = AppState {
        db,
        jwt_secret: args.jwt_secret,
        activity_monitor,
        acp_supervisor: acp::AcpSupervisor::default(),
    };

    // 启动 ACP 空闲回收看护任务：静默待命超时的 codebuddy --acp 进程会被自动回收，
    // 释放内存（活跃工作中 / 有未决权限的进程不会被回收）。
    let reaper_supervisor = state.acp_supervisor.clone();
    tokio::spawn(async move {
        acp::reaper::run_reaper(reaper_supervisor).await;
    });
    let frontend_dir = std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "frontend/dist".into());

    let app = Router::new()
        .merge(api::routes(state.clone()));

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

    let app = app
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    // ── 绑定 ─────────────────────────────────────────────────
    let host = std::env::var("OMNITERM_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let bind = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| format!("{}:{}", host, args.port));

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
    // 收到退出信号时，先显式回收所有 ACP agent 子进程
    // （codebuddy --acp 等），避免它们被 init 收养成孤儿持续占用内存；
    // 随后 axum 进入优雅关闭。注意：SIGKILL / panic / 崩溃来不及运行，
    // 这类场景产生的孤儿仍需下次启动时由用户手动清理或恢复。
    let shutdown_supervisor = state.acp_supervisor.clone();
    let shutdown_signal = async move {
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
            // Windows 无 POSIX 信号，使用控制台 Ctrl-C 事件触发优雅关闭。
            let _ = tokio::signal::ctrl_c().await;
        }
        info!("shutdown signal received, recycling ACP agent subprocesses");
        shutdown_supervisor.shutdown_all().await;
    };

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal)
        .await?;

    Ok(())
}
