mod api;
mod auth;
mod fs;
mod git;
mod models;
mod tmux;
mod utils;
mod workspaces;
mod ws;

use axum::Router;
use clap::Parser;
use sqlx::sqlite::SqlitePoolOptions;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

#[derive(Parser)]
#[command(name = "omniterm", version, about = "Web-based tmux terminal manager")]
struct Args {
    /// 监听端口
    #[arg(short = 'p', long, env = "OMNITERM_PORT", default_value = "9077")]
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
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("omniterm_server=debug".parse()?))
        .init();

    let args = Args::parse();

    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&args.db)
        .await?;

    sqlx::migrate!("./migrations").run(&db).await?;

    let state = AppState {
        db,
        jwt_secret: args.jwt_secret,
    };

    // Serve frontend static files; fall back to index.html for SPA routing
    let frontend_dir = std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "frontend/dist".into());
    let static_service = ServeDir::new(&frontend_dir)
        .not_found_service(ServeFile::new(format!("{}/index.html", frontend_dir)));

    let app = Router::new()
        .merge(api::routes(state.clone()))
        .fallback_service(static_service)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    // BIND_ADDR env var still supported for backward compat; CLI --port takes priority
    let host = std::env::var("OMNITERM_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let bind = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| format!("{}:{}", host, args.port));
    tracing::info!("OmniTerm server listening on {}", bind);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
