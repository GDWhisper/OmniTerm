//! 端口转发反向代理：`/proxy/{port}/{*path}`。
//!
//! 需求：浏览器（机器 A）通过跑在机器 B 上的 OmniTerm 访问 B 的 localhost 服务
//! （如 `http://localhost:3000` 的 dev server）。目标 IP 永远硬编码 `127.0.0.1`，
//! 端口经白名单校验（D2），自身监听端口动态排除（防回环无限转发）。
//!
//! ## 多实现差异（AGENTS §8）
//!
//! 反向代理的「协议」= HTTP/WS，被无数 dev server 实现满足，不得以某一种（如 Vite）
//! 的行为推断全部：
//!
//! - **绝对路径资源**：Vite（`/@vite/client`、`/src/main.tsx`）、Next.js（`/_next/...`）
//!   用绝对路径，会绕过 `/proxy/{port}/` 前缀直达 omniterm-host 而 404；用 `Location`
//!   头重写 + 接受该已知限制兜底（D1）。
//! - **WS 子协议**：Vite HMR 用 `vite-hmr`、Socket.IO 自定义、graphql-ws 用
//!   `graphql-transport-ws` —— 透传 `Sec-WebSocket-Protocol`，不假设不硬编码。
//! - **Origin 校验**：部分 dev server（webpack-dev-server 等）严格校验 Origin；
//!   WS 握手统一重写 Origin 为 `http://127.0.0.1:{port}` 兜底。
//! - **Cookie 域**：目标服务可能 `Set-Cookie` 带 `Domain=localhost` 或绝对 `Path`；
//!   响应侧统一重写（D6）。

mod ws;

use axum::{
    Router,
    body::Body,
    extract::{FromRequestParts, OriginalUri, Path, Request, State, WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, StatusCode, header, request::Parts},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::any,
};
use std::ops::RangeInclusive;

use crate::AppState;

/// 可选的 `WebSocketUpgrade`：WS 握手请求为 `Some`，普通 HTTP 为 `None`。
///
/// axum 0.8 的 `WebSocketUpgrade` 只实现 `FromRequestParts`（非 WS 握手时 reject），
/// 未实现 `OptionalFromRequestParts`，故无法直接写 `Option<WebSocketUpgrade>`。
/// 此包装器把 reject 折叠为 `None`，让 `proxy_handler` 在同一路由上分流 HTTP 与 WS。
struct OptionalWebSocketUpgrade(Option<WebSocketUpgrade>);

impl<S> FromRequestParts<S> for OptionalWebSocketUpgrade
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let ws = WebSocketUpgrade::from_request_parts(parts, state).await.ok();
        Ok(Self(ws))
    }
}

/// 允许转发的端口范围（D2）：仅本地开发服务，禁止访问 <3000 的系统服务端口。
pub const ALLOWED_PORT_RANGE: RangeInclusive<u16> = 3000..=65535;

/// 黑名单端口（D2 常量表）：数据库/内部服务端口，落在 `ALLOWED_PORT_RANGE` 内也必须封。
const DENIED_PORTS: &[u16] = &[3306, 5432, 6379, 27017, 11211];

/// 黑名单端口范围（D2）：Consul、Elasticsearch 连续端口段。
const DENIED_PORT_RANGES: &[(u16, u16)] = &[(8500, 8503), (9200, 9300)];

/// 请求体上限：与 axum `DefaultBodyLimit` 一致（2MB），防大体积上传耗内存（D5）。
const MAX_REQUEST_BODY: usize = 2 * 1024 * 1024;

/// hop-by-hop 头（RFC 7230 §6.1）：只对单跳连接有意义，跨代理必须剥离、禁止透传。
const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// 端口白名单校验（D2）：允许范围 − 黑名单 − 自身监听端口（防回环）。
pub fn is_port_allowed(port: u16, self_port: u16) -> bool {
    if !ALLOWED_PORT_RANGE.contains(&port) {
        return false;
    }
    if DENIED_PORTS.contains(&port) {
        return false;
    }
    if DENIED_PORT_RANGES.iter().any(|&(lo, hi)| (lo..=hi).contains(&port)) {
        return false;
    }
    port != self_port
}

