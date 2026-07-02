use axum::{
    extract::State,
    http::StatusCode,
    response::{AppendHeaders, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use axum_extra::extract::cookie::{Cookie, SameSite};
use serde_json::json;

use crate::auth;
use crate::models::user::{LoginRequest, SetupRequest};
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/setup", post(setup))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/check", get(check))
}

fn token_cookie(token: &str) -> String {
    Cookie::build(("omniterm_token", token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::hours(24))
        .to_string()
}

fn clear_cookie() -> String {
    Cookie::build(("omniterm_token", ""))
        .path("/")
        .http_only(true)
        .max_age(time::Duration::ZERO)
        .to_string()
}

async fn setup(
    State(state): State<AppState>,
    Json(req): Json<SetupRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM users LIMIT 1")
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if existing.is_some() {
        return Err(StatusCode::CONFLICT);
    }

    let hash = bcrypt::hash(&req.password, 10).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query("INSERT INTO users (password_hash, created_at) VALUES (?, ?)")
        .bind(&hash)
        .bind(&now)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let token = auth::create_token(&state.jwt_secret).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let cookie = token_cookie(&token);

    Ok((
        StatusCode::OK,
        AppendHeaders([("set-cookie", cookie)]),
        Json(json!({ "ok": true })),
    ))
}

async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let user: Option<(String,)> = sqlx::query_as("SELECT password_hash FROM users LIMIT 1")
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some((hash,)) = user else {
        return Err(StatusCode::UNAUTHORIZED);
    };

    if !bcrypt::verify(&req.password, &hash).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)? {
        return Err(StatusCode::UNAUTHORIZED);
    }

    let token = auth::create_token(&state.jwt_secret).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let cookie = token_cookie(&token);

    Ok((
        StatusCode::OK,
        AppendHeaders([("set-cookie", cookie)]),
        Json(json!({ "ok": true })),
    ))
}

async fn logout() -> impl IntoResponse {
    let cookie = clear_cookie();
    (
        AppendHeaders([("set-cookie", cookie)]),
        Json(json!({ "ok": true })),
    )
}

async fn check() -> impl IntoResponse {
    Json(json!({ "authenticated": true }))
}
