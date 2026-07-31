use axum::{
    Json, Router,
    extract::{ConnectInfo, State},
    http::StatusCode,
    response::{AppendHeaders, IntoResponse},
    routing::{get, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde_json::json;
use std::net::SocketAddr;

use crate::AppState;
use crate::auth;
use crate::models::user::{AuthSettingsRequest, ChangePasswordRequest, LoginRequest, SetupRequest};
use std::sync::atomic::Ordering;

/// Public auth routes (no token required).
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/setup", post(setup))
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/check", get(check))
}

/// Auth routes that require a valid token (mounted behind require_auth_mw).
pub fn protected_routes() -> Router<AppState> {
    Router::new()
        .route("/auth/settings", post(set_auth_settings))
        .route("/auth/change-password", post(change_password))
}

fn token_cookie(token: &str) -> String {
    Cookie::build(("omniterm_token", token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::days(90))
        .to_string()
}

fn clear_cookie() -> String {
    Cookie::build(("omniterm_token", ""))
        .path("/")
        .http_only(true)
        .max_age(time::Duration::ZERO)
        .to_string()
}

/// Reject clients that exhausted the login failure budget (5 failures / 5 min).
fn check_rate_limit(state: &AppState, addr: &SocketAddr) -> Result<(), StatusCode> {
    let ip = addr.ip().to_string();
    if state.login_guard.is_blocked(&ip) {
        return Err(StatusCode::TOO_MANY_REQUESTS);
    }
    Ok(())
}

async fn setup(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<SetupRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    check_rate_limit(&state, &addr)?;

    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM users LIMIT 1")
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    if existing.is_some() {
        state.login_guard.record_failure(&addr.ip().to_string());
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

    let ver: i64 = sqlx::query_scalar("SELECT token_version FROM users LIMIT 1")
        .fetch_one(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token = auth::create_token(&state.jwt_secret, ver)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let cookie = token_cookie(&token);

    state.login_guard.record_success(&addr.ip().to_string());
    Ok((StatusCode::OK, AppendHeaders([("set-cookie", cookie)]), Json(json!({ "ok": true }))))
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<LoginRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    check_rate_limit(&state, &addr)?;

    let user: Option<(String, i64)> =
        sqlx::query_as("SELECT password_hash, token_version FROM users LIMIT 1")
            .fetch_optional(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some((hash, ver)) = user else {
        state.login_guard.record_failure(&addr.ip().to_string());
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        return Err(StatusCode::UNAUTHORIZED);
    };

    if !bcrypt::verify(&req.password, &hash).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)? {
        state.login_guard.record_failure(&addr.ip().to_string());
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        return Err(StatusCode::UNAUTHORIZED);
    }

    let token = auth::create_token(&state.jwt_secret, ver)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let cookie = token_cookie(&token);

    state.login_guard.record_success(&addr.ip().to_string());
    Ok((StatusCode::OK, AppendHeaders([("set-cookie", cookie)]), Json(json!({ "ok": true }))))
}

/// Logout revokes the current session token by bumping `token_version` —
/// all previously issued tokens become invalid immediately.
async fn logout(State(state): State<AppState>) -> Result<impl IntoResponse, StatusCode> {
    sqlx::query("UPDATE users SET token_version = token_version + 1")
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let cookie = clear_cookie();
    Ok((AppendHeaders([("set-cookie", cookie)]), Json(json!({ "ok": true }))))
}

/// Changing the password also bumps `token_version`, revoking every session
/// token issued before the change. Rate-limited like login — the current
/// password check is an equivalent brute-force surface.
async fn change_password(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<ChangePasswordRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    check_rate_limit(&state, &addr)?;

    let user: Option<(String,)> = sqlx::query_as("SELECT password_hash FROM users LIMIT 1")
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some((hash,)) = user else {
        return Err(StatusCode::NOT_FOUND);
    };

    if !bcrypt::verify(&req.current_password, &hash)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    {
        state.login_guard.record_failure(&addr.ip().to_string());
        return Err(StatusCode::UNAUTHORIZED);
    }

    let new_hash =
        bcrypt::hash(&req.new_password, 10).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    sqlx::query(
        "UPDATE users SET password_hash = ?, token_version = token_version + 1 \
         WHERE id = (SELECT id FROM users LIMIT 1)",
    )
    .bind(&new_hash)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    state.login_guard.record_success(&addr.ip().to_string());
    Ok(Json(json!({ "ok": true })))
}

/// Toggle the password-verification master switch. Requires an authenticated
/// session (mounted on the protected router). Persists to `settings` and
/// updates the in-memory AtomicBool that require_auth_mw reads.
async fn set_auth_settings(
    State(state): State<AppState>,
    Json(req): Json<AuthSettingsRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let v = if req.auth_enabled { "1" } else { "0" };
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('auth_enabled', ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(v)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    state.auth_enabled.store(req.auth_enabled, Ordering::Relaxed);
    Ok(Json(json!({ "ok": true })))
}

async fn check(State(state): State<AppState>, jar: CookieJar) -> impl IntoResponse {
    let auth_enabled = state.auth_enabled.load(Ordering::Relaxed);

    // Master switch off ⇒ everything is open, report as authenticated.
    if !auth_enabled {
        return Json(json!({ "authenticated": true, "auth_enabled": false }));
    }

    let token = jar.get("omniterm_token").map(|c| c.value().to_string());

    let authenticated = match token.as_deref() {
        Some(t) => auth::verify_token_for_state(&state.db, &state.jwt_secret, t).await.is_ok(),
        None => false,
    };

    if authenticated {
        return Json(json!({ "authenticated": true, "auth_enabled": true }));
    }

    let needs_setup = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0)
        == 0;

    Json(json!({ "authenticated": false, "needs_setup": needs_setup, "auth_enabled": true }))
}