/// 代理模块状态：reqwest 客户端单例 + 自身监听端口。
#[derive(Clone)]
pub struct ProxyState {
    pub client: reqwest::Client,
    pub self_port: u16,
    /// 子域名代理 base（如 `omniterm.lan`）。`None`/空字符串 = 不启用子域名 Host 路由。
    /// 由 `--proxy-domain` / `OMNITERM_PROXY_DOMAIN` 注入（见 main.rs）。
    pub base_host: Option<String>,
}

pub fn routes(state: AppState) -> Router<AppState> {
    Router::new()
        // 单一通配符路由：path 形如 `3444`、`3444/foo/bar`（不含前导斜杠）。
        // 不拆 `/proxy/{port}` + `/proxy/{port}/{*rest}` 两条——axum 0.8 的
        // `{*rest}` 不匹配空剩余（`/proxy/3444/` 会落空），单通配符统一解析更稳。
        .route("/proxy/{*path}", any(proxy_handler))
        .route_layer(middleware::from_fn_with_state(state, crate::auth::require_auth_mw))
}

async fn proxy_handler(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    Path(path): Path<String>,
    OptionalWebSocketUpgrade(upgrade): OptionalWebSocketUpgrade,
    request: Request,
) -> Response {
    // 从通配符 path 解析端口（首个路径段），剩余路径仍以 OriginalUri 为准（D1）。
    let Some(port) = path.split('/').next().and_then(|p| p.parse::<u16>().ok()) else {
        return (StatusCode::BAD_REQUEST, "invalid port").into_response();
    };
    dispatch_proxy(state, port, uri, upgrade, request).await
}

async fn dispatch_proxy(
    state: AppState,
    port: u16,
    uri: axum::http::Uri,
    upgrade: Option<WebSocketUpgrade>,
    request: Request,
) -> Response {
    if !is_port_allowed(port, state.proxy.self_port) {
        tracing::warn!("proxy port denied: {}", port);
        return (StatusCode::FORBIDDEN, "port not allowed").into_response();
    }

    // WS 分流（P2）：`Some` 说明带 `Upgrade: websocket` 握手头。
    if let Some(ws) = upgrade {
        return ws::relay(ws, port, &uri, request.headers().clone()).await;
    }

    forward_http(state, port, uri, request).await
}

/// 从 Host 头解析子域名端口：精确匹配 `"{port}.{base}"`（可带 `:{listen_port}` 后缀）。
/// `port` 段须为纯数字，其余形式（`www.{base}`、`x3306.{base}`、`{base}` 本身）一律 `None`。
/// 大小写不敏感（DNS Host 大小写无关）。纯函数，便于单测。
pub fn parse_proxy_host(host: &str, base: &str) -> Option<u16> {
    if base.is_empty() {
        return None;
    }
    // 剥离 `:{listen_port}` 后缀（若有）。Host 头是域名场景，无 IPv6 字面量需特殊处理；
    // 即便误剥 IPv6（`[::1]:8080`），后续 `strip_suffix` 不匹配也会返回 None，安全。
    let host = host.rsplit_once(':').map(|(h, _)| h).unwrap_or(host);
    let host = host.to_ascii_lowercase();
    let base = base.to_ascii_lowercase();
    let prefix = host.strip_suffix(&format!(".{}", base))?;
    if prefix.is_empty() || !prefix.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    prefix.parse::<u16>().ok()
}

fn host_from_request(request: &Request) -> Option<&str> {
    request.headers().get(header::HOST).and_then(|v| v.to_str().ok())
}

