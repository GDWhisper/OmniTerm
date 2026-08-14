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
use std::sync::OnceLock;

use futures_util::StreamExt;
use regex::Regex;

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

/// HTML 响应体重写上限：超过则不重写、原样流式透传（HTML 页面通常 < 1MiB）。
const REWRITE_HTML_MAX: usize = 4 * 1024 * 1024;

/// JS 响应体重写上限：单文件主包（如 new-api 9.2MB）可能较大，放宽到 16MiB。
const REWRITE_JS_MAX: usize = 16 * 1024 * 1024;

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

    // 响应体重写（D1 兜底）：绝对路径 SPA（new-api 等）的 HTML 资源与 JS 内
    // `/api/` 字面量是根绝对路径，路径前缀方案下会绕过 `/proxy/{port}/` 直达
    // omniterm-host 而 404 → 白屏。局域网纯 IP 场景无法子域名（`3000.192.168.5.216`
    // 非法），Service Worker 需 secure context 也不可用——唯一通用手段是后端对
    // HTML/JS 响应做字节级前缀重写（见 plan 勘误与 backend.md）。
    let content_type = upstream_resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    if let Some(kind) = RewriteKind::from_content_type(&content_type) {
        match try_rewrite_body(upstream_resp, kind, port).await {
            Ok(RewriteOutcome::Done(body)) => {
                return match builder.body(Body::from(body)) {
                    Ok(resp) => resp,
                    Err(e) => {
                        tracing::error!("proxy failed to build response (port {}): {}", port, e);
                        (StatusCode::INTERNAL_SERVER_ERROR, "proxy error").into_response()
                    }
                };
            }
            Ok(RewriteOutcome::Fallthrough(head, resp)) => {
                // 超限放弃重写：已读头部拼回流前部，继续流式透传（D5 有界缓冲）。
                let head_stream = futures_util::stream::iter(
                    head.chunks(64 * 1024)
                        .map(|c| Ok::<_, std::io::Error>(axum::body::Bytes::copy_from_slice(c)))
                        .collect::<Vec<_>>(),
                );
                let stream = head_stream.chain(body_stream(resp));
                return match builder.body(Body::from_stream(stream)) {
                    Ok(resp) => resp,
                    Err(e) => {
                        tracing::error!("proxy failed to build response (port {}): {}", port, e);
                        (StatusCode::INTERNAL_SERVER_ERROR, "proxy error").into_response()
                    }
                };
            }
            Err(e) => {
                tracing::warn!("proxy failed to read body for rewrite (port {}): {}", port, e);
                return (StatusCode::BAD_GATEWAY, "upstream unreachable").into_response();
            }
        }
    }

    // 流式回写：`Response::chunk()` + `unfold` 边读边写，绝不 collect 到内存
    // （SSE/长连接/大文件下载天然安全，D5）。不用 reqwest `stream` feature——
    // 它额外引入 wasm-streams（WASM 平台依赖），而 `chunk()` 已足够。
    match builder.body(Body::from_stream(body_stream(upstream_resp))) {
        Ok(resp) => resp,
        Err(e) => {
            tracing::error!("proxy failed to build response (port {}): {}", port, e);
            (StatusCode::INTERNAL_SERVER_ERROR, "proxy error").into_response()
        }
    }
}

/// 响应体流（chunk 边读边写，不 collect）——HTTP 转发公共尾部。
fn body_stream(
    resp: reqwest::Response,
) -> impl futures_util::Stream<Item = Result<axum::body::Bytes, std::io::Error>> {
    futures_util::stream::unfold(resp, |mut resp| async {
        match resp.chunk().await {
            Ok(Some(chunk)) => Some((Ok::<_, std::io::Error>(chunk), resp)),
            Ok(None) => None,
            Err(e) => Some((Err(std::io::Error::other(e)), resp)),
        }
    })
}

/// 响应体重写类型：按 Content-Type 决定是否把根绝对路径前缀化。
#[derive(Clone, Copy, Debug, PartialEq)]
enum RewriteKind {
    /// HTML：重写 `src`/`href`/`srcset`/`action`/`poster` 属性。
    Html,
    /// JS：重写字符串字面量 `"/api/`、`'/api/`、`` `/api/ ``。
    Js,
}

impl RewriteKind {
    fn from_content_type(ct: &str) -> Option<Self> {
        match ct {
            "text/html" => Some(Self::Html),
            "text/javascript" | "application/javascript" | "application/x-javascript" => {
                Some(Self::Js)
            }
            _ => None,
        }
    }

    fn max_bytes(self) -> usize {
        match self {
            Self::Html => REWRITE_HTML_MAX,
            Self::Js => REWRITE_JS_MAX,
        }
    }
}

/// 响应体缓冲重写结果：`Done` 完整重写；`Fallthrough` 超限回退（已读前缀 + 剩余响应流）。
enum RewriteOutcome {
    Done(Vec<u8>),
    Fallthrough(Vec<u8>, reqwest::Response),
}

