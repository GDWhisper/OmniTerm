//! WS 入口的 CSWSH 防御：Origin 与 Host 一致性校验。
//!
//! 威胁模型（见 `docs/reference/auth-not-enforced.md` 「CSWSH 防护」）：
//! 用户在浏览器登录 OmniTerm 后，访问恶意网页 evil.com；evil.com 的
//! JavaScript 可对 OmniTerm 的 WS 入口 `new WebSocket("ws://omniterm/api/v1/ws/terminal/…")`
//! 发起握手。浏览器**自动携带**已登录的 cookie（SameSite=Lax 只挡住跨站
//! POST 表单，**不挡 WS 握手**），于是恶意页面借受害者的会话驱动终端/agent。
//! 这与「借 cookie 跨站发请求」同族，但 WS 握手不吃 CORS 的同源赦免。
//!
//! 判据（与代理入口 `src/proxy/mod.rs` 的 CSWSH 防御同一口径，单一真源）：
//! **Origin 的 host（忽略端口）与请求 Host（忽略端口）不一致 → 403**。
//! 浏览器发起的握手必带 `Origin`，它的 scheme+host 就是发起页面的来源；
//! 同源页面（`http://omniterm` → `Origin: http://omniterm`）自然匹配。
//!
//! 两条显式放行（**不得合并、不得收紧**）：
//!
//! 1. **无 `Origin` 头 = 放行**。CSWSH 只能由浏览器触发（浏览器对 WS 握手
//!    必带 Origin），curl / 原生 WS 客户端 / Node 脚本同样在威胁模型之外。
//!    一律拒绝会打死 `tests/agent_hook_integration.rs` 的裸握手回归、
//!    `scripts/pty-*-regression.mjs`（Node 22 `WebSocket` 实测不发 Origin，
//!    见下）与移动端调试工具。
//! 2. **无 `Host` 头 = 放行**。HTTP/1.1 规范要求必带 Host；无 Host 的请求
//!    不可能来自浏览器（Origin 与 Host 都不会缺），属畸形/非浏览器流量。
//!
//! 为什么不做静态 Origin 白名单：代理子域名形态（`{port}.{base_host}`，见
//! 2026-08-13 计划 D1）下 host 随被代理端口动态变化，白名单无法枚举；
//! host 一致性比对天然覆盖该场景，且不需要新增配置项。

use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

/// WS 入口统一防跨站劫持（CSWSH）校验。
///
/// 在 `on_upgrade` **之前**调用：拒绝时直接返回 403 响应，不升级连接。
/// 放行时返回 `None`，调用方照常 `on_upgrade`。
///
/// 返回的响应体文案与代理入口逐字一致（`src/proxy/mod.rs` 的 403 分支），
/// 便于按同一关键词检索两边日志。
pub fn enforce_ws_origin(headers: &HeaderMap) -> Option<Response> {
    let host = host_from_headers(headers)?;
    // http crate 的 HeaderMap 对 ORIGIN 这类声明过的头仍可 `append` 出多值
    // （`append` 不看单值声明，只有 `insert` 才去重），`get` 取**首值**。
    // 安全性依赖「取首值后与 Host 比对」，而非「HeaderMap 保证单值」——
    // 故**不得**改成「任一值与 Host 匹配即放行」，否则攻击者把合法值排在
    // 恶意值前面即可绕过。见 `enforce_ws_origin_rejects_when_first_of_multiple_values_is_cross_site`。
    let origin = headers.get(header::ORIGIN)?;
    if origin_matches_host(origin, host) {
        return None;
    }
    tracing::warn!("ws origin rejected: origin={:?} host={}", origin, host);
    Some((StatusCode::FORBIDDEN, "origin not allowed").into_response())
}

/// `Host` 头文本；缺失或非 UTF-8 时 `None`（放行路径）。
///
/// proxy 侧另有一个取 `&Request` 的 [`crate::proxy::host_from_request`] 薄包装
/// （它持 `&Request` 是为 WS/HTTP 分流上下文，见 2026-08-13 计划勘误⑤：
/// 共享函数不能持 `&Request` 跨 await）。**Host 的取值语义以此处为真源**，
/// 若将来要支持 `X-Forwarded-Host`，两处必须同步改——它们守卫同一道攻击面。
pub fn host_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::HOST).and_then(|v| v.to_str().ok())
}

/// 从 `Origin` 头值提取 host 部分：去端口，并截断 `/:?#` 之后的路径/query/fragment。
/// 非 UTF-8 / 无 `scheme://` / host 段为空 → `None`（调用方按拒绝处理）。
///
/// [`origin_matches_host`] 与 `crate::auth::local_access::is_local_request` 的条件 3
/// 共用本函数——**Origin 解析只有这一份**（AGENTS §7①）。
pub fn origin_host(origin: &HeaderValue) -> Option<&str> {
    let o = origin.to_str().ok()?;
    let authority = o.split_once("://").map(|(_, rest)| rest)?;
    let host = authority.split(['/', '?', '#']).next().unwrap_or("");
    let host = strip_port(host);
    (!host.is_empty()).then_some(host)
}