fn is_ws_upgrade(request: &Request) -> bool {
    request
        .headers()
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// 子域名 Host 路由中间件：`{port}.{base}` 命中时直接代理，否则放行给后续路由。
///
/// 挂**最外层**（见 main.rs，仅 `base_host` 配置时挂载），先于 CorsLayer/TraceLayer/
/// Router/fallback 执行——子域名请求（如 `3000.omniterm.lan/assets/x.js`）在进入 SPA
/// fallback 前被拦截，浏览器对绝对路径资源的解析天然落到本 Host 上（D1 翻盘）。
pub async fn proxy_host_mw(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let Some(base) = state.proxy.base_host.as_deref().filter(|b| !b.is_empty()) else {
        return next.run(request).await;
    };
    let Some(host) = host_from_request(&request) else {
        return next.run(request).await;
    };
    let Some(port) = parse_proxy_host(host, base) else {
        return next.run(request).await;
    };

    // 端口白名单（D2）：WS 分支绕过 dispatch_proxy，须在此先行校验，提前 403。
    if !is_port_allowed(port, state.proxy.self_port) {
        tracing::warn!("proxy host port denied: {}", port);
        return (StatusCode::FORBIDDEN, "port not allowed").into_response();
    }

    // 鉴权：子域名入口是 middleware，不走路由层 `require_auth_mw`，必须显式校验——
    // 否则 auth 开启时 `{port}.{base}` 成开放代理（§S4/S5）。
    let token = crate::auth::extract_token(&request);
    if let Err(status) = crate::auth::verify_request(&state, token.as_deref()).await {
        return status.into_response();
    }

    // 标准化 uri 为 `/proxy/{port}{原始 path}?{原始 query}`，复用 dispatch_proxy 的
    // upstream_url 前缀剥离逻辑（子域名下 path 无 `/proxy/{port}` 前缀）。
    let orig = request.uri().clone();
    let normalized: axum::http::Uri = match orig.query() {
        Some(q) => format!("/proxy/{}{}?{}", port, orig.path(), q).parse().unwrap_or(orig.clone()),
        None => format!("/proxy/{}{}", port, orig.path()).parse().unwrap_or(orig.clone()),
    };

    if is_ws_upgrade(&request) {
        let (mut parts, _body) = request.into_parts();
        return match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
            Ok(ws) => ws::relay(ws, port, &normalized, parts.headers.clone()).await,
            Err(_) => (StatusCode::BAD_REQUEST, "invalid websocket upgrade").into_response(),
        };
    }

    dispatch_proxy(state, port, normalized, None, request).await
}

/// 构造目标上游 URL：`http://127.0.0.1:{port}/{剩余路径}?{原始 query}`。
/// 剩余路径取 `OriginalUri` 的**未解码**原始路径（D1：`strip_prefix("/proxy/{port}/")`）。
fn upstream_url(uri: &axum::http::Uri, port: u16) -> String {
    let prefix = format!("/proxy/{}", port);
    let remaining = uri.path().strip_prefix(&prefix).unwrap_or("").trim_start_matches('/');
    match uri.query() {
        Some(q) => format!("http://127.0.0.1:{}/{}?{}", port, remaining, q),
        None => format!("http://127.0.0.1:{}/{}", port, remaining),
    }
}