/// 缓冲读取 + 重写。超过 `kind.max_bytes()` 上限立即放弃重写（回退流式透传，
/// 已读部分拼回流前部），保证大文件下载不被阻塞（D5 有界缓冲）。
async fn try_rewrite_body(
    mut resp: reqwest::Response,
    kind: RewriteKind,
    port: u16,
) -> Result<RewriteOutcome, reqwest::Error> {
    let limit = kind.max_bytes();
    let mut buf = Vec::with_capacity(64 * 1024);
    while let Some(c) = resp.chunk().await? {
        if buf.len() + c.len() > limit {
            return Ok(RewriteOutcome::Fallthrough(buf, resp));
        }
        buf.extend_from_slice(&c);
    }
    let out = match kind {
        RewriteKind::Html => rewrite_html(&buf, port),
        RewriteKind::Js => rewrite_js(&buf, port),
    };
    Ok(RewriteOutcome::Done(out))
}

/// HTML 属性重写正则（惰性编译）：`src`/`href`/`srcset`/`action`/`poster` 单双引号属性。
static HTML_ATTR_RE: OnceLock<Regex> = OnceLock::new();

/// JS API 字面量重写正则（惰性编译）：双/单/反引号后紧跟 `/api/`。
static JS_API_RE: OnceLock<Regex> = OnceLock::new();

