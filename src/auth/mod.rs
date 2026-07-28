use axum::{
    RequestPartsExt,
    extract::FromRequestParts,
    http::{StatusCode, request::Parts},
};
use axum_extra::extract::CookieJar;
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};

use crate::AppState;

use axum::extract::{Request as AxumRequest, State};
use axum::middleware::Next;
use axum::response::Response;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
}

pub fn create_token(secret: &str) -> Result<String, jsonwebtoken::errors::Error> {
    let claims = Claims {
        sub: "admin".to_string(),
        exp: (chrono::Utc::now() + chrono::Duration::days(90)).timestamp() as usize,
    };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))
}

pub fn verify_token(secret: &str, token: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )?;
    Ok(token_data.claims)
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
    verify_token(&state.jwt_secret, &token).map_err(|_| StatusCode::UNAUTHORIZED)?;
    Ok(next.run(request).await)
}

/// Extractor that requires a valid auth token.
/// 有意保留（预留 handler 级鉴权），当前不使用（使用 require_auth_mw 中间件）。
#[allow(dead_code)]
pub struct RequireAuth;

impl<S> FromRequestParts<S> for RequireAuth
where
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let jar = parts.extract::<CookieJar>().await.unwrap_or_default();

        let token = jar.get("omniterm_token").map(|c| c.value().to_string()).or_else(|| {
            parts
                .headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
                .map(|v| v.to_string())
        });

        let token = token.ok_or(StatusCode::UNAUTHORIZED)?;

        let secret = parts
            .extensions
            .get::<String>()
            .cloned()
            .unwrap_or_else(|| "omniterm-default-secret-change-me".to_string());

        verify_token(&secret, &token).map_err(|_| StatusCode::UNAUTHORIZED)?;

        Ok(RequireAuth)
    }
}