async fn forward_http(
    state: AppState,
    port: u16,
    uri: axum::http::Uri,
    request: Request,
) -> Response {
    let target = upstream_url(&uri, port);
    let method = request.method().clone();
    let req_headers = rewrite_request_headers(request.headers(), port, false);

    // 请求体（有界：`MAX_REQUEST_BODY`，超限直接拒绝，防无界缓冲）。
    let body = match axum::body::to_bytes(request.into_body(), MAX_REQUEST_BODY).await {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("proxy failed to read request body (port {}): {}", port, e);
            return (StatusCode::BAD_REQUEST, "failed to read body").into_response();
        }
    };

    let upstream_resp = match state
        .proxy
        .client
        .request(method, &target)
        .headers(req_headers)
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // 超时 → 504，连接拒绝/不可达 → 502（验收标准「边界与降级」）。
            let status =
                if e.is_timeout() { StatusCode::GATEWAY_TIMEOUT } else { StatusCode::BAD_GATEWAY };
            tracing::warn!("proxy upstream failed (port {}): {}", port, e);
            return (status, "upstream unreachable").into_response();
        }
    };

    let status = upstream_resp.status();
    let resp_headers = rewrite_response_headers(upstream_resp.headers(), port);
    let mut builder = Response::builder().status(status);
    if let Some(hm) = builder.headers_mut() {
        *hm = resp_headers;
    }
    // 流式回写：`Response::chunk()` + `unfold` 边读边写，绝不 collect 到内存
    // （SSE/长连接/大文件下载天然安全，D5）。不用 reqwest `stream` feature——
    // 它额外引入 wasm-streams（WASM 平台依赖），而 `chunk()` 已足够。
    let stream = futures_util::stream::unfold(upstream_resp, |mut resp| async {
        match resp.chunk().await {
            Ok(Some(chunk)) => Some((Ok::<_, std::io::Error>(chunk), resp)),
            Ok(None) => None,
            Err(e) => Some((Err(std::io::Error::other(e)), resp)),
        }
    });
    match builder.body(Body::from_stream(stream)) {
        Ok(resp) => resp,
        Err(e) => {
            tracing::error!("proxy failed to build response (port {}): {}", port, e);
            (StatusCode::INTERNAL_SERVER_ERROR, "proxy error").into_response()
        }
    }
}

fn is_hop_by_hop(name: &str) -> bool {
    HOP_BY_HOP_HEADERS.contains(&name.to_ascii_lowercase().as_str())
}

fn host_value(port: u16) -> Result<HeaderValue, header::InvalidHeaderValue> {
    HeaderValue::from_str(&format!("127.0.0.1:{}", port))
}

fn origin_value(port: u16) -> Result<HeaderValue, header::InvalidHeaderValue> {
    HeaderValue::from_str(&format!("http://127.0.0.1:{}", port))
}

/// 请求侧 header 重写（D6）：转发给上游前调用。
/// 纯函数，便于单测。
fn rewrite_request_headers(original: &HeaderMap, port: u16, is_ws: bool) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(original.len());
    for (name, value) in original.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if is_hop_by_hop(&lower) {
            continue;
        }
        match lower.as_str() {
            // Host 永远重写为本地目标，否则目标服务的虚拟主机路由错乱。
            "host" => {
                if let Ok(v) = host_value(port) {
                    out.insert(name.clone(), v);
                }
            }
            // 剥离 OmniTerm 自己的 JWT cookie，绝不泄漏给目标服务（S3/S4）。
            "cookie" => {
                if let Some(v) = strip_omniterm_token(value) {
                    out.insert(name.clone(), v);
                }
            }
            // WS 握手统一重写 Origin，兼容严格校验 Origin 的 dev server（§8）。
            "origin" if is_ws => {
                if let Ok(v) = origin_value(port) {
                    out.insert(name.clone(), v);
                }
            }
            _ => {
                out.insert(name.clone(), value.clone());
            }
        }
    }
    // 原始请求缺 Host（HTTP/1.0 等）时补上，reqwest 依赖它路由。
    if !out.contains_key(header::HOST)
        && let Ok(v) = host_value(port)
    {
        out.insert(header::HOST, v);
    }
    out
}

/// 从 `Cookie` 头剥离 `omniterm_token=...` 项（D2 cookie 隔离）。
/// 剥离后为空则返回 `None`（整头丢弃）。
fn strip_omniterm_token(value: &HeaderValue) -> Option<HeaderValue> {
    let s = value.to_str().ok()?;
    let kept: Vec<&str> = s
        .split(';')
        .map(str::trim)
        .filter(|p| !p.is_empty() && !p.starts_with("omniterm_token="))
        .collect();
    if kept.is_empty() {
        return None;
    }
    HeaderValue::from_str(&kept.join("; ")).ok()
}

