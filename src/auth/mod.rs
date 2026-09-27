use axum::{
    extract::{ConnectInfo, Request as AxumRequest, State},
    http::{HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};
use jsonwebtoken::{DecodingKey, EncodingKey, Header, Validation, decode, encode};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;

use crate::AppState;

pub mod local_access;
pub mod rate_limit;
pub use rate_limit::LoginGuard;

/// settings 表 key：密码验证总开关。
pub const SETTING_AUTH_ENABLED: &str = "auth_enabled";

/// settings 表 key：本地访问是否同样要求密码验证（D4）。
/// `"1"` = 本地也校验（**默认**，缺失时同样按 true）；`"0"` = 本地免密。
pub const SETTING_LOCAL_AUTH_REQUIRED: &str = "local_auth_required";

/// 默认用户名：老库经 migration 自动得到 `'admin'`，不传用户名的老 API 调用方
/// 仍按此值比对（D1）。
pub const DEFAULT_USERNAME: &str = "admin";

/// 用户名长度上限（字符数，非字节数）。
const MAX_USERNAME_CHARS: usize = 32;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    /// 身份标记：当前账号的用户名（D2；旧版本硬编码 `"admin"`）。
    pub sub: String,
    pub exp: usize,
    /// Session token version — must equal `users.token_version` at verify
    /// time, otherwise the token was revoked (logout / password change / rename).
    pub ver: i64,
}

/// 用户名规范化唯一真源（D1）：`trim()` 后 `1..=32` 个字符、禁控制字符
/// （`char::is_control()`，含 `\n` `\t`）。`Err` → 调用方返回 400。
/// `setup` 与 `change-username` 共用，禁止两处各写一份。
pub fn normalize_username(raw: &str) -> Result<String, ()> {
    let s = raw.trim();
    if s.is_empty() || s.chars().count() > MAX_USERNAME_CHARS || s.chars().any(char::is_control) {
        return Err(());
    }
    Ok(s.to_string())
}

/// `setup` 语义：缺省 / 空串 / 全空白 → [`DEFAULT_USERNAME`]，其余走
/// [`normalize_username`]（与老库、老脚本兼容）。
pub fn normalize_username_or_default(raw: Option<&str>) -> Result<String, ()> {
    match raw {
        Some(s) if !s.trim().is_empty() => normalize_username(s),
        _ => Ok(DEFAULT_USERNAME.to_string()),
    }
}

