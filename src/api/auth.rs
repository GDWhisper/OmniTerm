use axum::{
    Json, Router,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{AppendHeaders, IntoResponse},
    routing::{get, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde_json::json;
use std::net::SocketAddr;

use crate::AppState;
use crate::auth::{self, SETTING_AUTH_ENABLED, SETTING_LOCAL_AUTH_REQUIRED};
use crate::models::user::{
    AuthSettingsRequest, ChangePasswordRequest, ChangeUsernameRequest, LoginRequest, SetupRequest,
};
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
        .route("/auth/settings", get(get_auth_settings).post(set_auth_settings))
        .route("/auth/change-password", post(change_password))
        .route("/auth/change-username", post(change_username))
}

/// 浏览器规范：`Domain` 属性必须包含至少一个点，且不能是 IP 地址或 `localhost`。
/// 若 base_host 是 IP（如 `192.168.5.216`）/ localhost / 无点单标签域名，设置
/// `Domain` 会导致浏览器直接拒绝该 cookie（子域名鉴权永久失效），此时保持
/// host-only（不加 Domain 属性）。参考 code-server `http.ts:getCookieDomain`。
fn should_set_cookie_domain(domain: &str) -> bool {
    let d = domain.trim_matches('[').trim_end_matches(']');
    if d.eq_ignore_ascii_case("localhost") {
        return false;
    }
    if d.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    d.contains('.')
}

/// 构造登录/签发的 token cookie。`cookie_name` 来自 `AppState.token_cookie`
/// （按 db 实例加后缀）：同一 host 下不同实例（browser cookie 不区分端口）各写各的
/// 键位，互不覆盖。`domain` 为子域名代理 base（`Some("omniterm.lan")`）时给 cookie
/// 加 `Domain=omniterm.lan`，使 `{port}.{base}` 子域名也能携带该 cookie 通过鉴权；
/// `None` 或 base 为 IP/localhost/无点域名时维持 host-only（现状 + P0-4.7 防御）。
fn token_cookie(cookie_name: &str, token: &str, domain: Option<&str>) -> String {
    let builder = Cookie::build((cookie_name, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::days(90));
    match domain {
        Some(d) if should_set_cookie_domain(d) => builder.domain(d),
        _ => builder,
    }
    .to_string()
}

fn clear_cookie(cookie_name: &str, domain: Option<&str>) -> String {
    let builder =
        Cookie::build((cookie_name, "")).path("/").http_only(true).max_age(time::Duration::ZERO);
    match domain {
        Some(d) if should_set_cookie_domain(d) => builder.domain(d),
        _ => builder,
    }
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

/// settings 表 upsert：`auth_enabled` 与 `local_auth_required` 两个 key 共用，
/// 避免同一段 SQL 复制两份。
async fn upsert_setting(db: &sqlx::SqlitePool, key: &str, value: &str) -> Result<(), StatusCode> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(())
}

async fn setup(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<SetupRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    check_rate_limit(&state, &addr)?;

    // D1：缺省 / 空串 / 全空白 → "admin"；含控制字符 / 超长 → 400（写入前规范化，
    // 与 change-username 共用同一函数）。
    let username = auth::normalize_username_or_default(req.username.as_deref())
        .map_err(|_| StatusCode::BAD_REQUEST)?;

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

    sqlx::query("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
        .bind(&username)
        .bind(&hash)
        .bind(&now)
        .execute(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let ver: i64 = sqlx::query_scalar("SELECT token_version FROM users LIMIT 1")
        .fetch_one(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let token = auth::create_token(&state.jwt_secret, ver, &username)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let cookie = token_cookie(&state.token_cookie, &token, state.proxy.base_host.as_deref());

    state.login_guard.record_success(&addr.ip().to_string());
    Ok((StatusCode::OK, AppendHeaders([("set-cookie", cookie)]), Json(json!({ "ok": true }))))
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<LoginRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    check_rate_limit(&state, &addr)?;

    // D1：用户名与密码均须匹配（区分大小写）；缺省 / 空串按 `"admin"` 比对，
    // 与老库、老脚本兼容。失败统一 401（不区分用户名错/密码错，避免枚举）。
    let provided = req
        .username
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(auth::DEFAULT_USERNAME);

    let user: Option<(String, String, i64)> =
        sqlx::query_as("SELECT username, password_hash, token_version FROM users LIMIT 1")
            .fetch_optional(&state.db)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let Some((stored_username, hash, ver)) = user else {
        state.login_guard.record_failure(&addr.ip().to_string());
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        return Err(StatusCode::UNAUTHORIZED);
    };

    let password_ok =
        bcrypt::verify(&req.password, &hash).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if provided != stored_username.as_str() || !password_ok {
        state.login_guard.record_failure(&addr.ip().to_string());
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        return Err(StatusCode::UNAUTHORIZED);
    }

    let token = auth::create_token(&state.jwt_secret, ver, &stored_username)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let cookie = token_cookie(&state.token_cookie, &token, state.proxy.base_host.as_deref());

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
    let cookie = clear_cookie(&state.token_cookie, state.proxy.base_host.as_deref());
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

/// 修改用户名（D2）：校验当前密码 → 更新 `username` 并 `token_version + 1`，
/// 旧 token 全部立即失效（与 logout / change-password 同一撤销机制；前端改完
/// 引导重新登录）。本地免密命中时**仍要求** `current_password`（语义一致，
/// 不新增免密改密/改名路径）。复用 `LoginGuard`——密码校验是同一暴力面。
async fn change_username(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<ChangeUsernameRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    check_rate_limit(&state, &addr)?;

    // 格式非法（空 / 超长 / 控制字符）→ 400（与 setup 同一规范化函数）
    let new_username =
        auth::normalize_username(&req.new_username).map_err(|_| StatusCode::BAD_REQUEST)?;

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

    sqlx::query(
        "UPDATE users SET username = ?, token_version = token_version + 1 \
         WHERE id = (SELECT id FROM users LIMIT 1)",
    )
    .bind(&new_username)
    .execute(&state.db)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    state.login_guard.record_success(&addr.ip().to_string());
    Ok(Json(json!({ "ok": true })))
}

/// 只读设置口（D5）：两个开关的当前值 + 用户名（无用户行 → `null`）。
/// 用户名只在此受保护端点返回；公开的 `/auth/check` 不泄露账号名。
async fn get_auth_settings(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let username: Option<String> = sqlx::query_scalar("SELECT username FROM users LIMIT 1")
        .fetch_optional(&state.db)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(json!({
        "auth_enabled": state.auth_enabled.load(Ordering::Relaxed),
        "local_auth_required": state.local_auth_required.load(Ordering::Relaxed),
        "username": username,
    })))
}

/// 设置口部分更新（D5）：只提交需要变更的项，漏项保持原值；两项都缺 → 400。
/// 每项落库 + 更新对应 AtomicBool（`require_auth_mw` / `verify_request` 热路径
/// 单次 relaxed load，无 DB round-trip）。
async fn set_auth_settings(
    State(state): State<AppState>,
    Json(req): Json<AuthSettingsRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let AuthSettingsRequest { auth_enabled, local_auth_required } = req;
    if auth_enabled.is_none() && local_auth_required.is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if let Some(enabled) = auth_enabled {
        upsert_setting(&state.db, SETTING_AUTH_ENABLED, if enabled { "1" } else { "0" }).await?;
        state.auth_enabled.store(enabled, Ordering::Relaxed);
    }
    if let Some(required) = local_auth_required {
        upsert_setting(&state.db, SETTING_LOCAL_AUTH_REQUIRED, if required { "1" } else { "0" })
            .await?;
        state.local_auth_required.store(required, Ordering::Relaxed);
    }
    Ok(Json(json!({ "ok": true })))
}

async fn check(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
) -> impl IntoResponse {
    let auth_enabled = state.auth_enabled.load(Ordering::Relaxed);

    // Master switch off ⇒ everything is open, report as authenticated.
    if !auth_enabled {
        // Still report whether a password has ever been set, so the frontend
        // can decide whether enabling needs a brand-new password (no user row)
        // or proof of the existing one.
        let needs_setup = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM users")
            .fetch_one(&state.db)
            .await
            .unwrap_or(0)
            == 0;
        return Json(
            json!({ "authenticated": true, "auth_enabled": false, "needs_setup": needs_setup }),
        );
    }

    // 本地免密命中（D3/D5）：authenticated: true + local_bypass: true，不读 cookie。
    if !state.local_auth_required.load(Ordering::Relaxed)
        && auth::local_access::is_local_request(&headers, Some(addr))
    {
        return Json(json!({ "authenticated": true, "auth_enabled": true, "local_bypass": true }));
    }

    let token = jar.get(&state.token_cookie).map(|c| c.value().to_string());

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    #[test]
    fn set_cookie_no_domain_for_ip_or_localhost_base() {
        // 浏览器拒绝 Domain=IP / Domain=localhost（必须含点），host-only 才生效
        for bad in ["192.168.5.216", "[::1]", "localhost", "omniterm"] {
            let c = token_cookie("omniterm_token", "tok", Some(bad));
            assert!(!c.to_lowercase().contains("domain="), "base={bad} cookie={c}");
            let c2 = clear_cookie("omniterm_token", Some(bad));
            assert!(!c2.to_lowercase().contains("domain="), "clear base={bad} cookie={c2}");
        }
    }

    #[test]
    fn set_cookie_keeps_domain_for_dotted_base() {
        // 合法带点域名：保留 Domain，子域名可携带
        let c = token_cookie("omniterm_token", "tok", Some("omniterm.lan"));
        assert!(c.to_lowercase().contains("domain=omniterm.lan"), "cookie={c}");
        let c2 = clear_cookie("omniterm_token", Some("omniterm.lan"));
        assert!(c2.to_lowercase().contains("domain=omniterm.lan"), "cookie={c2}");
        // 多级域名同样保留
        let c3 = token_cookie("omniterm_token", "tok", Some("omniterm.example.com"));
        assert!(c3.to_lowercase().contains("domain=omniterm.example.com"), "cookie={c3}");
    }

    #[test]
    fn set_cookie_uses_instance_scoped_name() {
        // dev 实例写自己的键位：同 host（浏览器不区分端口）下不与正式版互相覆盖
        let dev = crate::token_cookie_name("dev");
        assert_eq!(dev, "omniterm_token_dev");
        let c = token_cookie(&dev, "tok", None);
        assert!(c.starts_with("omniterm_token_dev=tok"), "cookie={c}");
        // 正式版沿用历史名（老用户登录态不失效）
        let prod = crate::token_cookie_name("");
        assert_eq!(prod, "omniterm_token");
        assert!(token_cookie(&prod, "tok", None).starts_with("omniterm_token=tok"));
    }

    #[test]
    fn should_set_cookie_domain_guards() {
        assert!(!should_set_cookie_domain("192.168.5.216"));
        assert!(!should_set_cookie_domain("[::1]"));
        assert!(!should_set_cookie_domain("localhost"));
        assert!(!should_set_cookie_domain("LOCALHOST"));
        assert!(!should_set_cookie_domain("omniterm"));
        assert!(should_set_cookie_domain("omniterm.lan"));
        assert!(should_set_cookie_domain("omniterm.example.com"));
    }

    // ── handler 级行为测试（直调 handler，DB 用内存 sqlite + 全量迁移）──

    /// 本机测试连接信息（audit / 限流用的 `ConnectInfo`）。
    fn conn() -> ConnectInfo<SocketAddr> {
        ConnectInfo(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 50000))
    }

    fn host_headers(host: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("host", axum::http::HeaderValue::from_str(host).unwrap());
        h
    }

    async fn query_username(state: &AppState) -> Option<String> {
        sqlx::query_scalar("SELECT username FROM users LIMIT 1")
            .fetch_optional(&state.db)
            .await
            .expect("query username")
    }

    async fn query_token_version(state: &AppState) -> i64 {
        sqlx::query_scalar("SELECT token_version FROM users LIMIT 1")
            .fetch_one(&state.db)
            .await
            .expect("query token_version")
    }

    async fn db_setting(state: &AppState, key: &str) -> Option<String> {
        sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(key)
            .fetch_optional(&state.db)
            .await
            .expect("query setting")
    }

    async fn setup_user(state: &AppState, username: Option<&str>, password: &str) {
        let res = setup(
            State(state.clone()),
            conn(),
            Json(SetupRequest {
                username: username.map(str::to_string),
                password: password.into(),
            }),
        )
        .await;
        assert!(res.is_ok(), "setup must succeed");
    }

    async fn login_status(
        state: &AppState,
        username: Option<&str>,
        password: &str,
    ) -> Option<StatusCode> {
        login(
            State(state.clone()),
            conn(),
            Json(LoginRequest {
                username: username.map(str::to_string),
                password: password.into(),
            }),
        )
        .await
        .err()
    }

    #[tokio::test]
    async fn setup_defaults_username_to_admin() {
        // 不传 username → "admin"（老 API 调用方兼容）
        let state = crate::test_utils::test_state().await;
        setup_user(&state, None, "pw").await;
        assert_eq!(query_username(&state).await.as_deref(), Some("admin"));

        // 空串 / 全空白同样回退 "admin"
        for blank in ["", "   "] {
            let state = crate::test_utils::test_state().await;
            setup_user(&state, Some(blank), "pw").await;
            assert_eq!(query_username(&state).await.as_deref(), Some("admin"), "blank={blank:?}");
        }
    }

    #[tokio::test]
    async fn setup_rejects_invalid_username_without_creating_user() {
        let state = crate::test_utils::test_state().await;
        for bad in ["bad\nname", &"a".repeat(33)] {
            let res = setup(
                State(state.clone()),
                conn(),
                Json(SetupRequest { username: Some(bad.to_string()), password: "pw".into() }),
            )
            .await;
            assert!(matches!(res, Err(StatusCode::BAD_REQUEST)), "bad={bad:?}");
            assert_eq!(query_username(&state).await, None, "bad={bad:?} must not create user");
        }
    }

    #[tokio::test]
    async fn custom_username_is_required_for_login() {
        let state = crate::test_utils::test_state().await;
        setup_user(&state, Some("alice"), "pw").await;

        // 用自定义用户名登录成功
        assert_eq!(login_status(&state, Some("alice"), "pw").await, None);
        // 用 admin 失败（1s 延迟 + 401；不含 bcrypt 差异，延迟统一）
        assert_eq!(login_status(&state, Some("admin"), "pw").await, Some(StatusCode::UNAUTHORIZED));
    }

    #[tokio::test]
    async fn login_without_username_falls_back_to_admin() {
        let state = crate::test_utils::test_state().await;
        setup_user(&state, None, "pw").await;
        assert_eq!(login_status(&state, None, "pw").await, None);

        // 用户名对但密码错 → 401
        assert_eq!(login_status(&state, None, "wrong").await, Some(StatusCode::UNAUTHORIZED));
    }

    #[tokio::test]
    async fn change_username_updates_and_revokes_old_tokens() {
        let state = crate::test_utils::test_state().await;
        setup_user(&state, Some("alice"), "pw").await;

        let old_ver = query_token_version(&state).await;
        let old_token = auth::create_token(&state.jwt_secret, old_ver, "alice").expect("token");
        assert!(
            auth::verify_token_for_state(&state.db, &state.jwt_secret, &old_token).await.is_ok()
        );

        // 新用户名首尾空白被 trim 后落库
        let res = change_username(
            State(state.clone()),
            conn(),
            Json(ChangeUsernameRequest {
                current_password: "pw".into(),
                new_username: "  bob  ".into(),
            }),
        )
        .await;
        assert!(res.is_ok(), "change-username must succeed");
        assert_eq!(query_username(&state).await.as_deref(), Some("bob"));

        // D2：token_version + 1，旧 token 立即失效；按新版本签发的 token 可用
        let new_ver = query_token_version(&state).await;
        assert_eq!(new_ver, old_ver + 1);
        assert!(
            auth::verify_token_for_state(&state.db, &state.jwt_secret, &old_token).await.is_err()
        );
        let new_token = auth::create_token(&state.jwt_secret, new_ver, "bob").expect("token");
        assert!(
            auth::verify_token_for_state(&state.db, &state.jwt_secret, &new_token).await.is_ok()
        );

        // 改完用新用户名登录成功、旧用户名失败
        assert_eq!(login_status(&state, Some("bob"), "pw").await, None);
        assert_eq!(login_status(&state, Some("alice"), "pw").await, Some(StatusCode::UNAUTHORIZED));
    }

    #[tokio::test]
    async fn change_username_rejects_bad_password_or_bad_name() {
        let state = crate::test_utils::test_state().await;
        setup_user(&state, Some("alice"), "pw").await;

        // 密码错 → 401，用户名不变
        let res = change_username(
            State(state.clone()),
            conn(),
            Json(ChangeUsernameRequest {
                current_password: "wrong".into(),
                new_username: "bob".into(),
            }),
        )
        .await;
        assert!(matches!(res, Err(StatusCode::UNAUTHORIZED)));
        assert_eq!(query_username(&state).await.as_deref(), Some("alice"));

        // 新用户名非法 → 400（即使密码正确），用户名不变
        for bad in ["", "   ", "bad\nname", &"a".repeat(33)] {
            let res = change_username(
                State(state.clone()),
                conn(),
                Json(ChangeUsernameRequest {
                    current_password: "pw".into(),
                    new_username: bad.to_string(),
                }),
            )
            .await;
            assert!(matches!(res, Err(StatusCode::BAD_REQUEST)), "bad={bad:?}");
        }
        assert_eq!(query_username(&state).await.as_deref(), Some("alice"));
    }

    #[tokio::test]
    async fn set_auth_settings_partial_update_keeps_the_other_flag() {
        let state = crate::test_utils::test_state().await;

        // 两项都缺 → 400，且不落库、不改内存
        let res = set_auth_settings(
            State(state.clone()),
            Json(AuthSettingsRequest { auth_enabled: None, local_auth_required: None }),
        )
        .await;
        assert!(matches!(res, Err(StatusCode::BAD_REQUEST)));
        // 迁移预置 auth_enabled='0'（全新安装默认关闭）；本地免密无记录 = 启动默认 true
        assert_eq!(db_setting(&state, "auth_enabled").await.as_deref(), Some("0"));
        assert_eq!(db_setting(&state, SETTING_LOCAL_AUTH_REQUIRED).await, None);

        // 只改 auth_enabled → local_auth_required 保持默认（内存 true、DB 无记录）
        set_auth_settings(
            State(state.clone()),
            Json(AuthSettingsRequest { auth_enabled: Some(true), local_auth_required: None }),
        )
        .await
        .expect("partial update ok");
        assert!(state.auth_enabled.load(Ordering::Relaxed));
        assert!(state.local_auth_required.load(Ordering::Relaxed));
        assert_eq!(db_setting(&state, "auth_enabled").await.as_deref(), Some("1"));
        assert_eq!(db_setting(&state, SETTING_LOCAL_AUTH_REQUIRED).await, None);

        // 只改 local_auth_required → auth_enabled 保持刚写入的 true / "1"
        set_auth_settings(
            State(state.clone()),
            Json(AuthSettingsRequest { auth_enabled: None, local_auth_required: Some(false) }),
        )
        .await
        .expect("partial update ok");
        assert!(!state.local_auth_required.load(Ordering::Relaxed));
        assert!(state.auth_enabled.load(Ordering::Relaxed));
        assert_eq!(db_setting(&state, SETTING_LOCAL_AUTH_REQUIRED).await.as_deref(), Some("0"));
        assert_eq!(db_setting(&state, "auth_enabled").await.as_deref(), Some("1"));
    }

    #[tokio::test]
    async fn get_auth_settings_reports_flags_and_username() {
        let state = crate::test_utils::test_state().await;

        // 无用户行 → username: null
        let res = get_auth_settings(State(state.clone())).await.expect("get ok");
        assert_eq!(
            res.0,
            json!({
                "auth_enabled": false,
                "local_auth_required": true,
                "username": null
            })
        );

        setup_user(&state, Some("alice"), "pw").await;
        state.auth_enabled.store(true, Ordering::Relaxed);
        state.local_auth_required.store(false, Ordering::Relaxed);
        let res = get_auth_settings(State(state.clone())).await.expect("get ok");
        assert_eq!(
            res.0,
            json!({
                "auth_enabled": true,
                "local_auth_required": false,
                "username": "alice"
            })
        );
    }

    #[tokio::test]
    async fn check_reports_local_bypass_only_for_loopback_shape() {
        let state = crate::test_utils::test_state().await;
        state.auth_enabled.store(true, Ordering::Relaxed);
        state.local_auth_required.store(false, Ordering::Relaxed);

        // 回环形态（Host 127.0.0.1 + 对端回环）→ authenticated + local_bypass
        let res =
            check(State(state.clone()), conn(), host_headers("127.0.0.1:18777"), CookieJar::new())
                .await;
        let body = axum::body::to_bytes(res.into_response().into_body(), 64 * 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            json!({ "authenticated": true, "auth_enabled": true, "local_bypass": true })
        );

        // 远程形态（Host 域名）→ 未认证（无 cookie）
        let res = check(
            State(state.clone()),
            conn(),
            host_headers("omniterm.example.com"),
            CookieJar::new(),
        )
        .await;
        let body = axum::body::to_bytes(res.into_response().into_body(), 64 * 1024).await.unwrap();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v["authenticated"], json!(false));
        assert_eq!(v.get("local_bypass"), None);
    }
}