/// 响应侧 header 重写（D6）：流式转发前调用。纯函数，返回重写后的 HeaderMap。
fn rewrite_response_headers(original: &HeaderMap, port: u16) -> HeaderMap {
    let mut out = HeaderMap::with_capacity(original.len());
    for (name, value) in original.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if is_hop_by_hop(&lower) {
            continue;
        }
        match lower.as_str() {
            // 流式转发丢弃 Content-Length 改 chunked（上游可能压缩，长度不可靠）。
            "content-length" => {}
            // Set-Cookie 可能多个，append 保留全部；其余单值头 insert 覆盖。
            "set-cookie" => {
                if let Ok(v) = rewrite_set_cookie(value, port) {
                    out.append(name.clone(), v);
                }
            }
            "location" => {
                out.insert(name.clone(), rewrite_location(value, port));
            }
            _ => {
                out.insert(name.clone(), value.clone());
            }
        }
    }
    out
}

/// 响应 `Location` 头重写（D6）：
/// - 绝对路径 `/x` → `/proxy/{port}/x`（跳过协议相对 `//host`）；
/// - 指向本机目标的完整 URL → 相对化到代理前缀；
/// - 外部 `https://…` 保持不动。
fn rewrite_location(value: &HeaderValue, port: u16) -> HeaderValue {
    let Ok(s) = value.to_str() else {
        return value.clone();
    };
    let prefix = format!("/proxy/{}", port);
    if let Some(rest) = s.strip_prefix('/')
        && !rest.starts_with('/')
        && let Ok(v) = HeaderValue::from_str(&format!("{}/{}", prefix, rest))
    {
        return v;
    }
    for base in [format!("http://localhost:{}", port), format!("http://127.0.0.1:{}", port)] {
        if let Some(rest) = s.strip_prefix(&base)
            && let Ok(v) = HeaderValue::from_str(&format!("{}{}", prefix, rest))
        {
            return v;
        }
    }
    value.clone()
}