pub fn create_token(
    secret: &str,
    ver: i64,
    username: &str,
) -> Result<String, jsonwebtoken::errors::Error> {
    let claims = Claims {
        sub: username.to_string(),
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
///
/// **不**在此比对 `claims.sub` 与 `users.username`（D2 否决项）：`ver` 已覆盖
/// 「改名后旧 token 失效」，多一层比对会把改名语义压进每请求热路径。
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

/// 从请求提取本实例的 token：优先 `Cookie: <cookie_name>=...`，其次
/// `Authorization: Bearer ...`。`cookie_name` 由 `AppState.token_cookie` 提供
/// （按 db 实例加后缀），同一 host 下不同实例的 cookie 互不误读。
pub fn extract_token(req: &AxumRequest, cookie_name: &str) -> Option<String> {
    if let Some(cookie) = req.headers().get("cookie").and_then(|v| v.to_str().ok()) {
        for pair in cookie.split(';') {
            let pair = pair.trim();
            // 精确匹配 `<name>=`，故 `omniterm_token` 不会误读 `omniterm_token_dev`。
            if let Some(rest) = pair.strip_prefix(cookie_name)
                && let Some(value) = rest.strip_prefix('=')
            {
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

/// 共享请求鉴权校验（**唯一真源**）：auth 关闭全放行；否则先看本地免密命中
/// （`local_auth_required` 关 且 [`local_access::is_local_request`] 为真），
/// 最后验 token 签名/过期 + revocation。
/// 供 `require_auth_mw`（路由层）与子域名代理中间件（`proxy_host_mw`）复用——
/// 后者是 middleware 不走路由层，须显式调用，否则 auth 开启时子域名成开放代理。
///
/// `token` 是已提取的令牌（`extract_token` 的返回值），`headers` / `peer` 供本地
/// 免密判据使用（`peer` 缺失 → 判据 fail-closed）。**为何不直接收 `&Request`**：
/// `Request<Body>` 含 `dyn HttpBody`（非 `Sync`），`&Request` 不可跨线程发送，
/// 会连带整个 future 失去 `Send`，无法作为 axum middleware 挂载。改为只借用
/// `&HeaderMap`（`Send + Sync`）与 `Copy` 的 `Option<SocketAddr>` 后 future 恢复
/// `Send`。
pub async fn verify_request(
    state: &AppState,
    token: Option<&str>,
    headers: &HeaderMap,
    peer: Option<SocketAddr>,
) -> Result<(), StatusCode> {
    // 顺序固定（D4）：总开关关闭 → 全放行；否则才看本地免密。
    // 两个 AtomicBool 各自镜像 settings 里的同名 key，热路径单次 relaxed load、
    // 无 DB round-trip。
    if !state.auth_enabled.load(Ordering::Relaxed) {
        return Ok(());
    }
    if !state.local_auth_required.load(Ordering::Relaxed)
        && local_access::is_local_request(headers, peer)
    {
        return Ok(());
    }
    let token = token.ok_or(StatusCode::UNAUTHORIZED)?;
    verify_token_for_state(&state.db, &state.jwt_secret, token).await?;
    Ok(())
}

pub async fn require_auth_mw(
    State(state): State<AppState>,
    request: AxumRequest,
    next: Next,
) -> Result<Response, StatusCode> {
    let token = extract_token(&request, &state.token_cookie);
    // `ConnectInfo` 由 `into_make_service_with_connect_info` 注入；缺失 → None →
    // 本地免密判据 fail-closed（不会误放行）。
    let peer = request.extensions().get::<ConnectInfo<SocketAddr>>().map(|ci| ci.0);
    verify_request(&state, token.as_deref(), request.headers(), peer).await?;
    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(host: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("host", HeaderValue::from_str(host).unwrap());
        h
    }

    fn peer(ip: &str) -> Option<SocketAddr> {
        Some(SocketAddr::new(ip.parse().unwrap(), 40000))
    }

    /// 测试态：auth 与本地免密两开关按需注入（`test_state()` 默认 auth 关、本地要求密码）。
    async fn state(auth_enabled: bool, local_auth_required: bool) -> AppState {
        let state = crate::test_utils::test_state().await;
        state.auth_enabled.store(auth_enabled, Ordering::Relaxed);
        state.local_auth_required.store(local_auth_required, Ordering::Relaxed);
        state
    }

    // ── verify_request 行为级：三序判定 ─────────────────────────

    #[tokio::test]
    async fn local_bypass_hits_without_token() {
        // auth 开 + 本地免密开 + 本地形态无 token → 放行
        let state = state(true, false).await;
        let r = verify_request(&state, None, &headers("127.0.0.1:18777"), peer("127.0.0.1")).await;
        assert!(r.is_ok());
    }

    #[tokio::test]
    async fn remote_shape_requires_token() {
        // 远程形态（Host 非回环）→ 401，即使对端是回环（同机反代场景）
        let state = state(true, false).await;
        let r =
            verify_request(&state, None, &headers("omniterm.example.com"), peer("127.0.0.1")).await;
        assert_eq!(r, Err(StatusCode::UNAUTHORIZED));
    }

    #[tokio::test]
    async fn local_bypass_disabled_requires_token_even_locally() {
        // 本地免密关（默认安全姿态）→ 本地也 401
        let state = state(true, true).await;
        let r = verify_request(&state, None, &headers("127.0.0.1:18777"), peer("127.0.0.1")).await;
        assert_eq!(r, Err(StatusCode::UNAUTHORIZED));
    }

    #[tokio::test]
    async fn auth_disabled_allows_everything() {
        // 总开关关闭 → 全放行（本地免密开关即使为「要求密码」也无效果）
        let state = state(false, true).await;
        let r = verify_request(&state, None, &headers("evil.example.com"), peer("8.8.8.8")).await;
        assert!(r.is_ok());
    }

    #[tokio::test]
    async fn proxy_header_blocks_local_bypass() {
        // 反代改写 Host 为上游回环地址时，代理头存在 → 不放行
        let state = state(true, false).await;
        let mut h = headers("127.0.0.1:18777");
        h.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.9"));
        let r = verify_request(&state, None, &h, peer("127.0.0.1")).await;
        assert_eq!(r, Err(StatusCode::UNAUTHORIZED));
    }

    /// 中间件接线级：`require_auth_mw` 必须把 `ConnectInfo` 与 `&HeaderMap` 真实传入
    /// 判据（仅测纯函数不够——「判据共享 ≠ 调用点覆盖」）。
    #[tokio::test]
    async fn middleware_wires_peer_and_headers_into_local_bypass() {
        use axum::{Router, middleware, routing::get};
        use tower::ServiceExt;

        let state = state(true, false).await;
        let app = Router::new()
            .route("/protected", get(|| async { "ok" }))
            .route_layer(middleware::from_fn_with_state(state.clone(), require_auth_mw))
            .with_state(state.clone());

        let request = |host: &str| {
            axum::http::Request::builder()
                .uri("/protected")
                .header("host", host)
                .extension(ConnectInfo(SocketAddr::new("127.0.0.1".parse().unwrap(), 40000)))
                .body(axum::body::Body::empty())
                .unwrap()
        };

        // 本地形态无 token → 放行
        let resp = app.clone().oneshot(request("127.0.0.1:18777")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        // 远程 Host（同机反代形态：对端回环但 Host 是域名）→ 401
        let resp = app.clone().oneshot(request("omniterm.example.com")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn valid_token_passes_even_remotely() {
        // 远程形态带合法 token → 放行（本地免密只是额外放行路径，不影响 token 路径）
        let state = state(true, true).await;
        sqlx::query(
            "INSERT INTO users (username, password_hash, created_at) VALUES ('admin', 'x', '')",
        )
        .execute(&state.db)
        .await
        .expect("seed user");
        let token = create_token(&state.jwt_secret, 1, "admin").expect("token");
        let r = verify_request(
            &state,
            Some(&token),
            &headers("omniterm.example.com"),
            peer("203.0.113.9"),
        )
        .await;
        assert!(r.is_ok());
    }

    // ── 用户名规范化（D1 单一真源）──────────────────────────────

    #[test]
    fn normalize_username_enforces_boundaries() {
        // 31 / 32 字符合法，33 字符非法（按字符数而非字节数）
        assert_eq!(normalize_username(&"a".repeat(31)).unwrap().len(), 31);
        assert!(normalize_username(&"a".repeat(32)).is_ok());
        assert!(normalize_username(&"a".repeat(33)).is_err());
        // 多字节字符同样按字符数计（32 个汉字合法）
        assert!(normalize_username(&"汉".repeat(32)).is_ok());
        assert!(normalize_username(&"汉".repeat(33)).is_err());
    }

    #[test]
    fn normalize_username_trims_and_rejects_control_chars() {
        assert_eq!(normalize_username("  alice  ").unwrap(), "alice");
        for bad in ["", "   ", "bad\nname", "bad\tname", "bad\u{7f}name", "a\u{0}b"] {
            assert!(normalize_username(bad).is_err(), "bad={bad:?}");
        }
    }

    #[test]
    fn normalize_username_or_default_falls_back_to_admin() {
        assert_eq!(normalize_username_or_default(None).unwrap(), DEFAULT_USERNAME);
        assert_eq!(normalize_username_or_default(Some("")).unwrap(), DEFAULT_USERNAME);
        assert_eq!(normalize_username_or_default(Some("   ")).unwrap(), DEFAULT_USERNAME);
        assert_eq!(normalize_username_or_default(Some(" alice ")).unwrap(), "alice");
        assert!(normalize_username_or_default(Some("bad\nname")).is_err());
    }

    #[test]
    fn setting_local_auth_required_key_is_stable() {
        // key 名是前后端与文档的契约，钉住防止手滑改名
        assert_eq!(SETTING_LOCAL_AUTH_REQUIRED, "local_auth_required");
    }
}