/// HTML 内根绝对路径资源属性 → `/proxy/{port}` 前缀（D1 兜底）。
/// 覆盖 `src`/`href`/`srcset`/`action`/`poster`（单双引号皆可）：
/// - `src="/assets/x.js"` → `src="/proxy/3000/assets/x.js"`
/// - 外部 URL（`https://…`）、协议相对（`//cdn…`）、已带前缀（`/proxy/{port}/…`）不动
/// - `srcset` 逗号分隔多项逐个重写（`/a.png 1x, /b.png 2x`）
fn rewrite_html(body: &[u8], port: u16) -> Vec<u8> {
    let s = String::from_utf8_lossy(body);
    let prefix = format!("/proxy/{}", port);
    let re = HTML_ATTR_RE.get_or_init(|| {
        // 不用反向引用 `\2`（regex crate 不支持）：组 3 匹配值（不含引号，遇引号即停），
        // 组 4 捕获闭合引号一并消费，重建时用组 2/4 的引号还原（HTML 实体 `&quot;` 不影响）。
        Regex::new(r#"(?i)(src|href|srcset|action|poster)=(["'])([^"']*)(["'])"#)
            .expect("valid html attr regex")
    });
    re.replace_all(&s, |caps: &regex::Captures| {
        let attr = &caps[1];
        let quote = &caps[2];
        let value = rewrite_attr_value(&caps[3], &prefix);
        format!("{}={}{}{}", attr, quote, value, &caps[4])
    })
    .into_owned()
    .into_bytes()
}

/// 单个 HTML 属性值重写：根绝对路径（`/x`）→ `/proxy/{port}/x`；其余原样。
fn rewrite_attr_value(value: &str, prefix: &str) -> String {
    // 已带任何 /proxy/ 前缀（含其他端口）一律跳过，防二次叠加。
    if value.starts_with("/proxy/") {
        return value.to_string();
    }
    // srcset 逗号分隔多候选：`/a.png 1x, /b.png 2x`——逐项重写 URL 部分。
    if value.contains(',') {
        return value
            .split(',')
            .map(|item| {
                let t = item.trim();
                if t.starts_with('/') && !t.starts_with("//") {
                    let (url, desc) = match t.split_once(char::is_whitespace) {
                        Some((u, d)) => (u, d),
                        None => (t, ""),
                    };
                    let mut out = format!("{}{}", prefix, url);
                    if !desc.is_empty() {
                        out.push(' ');
                        out.push_str(desc);
                    }
                    out
                } else {
                    t.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(", ");
    }
    if value.starts_with('/') && !value.starts_with("//") {
        format!("{}{}", prefix, value)
    } else {
        value.to_string()
    }
}

/// JS 内 API 路径字面量 → `/proxy/{port}` 前缀（D1 兜底）。
/// 匹配 `"/api/`、`'/api/`、`` `/api/ ``（双/单/反引号字符串与模板字符串），
/// 统一加前缀。**全局一致重写**保证比较逻辑自洽：请求路径与 `===` 比较的字面量
/// 同步带前缀（如 new-api 的 `Y==="/api/ratio_config"`）。
/// 不匹配：非引号开头（变量拼接、正则字面量）、注释与 i18n 文案（加前缀无害）。
fn rewrite_js(body: &[u8], port: u16) -> Vec<u8> {
    let s = String::from_utf8_lossy(body);
    let prefix = format!("/proxy/{}", port);
    let re = JS_API_RE.get_or_init(|| Regex::new(r#"(["'`])/api/"#).expect("valid js api regex"));
    let replacement = format!("$1{}/api/", prefix);
    re.replace_all(&s, replacement).into_owned().into_bytes()
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

    // ── 响应体重写（D1 兜底）──

    fn html(s: &str) -> String {
        String::from_utf8(rewrite_html(s.as_bytes(), 3000)).unwrap()
    }

    fn js(s: &str) -> String {
        String::from_utf8(rewrite_js(s.as_bytes(), 3000)).unwrap()
    }

    #[test]
    fn rewrite_html_prefixes_absolute_src_and_href() {
        let out = html(r#"<script src="/assets/index-x.js"></script><link href="/logo.svg?v=2">"#);
        assert_eq!(
            out,
            r#"<script src="/proxy/3000/assets/index-x.js"></script><link href="/proxy/3000/logo.svg?v=2">"#
        );
    }

    #[test]
    fn rewrite_html_supports_single_quotes_and_other_attrs() {
        let out = html(r#"<form action='/submit'><img src='/img/a.png'><video poster='/p.jpg'>"#);
        assert_eq!(
            out,
            r#"<form action='/proxy/3000/submit'><img src='/proxy/3000/img/a.png'><video poster='/proxy/3000/p.jpg'>"#
        );
    }

    #[test]
    fn rewrite_html_srcset_rewrites_each_candidate() {
        let out = html(r#"<img srcset="/a.png 1x, /b.png 2x, https://cdn/x.png 3x">"#);
        assert_eq!(
            out,
            r#"<img srcset="/proxy/3000/a.png 1x, /proxy/3000/b.png 2x, https://cdn/x.png 3x">"#
        );
    }

    #[test]
    fn rewrite_html_keeps_external_and_scheme_relative() {
        let out = html(
            r##"<a href="https://example.com/x"><a href="//cdn.example.com/y"><a href="mailto:a@b.c"><a href="#anchor">"##,
        );
        assert_eq!(
            out,
            r##"<a href="https://example.com/x"><a href="//cdn.example.com/y"><a href="mailto:a@b.c"><a href="#anchor">"##
        );
    }

    #[test]
    fn rewrite_html_keeps_already_prefixed() {
        let out = html(
            r#"<script src="/proxy/3000/assets/x.js"></script><script src="/proxy/9999/assets/y.js"></script>"#,
        );
        // 已带任何 /proxy/ 前缀（含其他端口）不再叠加
        assert_eq!(
            out,
            r#"<script src="/proxy/3000/assets/x.js"></script><script src="/proxy/9999/assets/y.js"></script>"#
        );
    }

    #[test]
    fn rewrite_html_keeps_relative_and_non_attr_paths() {
        let out = html(r#"<img src="assets/x.js"><script>const p = "/api/health";</script>"#);
        // 相对路径不动；内联 JS 的字符串不在 HTML 属性重写范围
        assert_eq!(out, r#"<img src="assets/x.js"><script>const p = "/api/health";</script>"#);
    }

    #[test]
    fn rewrite_js_prefixes_double_single_and_template_strings() {
        let out =
            js(r#"fe.post("/api/card/batch");get('/api/user');req(`/api/card/${id}/renew`);"#);
        assert_eq!(
            out,
            r#"fe.post("/proxy/3000/api/card/batch");get('/proxy/3000/api/user');req(`/proxy/3000/api/card/${id}/renew`);"#
        );
    }

    #[test]
    fn rewrite_js_keeps_comparison_consistent() {
        // 全局一致重写：请求路径与 === 比较字面量同步带前缀，逻辑自洽。
        let out = js(
            r#"const A = Y === "/api/ratio_config" ? "ratio_config" : Y === "/api/pricing" ? "pricing" : "";"#,
        );
        assert_eq!(
            out,
            r#"const A = Y === "/proxy/3000/api/ratio_config" ? "ratio_config" : Y === "/proxy/3000/api/pricing" ? "pricing" : "";"#
        );
    }

    #[test]
    fn rewrite_js_keeps_non_api_strings() {
        let out = js(
            r#"const a = "/foo"; const b = "http://x/api/v1"; const c = /\/api\//; const d = 'api/rel';"#,
        );
        // 非 `/api/` 字面量（根路径外、协议内、正则、相对路径）一律不动
        assert_eq!(
            out,
            r#"const a = "/foo"; const b = "http://x/api/v1"; const c = /\/api\//; const d = 'api/rel';"#
        );
    }

    #[test]
    fn rewrite_kind_matches_content_types() {
        assert_eq!(RewriteKind::from_content_type("text/html"), Some(RewriteKind::Html));
        assert_eq!(RewriteKind::from_content_type("text/html; charset=utf-8"), None);
        // 带 charset 的由调用方 split(';') 后传入，此处只吃纯类型
        assert_eq!(RewriteKind::from_content_type("text/javascript"), Some(RewriteKind::Js));
        assert_eq!(RewriteKind::from_content_type("application/javascript"), Some(RewriteKind::Js));
        assert_eq!(RewriteKind::from_content_type("application/json"), None);
        assert_eq!(RewriteKind::from_content_type("text/css"), None);
    }

    #[test]
    fn rewrite_max_bytes_limits() {
        assert_eq!(RewriteKind::Html.max_bytes(), REWRITE_HTML_MAX);
        assert_eq!(RewriteKind::Js.max_bytes(), REWRITE_JS_MAX);
    }
}
