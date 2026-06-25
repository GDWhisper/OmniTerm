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
use sqlx::sqlite::SqlitePoolOptions;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

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

    let database_url = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:omniterm.db?mode=rwc".into());

    let db = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;

    sqlx::migrate!("./migrations").run(&db).await?;

    let jwt_secret = std::env::var("JWT_SECRET").unwrap_or_else(|_| "omniterm-default-secret-change-me".into());

    let state = AppState { db, jwt_secret };

    // Serve frontend static files; fall back to index.html for SPA routing
    let frontend_dir = std::env::var("FRONTEND_DIR").unwrap_or_else(|_| "frontend/dist".into());
    let static_service = ServeDir::new(&frontend_dir)
        .not_found_service(ServeFile::new(format!("{}/index.html", frontend_dir)));

    let app = Router::new()
        .merge(api::routes(state.clone()))
        .fallback_service(static_service)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:9777".into());
    tracing::info!("OmniTerm server listening on {}", bind);

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
