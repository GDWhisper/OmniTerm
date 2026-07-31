use axum::{
    extract::{Request as AxumRequest, State},
    http::StatusCode,
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::AppState;

pub mod rate_limit;
pub use rate_limit::LoginGuard;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
    /// Session token version — must equal `users.token_version` at verify
    /// time, otherwise the token was revoked (logout / password change).
    pub ver: i64,
}

pub fn create_token(secret: &str, ver: i64) -> Result<String, jsonwebtoken::errors::Error> {
    let claims = Claims {
        sub: "admin".to_string(),
        exp: (chrono::Utc::now() + chrono::Duration::days(90)).timestamp() as usize,
        ver,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))
}

/// Pure signature/expiry verification (no revocation check). Prefer
/// [`verify_token_for_state`] in handlers and middleware.
pub fn verify_token(secret: &str, token: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )?;
    Ok(token_data.claims)
}

/// Signature/expiry verification plus revocation check: the claim's `ver`
/// must match `users.token_version` (incremented on login/logout/change).
/// No user row ⇒ nothing can be authenticated.
pub async fn verify_token_for_state(
    db: &SqlitePool,
    secret: &str,
    token: &str,
) -> Result<Claims, StatusCode> {
    let claims = verify_token(secret, token).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let stored: Option<i64> = sqlx::query_scalar("SELECT token_version FROM users LIMIT 1")
        .fetch_optional(db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if stored != Some(claims.ver) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(claims)
}

fn extract_token(req: &AxumRequest) -> Option<String> {
    if let Some(cookie) = req.headers().get("cookie").and_then(|v| v.to_str().ok()) {
        for pair in cookie.split(';') {
            let pair = pair.trim();
            if let Some(value) = pair.strip_prefix("omniterm_token=") {
                return Some(value.to_string());
            }
        }
    }
    if let Some(auth) = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return Some(auth.to_string());
    }
    None
}

pub async fn require_auth_mw(
    State(state): State<AppState>,
    request: AxumRequest,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = extract_token(&request).ok_or(StatusCode::UNAUTHORIZED)?;
    verify_token_for_state(&state.db, &state.jwt_secret, &token).await?;
    Ok(next.run(request).await)
}