/// WS Origin 校验：Origin 的 host（忽略端口）与请求 Host（忽略端口）比对。
/// `Origin: http://3000.omniterm.lan:9777` 与 Host `3000.omniterm.lan:9777` → 匹配。
/// 解析失败 / host 为空 → 拒绝（防御畸形 Origin）。纯函数，便于单测。
///
/// 本函数同时代理入口 `ws::relay` 前的 CSWSH 校验使用，是**唯一真源**。
pub fn origin_matches_host(origin: &HeaderValue, host: &str) -> bool {
    match origin_host(origin) {
        Some(origin_host) => origin_host.eq_ignore_ascii_case(strip_port(host)),
        None => false,
    }
}

/// 剥离 `:port` 后缀；IPv6 字面量（`[::1]:8080`）整体保留方括号内地址。
///
/// 方括号形态只接受 `[v6]` 与 `[v6]:port`（port 非空且全为数字）；畸形方括号串
/// （如 `[::1]@evil.com` / `[::1]:80@evil.com`）**原样返回**，由调用方按解析失败
/// 处理（`parse::<IpAddr>()` 不通过 → 非回环 / 不匹配），不得截出括号内地址。
pub fn strip_port(s: &str) -> &str {
    let Some(rest) = s.strip_prefix('[') else {
        return s.split(':').next().unwrap_or(s);
    };
    let Some((host, tail)) = rest.split_once(']') else { return s };
    let port_ok = match tail.strip_prefix(':') {
        Some(port) => !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()),
        None => tail.is_empty(),
    };
    if port_ok { host } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_map(entries: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in entries {
            let name: header::HeaderName = k.parse().unwrap();
            h.insert(name, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    // ── 入口级判定（enforce_ws_origin）──────────────────────────

    #[test]
    fn enforce_ws_origin_allows_same_origin() {
        let h = header_map(&[("host", "127.0.0.1:9077"), ("origin", "http://127.0.0.1:9077")]);
        assert!(enforce_ws_origin(&h).is_none());
    }

    #[test]
    fn enforce_ws_origin_allows_origin_port_differing_from_host() {
        // 端口与 `strip_port` 无关：Origin scheme 不同但同 host（部署在
        // https 反代后、前端同源访问）同样放行。
        let h = header_map(&[("host", "omniterm.lan:443"), ("origin", "https://omniterm.lan")]);
        assert!(enforce_ws_origin(&h).is_none());
    }

    #[test]
    fn enforce_ws_origin_allows_subdomain_host() {
        // 代理子域形态：Origin host 与请求 Host 一致
        let h = header_map(&[
            ("host", "3000.omniterm.lan:9777"),
            ("origin", "http://3000.omniterm.lan:9777"),
        ]);
        assert!(enforce_ws_origin(&h).is_none());
    }

    #[test]
    fn enforce_ws_origin_rejects_cross_site() {
        let h = header_map(&[("host", "127.0.0.1:9077"), ("origin", "https://evil.com")]);
        let resp = enforce_ws_origin(&h).expect("cross-site must be rejected");
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn enforce_ws_origin_rejects_malformed_origin() {
        // 畸形 Origin（无 scheme）→ 拒绝（不因解析失败而放行）
        let h = header_map(&[("host", "127.0.0.1:9077"), ("origin", "127.0.0.1:9077")]);
        assert!(enforce_ws_origin(&h).is_some());
    }

    #[test]
    fn enforce_ws_origin_allows_missing_origin() {
        // 非浏览器客户端（curl / Node WebSocket / 原生 WS）无 Origin → 放行。
        // CSWSH 只能由浏览器触发；一律拒绝会打死裸握手回归与脚本工具。
        let h = header_map(&[("host", "127.0.0.1:9077")]);
        assert!(enforce_ws_origin(&h).is_none());
    }

    #[test]
    fn enforce_ws_origin_allows_missing_host() {
        // HTTP/1.1 规定必带 Host；缺失即非浏览器流量，放行。
        let h = header_map(&[("origin", "http://127.0.0.1:9077")]);
        assert!(enforce_ws_origin(&h).is_none());
    }

    #[test]
    fn enforce_ws_origin_allows_empty_header_map() {
        assert!(enforce_ws_origin(&HeaderMap::new()).is_none());
    }

    // ── 纯函数判定（origin_matches_host / strip_port）──────────

    #[test]
    fn origin_matches_subdomain_host() {
        let o = HeaderValue::from_static("http://3000.omniterm.lan:9777");
        assert!(origin_matches_host(&o, "3000.omniterm.lan:9777"));
        let o2 = HeaderValue::from_static("https://3000.omniterm.lan");
        assert!(origin_matches_host(&o2, "3000.omniterm.lan"));
    }

    #[test]
    fn origin_rejects_cross_site() {
        let o = HeaderValue::from_static("https://evil.com");
        assert!(!origin_matches_host(&o, "3000.omniterm.lan"));
        let o2 = HeaderValue::from_static("3000.omniterm.lan");
        assert!(!origin_matches_host(&o2, "3000.omniterm.lan"));
    }

    #[test]
    fn strip_port_keeps_ipv6_literal() {
        assert_eq!(strip_port("3000.omniterm.lan:9777"), "3000.omniterm.lan");
        assert_eq!(strip_port("192.168.5.216:9077"), "192.168.5.216");
        assert_eq!(strip_port("3000.omniterm.lan"), "3000.omniterm.lan");
        // IPv6：方括号内地址整体保留
        assert_eq!(strip_port("[::1]:8080"), "::1");
        assert_eq!(strip_port("[::1]"), "::1");
    }

    #[test]
    fn strip_port_rejects_garbage_after_bracket() {
        // 畸形方括号串原样返回（调用方 parse::<IpAddr>() 失败 → 非回环 / 不匹配）。
        // 不得截出方括号内地址——否则 `[::1]@evil.com` 会被 is_loopback_host 误判回环。
        assert_eq!(strip_port("[::1]@evil.com"), "[::1]@evil.com");
        assert_eq!(strip_port("[::1]:80@evil.com"), "[::1]:80@evil.com");
        // 无右括号（畸形）同样原样返回
        assert_eq!(strip_port("[::1"), "[::1");
        // 合法形态不受影响
        assert_eq!(strip_port("[::1]:8080"), "::1");
        assert_eq!(strip_port("[::1]"), "::1");
    }

    #[test]
    fn origin_matches_ipv6_literal_host() {
        // IPv6 回环直连：`http://[::1]:9077` 的 Origin 与 Host 均带方括号
        let o = HeaderValue::from_static("http://[::1]:9077");
        assert!(origin_matches_host(&o, "[::1]:9077"));
    }

    #[test]
    fn origin_is_case_insensitive_on_host() {
        // DNS 域名大小写无关；比对须忽略大小写（浏览器可能发大写 Host）
        let o = HeaderValue::from_static("http://Omniterm.LAN");
        assert!(origin_matches_host(&o, "omniterm.lan"));
        assert!(origin_matches_host(&o, "OMNITERM.lan:9077"));
    }

    #[test]
    fn origin_rejects_empty_host_segment() {
        // `Origin: http://:9077`（无 host 段）→ 拒绝，不得因端口匹配而误放
        let o = HeaderValue::from_static("http://:9077");
        assert!(!origin_matches_host(&o, "127.0.0.1:9077"));
    }

    #[test]
    fn origin_stops_at_path_and_query() {
        // Origin 带路径/query（畸形但合法头值）时只取 authority 比对
        let o = HeaderValue::from_static("http://evil.com/x?y=1");
        assert!(!origin_matches_host(&o, "omniterm.lan"));
    }

    #[test]
    fn enforce_ws_origin_rejects_when_first_of_multiple_values_is_cross_site() {
        // http crate 的 HeaderMap 对 ORIGIN 可 `append` 出多值，`get` 取**首值**。
        // 这里钉住语义：恶意值排在第一位必须被拒。若未来误改成遍历全部值取
        // 「任一匹配即放行」，攻击者把合法值排在前面即可绕过。
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("127.0.0.1:9077"));
        h.append(header::ORIGIN, HeaderValue::from_static("http://evil.com"));
        h.append(header::ORIGIN, HeaderValue::from_static("http://127.0.0.1:9077"));
        assert!(enforce_ws_origin(&h).is_some());
    }

    #[test]
    fn enforce_ws_origin_rejects_non_utf8_origin() {
        // `HeaderValue::to_str()` 对非 UTF-8 返回 Err → `origin_matches_host` 判 false → 拒绝。
        // 不能因"解析不了"而放行——畸形/构造性头值正是要防的东西。
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("127.0.0.1:9077"));
        // 注意：ORIGIN 是单值头，append 后 get 取第一个
        h.append(header::ORIGIN, HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        assert!(enforce_ws_origin(&h).is_some());
    }

    #[test]
    fn enforce_ws_origin_allows_when_host_header_absent() {
        // 无 Host 头 → 放行。HTTP/1.1 规定 Host 必带，缺失即非浏览器流量。
        let mut h = HeaderMap::new();
        h.append(header::ORIGIN, HeaderValue::from_static("http://127.0.0.1:9077"));
        assert!(enforce_ws_origin(&h).is_none());
    }

    #[test]
    fn enforce_ws_origin_allows_when_host_is_non_utf8() {
        // 非 UTF-8 Host：`to_str()` 失败 → `host_from_headers` 返回 None → 放行。
        // 浏览器只会发 ASCII Host，此态只可能来自非浏览器流量（它们本来也无 Origin
        // 或已被「无 Origin 放行」覆盖），故按放行处理而非拒绝。
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        h.insert(header::ORIGIN, HeaderValue::from_static("http://127.0.0.1:9077"));
        assert!(enforce_ws_origin(&h).is_none());
    }
}