/// 响应 `Set-Cookie` 重写（D6）：
/// - 剥离 `Domain=localhost` / `Domain=127.0.0.1`（避免 cookie 域绑定到错误主机）；
/// - `Path` 补 `/proxy/{port}` 前缀（避免 cookie 作用于代理之外的路径）。
fn rewrite_set_cookie(value: &HeaderValue, port: u16) -> Result<HeaderValue, ()> {
    let s = value.to_str().map_err(|_| ())?;
    let mut parts: Vec<String> = Vec::new();
    for seg in s.split(';') {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        let lower = seg.to_ascii_lowercase();
        if lower.starts_with("domain=") {
            let domain = seg[7..].trim_matches('"').to_ascii_lowercase();
            if domain == "localhost" || domain == "127.0.0.1" {
                continue;
            }
        } else if lower.starts_with("path=") {
            let path = seg[5..].trim().trim_matches('"');
            let new_path = if path.is_empty() || path == "/" {
                format!("/proxy/{}/", port)
            } else if path.starts_with('/') {
                format!("/proxy/{}{}", port, path)
            } else {
                format!("/proxy/{}/{}", port, path)
            };
            parts.push(format!("Path={}", new_path));
            continue;
        }
        parts.push(seg.to_string());
    }
    if parts.is_empty() {
        return Err(());
    }
    HeaderValue::from_str(&parts.join("; ")).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_allowlist_rejects_low_ports() {
        assert!(!is_port_allowed(80, 9777));
        assert!(!is_port_allowed(2999, 9777));
        assert!(!is_port_allowed(22, 9777));
    }

    #[test]
    fn port_allowlist_rejects_denylisted_ports() {
        for &p in DENIED_PORTS {
            assert!(!is_port_allowed(p, 9777), "port {p} should be denied");
        }
        assert!(!is_port_allowed(8501, 9777), "Consul range denied");
        assert!(!is_port_allowed(9200, 9777), "ES range denied");
    }

    #[test]
    fn port_allowlist_rejects_self_port() {
        assert!(!is_port_allowed(9777, 9777), "self port must not loop back");
        assert!(!is_port_allowed(9077, 9077));
    }

    #[test]
    fn port_allowlist_accepts_dev_ports() {
        assert!(is_port_allowed(3000, 9777));
        assert!(is_port_allowed(5173, 9777));
        assert!(is_port_allowed(65535, 9777));
    }

    #[test]
    fn request_headers_strip_hop_by_hop() {
        let mut h = HeaderMap::new();
        h.insert("connection", HeaderValue::from_static("keep-alive"));
        h.insert("upgrade", HeaderValue::from_static("websocket"));
        h.insert("te", HeaderValue::from_static("trailers"));
        h.insert("keep-alive", HeaderValue::from_static("timeout=5"));
        let out = rewrite_request_headers(&h, 3000, false);
        assert!(!out.contains_key("connection"));
        assert!(!out.contains_key("upgrade"));
        assert!(!out.contains_key("te"));
        assert!(!out.contains_key("keep-alive"));
    }

    #[test]
    fn request_headers_rewrite_host() {
        let mut h = HeaderMap::new();
        h.insert("host", HeaderValue::from_static("example.com:9077"));
        let out = rewrite_request_headers(&h, 3000, false);
        assert_eq!(out["host"], "127.0.0.1:3000");
    }

    #[test]
    fn request_headers_inject_host_when_missing() {
        let h = HeaderMap::new();
        let out = rewrite_request_headers(&h, 5173, false);
        assert_eq!(out["host"], "127.0.0.1:5173");
    }

    #[test]
    fn request_headers_strip_omniterm_token_from_cookie() {
        let mut h = HeaderMap::new();
        h.insert(
            "cookie",
            HeaderValue::from_static("sid=abc; omniterm_token=secret.jwt; theme=dark"),
        );
        let out = rewrite_request_headers(&h, 3000, false);
        let cookie = out["cookie"].to_str().unwrap();
        assert!(cookie.contains("sid=abc"));
        assert!(cookie.contains("theme=dark"));
        assert!(!cookie.contains("omniterm_token"));
    }

    #[test]
    fn request_headers_drop_cookie_when_only_token() {
        let mut h = HeaderMap::new();
        h.insert("cookie", HeaderValue::from_static("omniterm_token=secret.jwt"));
        let out = rewrite_request_headers(&h, 3000, false);
        assert!(!out.contains_key("cookie"));
    }

    #[test]
    fn request_headers_rewrite_origin_only_for_ws() {
        let mut h = HeaderMap::new();
        h.insert("origin", HeaderValue::from_static("http://example.com"));
        // 普通 HTTP：Origin 保留
        let out_http = rewrite_request_headers(&h, 3000, false);
        assert_eq!(out_http["origin"], "http://example.com");
        // WS：Origin 重写为本地目标
        let out_ws = rewrite_request_headers(&h, 3000, true);
        assert_eq!(out_ws["origin"], "http://127.0.0.1:3000");
    }

    #[test]
    fn strip_omniterm_token_pure() {
        let v = HeaderValue::from_static("a=1; omniterm_token=x.y.z; b=2");
        let out = strip_omniterm_token(&v).unwrap();
        assert_eq!(out.to_str().unwrap(), "a=1; b=2");
        let only = HeaderValue::from_static("omniterm_token=x");
        assert!(strip_omniterm_token(&only).is_none());
    }

    #[test]
    fn location_rewrites_absolute_path() {
        let v = HeaderValue::from_static("/foo/bar");
        assert_eq!(rewrite_location(&v, 3000).to_str().unwrap(), "/proxy/3000/foo/bar");
        let root = HeaderValue::from_static("/");
        assert_eq!(rewrite_location(&root, 3000).to_str().unwrap(), "/proxy/3000/");
    }

    #[test]
    fn location_rewrites_local_origin_url() {
        let v = HeaderValue::from_static("http://localhost:3000/x");
        assert_eq!(rewrite_location(&v, 3000).to_str().unwrap(), "/proxy/3000/x");
        let v2 = HeaderValue::from_static("http://127.0.0.1:3000/");
        assert_eq!(rewrite_location(&v2, 3000).to_str().unwrap(), "/proxy/3000/");
    }

    #[test]
    fn location_keeps_external_url() {
        let v = HeaderValue::from_static("https://example.com/x");
        assert_eq!(rewrite_location(&v, 3000).to_str().unwrap(), "https://example.com/x");
        // 协议相对 URL 也不动
        let v2 = HeaderValue::from_static("//cdn.example.com/x");
        assert_eq!(rewrite_location(&v2, 3000).to_str().unwrap(), "//cdn.example.com/x");
    }

    #[test]
    fn set_cookie_strips_localhost_domain_and_prefixes_path() {
        let v = HeaderValue::from_static("sid=1; Path=/; Domain=localhost; HttpOnly");
        let out = rewrite_set_cookie(&v, 3000).unwrap().to_str().unwrap().to_string();
        assert!(!out.to_lowercase().contains("domain=localhost"));
        assert!(out.contains("Path=/proxy/3000/"));
        assert!(out.contains("HttpOnly"));
    }

    #[test]
    fn set_cookie_prefixes_non_root_path() {
        let v = HeaderValue::from_static("sid=1; Path=/api");
        let out = rewrite_set_cookie(&v, 3000).unwrap();
        assert_eq!(out.to_str().unwrap(), "sid=1; Path=/proxy/3000/api");
    }

    #[test]
    fn upstream_url_builds_remaining_path_and_query() {
        let uri: axum::http::Uri = "/proxy/3000/a/b?x=1&y=2".parse().unwrap();
        assert_eq!(upstream_url(&uri, 3000), "http://127.0.0.1:3000/a/b?x=1&y=2");
        let uri: axum::http::Uri = "/proxy/3000/".parse().unwrap();
        assert_eq!(upstream_url(&uri, 3000), "http://127.0.0.1:3000/");
    }

    #[test]
    fn proxy_host_parses_port_subdomain() {
        assert_eq!(parse_proxy_host("3000.omniterm.lan", "omniterm.lan"), Some(3000));
        assert_eq!(parse_proxy_host("5173.omniterm.lan", "omniterm.lan"), Some(5173));
    }

    #[test]
    fn proxy_host_strips_listen_port() {
        assert_eq!(parse_proxy_host("3000.omniterm.lan:9777", "omniterm.lan"), Some(3000));
    }

    #[test]
    fn proxy_host_rejects_non_digit_prefix() {
        assert_eq!(parse_proxy_host("www.omniterm.lan", "omniterm.lan"), None);
        assert_eq!(parse_proxy_host("x3306.omniterm.lan", "omniterm.lan"), None);
        assert_eq!(parse_proxy_host("omniterm.lan", "omniterm.lan"), None);
    }

    #[test]
    fn proxy_host_rejects_mismatched_base() {
        assert_eq!(parse_proxy_host("3000.example.com", "omniterm.lan"), None);
        assert_eq!(parse_proxy_host("3000.omniterm.lan", ""), None);
    }

    #[test]
    fn proxy_host_is_case_insensitive() {
        assert_eq!(parse_proxy_host("3000.OMNITERM.LAN", "omniterm.lan"), Some(3000));
        assert_eq!(parse_proxy_host("3000.omniterm.lan", "OMNITERM.LAN"), Some(3000));
    }

    #[test]
    fn proxy_host_supports_multi_level_base() {
        assert_eq!(
            parse_proxy_host("3000.omniterm.example.com", "omniterm.example.com"),
            Some(3000)
        );
    }

    #[test]
    fn proxy_host_parses_denylisted_port_for_later_allowlist_check() {
        // parse 只负责「解析出纯数字端口」，白名单拒绝由 is_port_allowed 负责。
        assert_eq!(parse_proxy_host("3306.omniterm.lan", "omniterm.lan"), Some(3306));
        assert!(!is_port_allowed(3306, 9777));
    }
}
