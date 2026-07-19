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

    // ACP 会话跨重启无法恢复：supervisor 是内存 HashMap，重启后旧 ACP
    // session 的 AcpClient 已不存在，前端若试图连这些 session 会收到
    // "ACP session not found" 并一直显示错误横幅。启动时把孤儿 ACP 行删
    // 掉，让用户从干净状态重新开始。tmux session 不受影响（tmux daemon
    // 跨重启存活，可通过 adopt 流程重新接入）。
    let stale_acp = sqlx::query("DELETE FROM sessions WHERE runtime_kind = 'acp'")
        .execute(&db)
        .await?;
    if stale_acp.rows_affected() > 0 {
        tracing::info!(
            "purged {} stale ACP session(s) on startup (supervisor does not survive restarts)",
            stale_acp.rows_affected()
        );
    }

    let activity_monitor =
        tmux::control_mode::SessionActivityMonitor::new(tmux::control_mode::DEFAULT_ACTIVITY_TIMEOUT);

    let state = AppState {
        db,
        jwt_secret: args.jwt_secret,
        activity_monitor,
        acp_supervisor: acp::AcpSupervisor::default(),
    };
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

    axum::serve(listener, app).await?;

    Ok(())
}
