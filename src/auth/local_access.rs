//! 本地免密判据（D3）：区分「本机 127.0.0.1 / localhost 访问」与远程接入。
//!
//! 仅当 [`is_local_request`] 的四条件**全部成立**才放行（fail-closed，任一不成立
//! 即不放行）。四条缺一不可，全部有真实穿透路径：
//!
//! 1. **TCP 对端回环** —— 挡住直接远程连接。
//! 2. **`Host` 是回环字面量** —— 挡住同机反代与 dev Vite 代理（对端均为回环）。
//!    信任前提：`Host` 是客户端可控头，仅对浏览器或「规范化 Host / 注入转发头」
//!    的中间层可靠；透传 Host 且不注入转发头时客户端可伪造（计划 D3 勘误二）。
//! 3. **`Origin` 缺失或回环** —— 免密后不再有 cookie，跨站请求（CSRF）只能靠
//!    Origin 判定挡；已知边界：无 Origin 的顶层导航/非浏览器客户端不受此约束。
//! 4. **无代理转发头** —— 挡住显式注入转发头（XFF/XFH/X-Real-IP/Forwarded）的代理；
//!    nginx **默认**不注入任何转发头，故挡不住「Host 被改写为上游回环地址」
//!    （`proxy_set_header Host $proxy_host`）形态，见计划 D3 勘误一。
//!
//! Host/Origin 的 host 提取复用 [`crate::ws::origin_guard`]（唯一真源，不另写解析）；
//! 「字符串是否回环宿主」与 `main.rs::enforce_listen_auth` 收敛为同一函数
//! [`is_loopback_host`]。完整威胁模型与决策见
//! `docs/dev/plans/2026-09-27-auth-username-local-bypass.md` D3。

use axum::http::{HeaderMap, header};
use std::net::{IpAddr, SocketAddr};

use crate::ws::origin_guard;

/// 代理转发头：任一存在即判为「经代理的流量」，本地免密不放行（条件 4）。
/// 不信任其**值**（客户端可伪造），仅用其**存在**作负面信号。
const PROXY_FORWARD_HEADERS: [&str; 4] =
    ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded"];

/// 是否命中本地免密（四条件全真才 true，见模块注）。纯函数，无 I/O。
///
/// `peer` 为 TCP 对端地址：由调用方从 `request.extensions().get::<ConnectInfo<SocketAddr>>()`
/// 提取；缺失（`None`，如测试脚手架未注入）→ 不放行（fail-closed）。
pub fn is_local_request(headers: &HeaderMap, peer: Option<SocketAddr>) -> bool {
    // 条件 1：对端必须是回环（覆盖 127.0.0.0/8 与 ::1）。
    let Some(peer) = peer else { return false };
    if !peer.ip().is_loopback() {
        return false;
    }

    // 条件 2：Host 头的 host 部分必须是回环字面量；缺失 / 非 UTF-8 → 不放行。
    // 不预先 `strip_port`——`is_loopback_host` 自带端口/方括号容错，且保留
    // 「未加方括号的 IPv6」形态（先 strip_port 会把 `0:0:0:0:0:0:0:1` 截成 `0`）。
    let Some(host) = origin_guard::host_from_headers(headers) else { return false };
    if !is_loopback_host(host) {
        return false;
    }

    // 条件 3：Origin 缺失可放行（非浏览器客户端 / 同源导航）；存在时 host 部分
    // 必须是回环字面量——`Origin: null`、畸形、跨站一律不放行。
    if let Some(origin) = headers.get(header::ORIGIN)
        && !origin_guard::origin_host(origin).is_some_and(is_loopback_host)
    {
        return false;
    }

    // 条件 4：无任何代理转发头。
    if PROXY_FORWARD_HEADERS.iter().any(|name| headers.contains_key(*name)) {
        return false;
    }
    true
}

/// Host/Origin 的 host 部分是否为回环字面量（条件 2/3 共用）。
///
/// 接受 `localhost`（忽略大小写、容忍 FQDN 尾点）与回环 IP 字面量（`127.0.0.0/8`、
/// `::1`，含 `[::1]` / `[::1]:port` / 未加方括号的 IPv6，端口按 [`strip_port`] 语义
/// 剥离）。空串、域名、非回环 IP 一律 false。本函数同时是 `main.rs::enforce_listen_auth`
/// 监听地址回环判定的真源（AGENTS §7①：同一判断不得有两份实现）。
///
/// [`strip_port`]: crate::ws::origin_guard::strip_port
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    // 纯 IP 字面量（含未加方括号的 IPv6，如 `0:0:0:0:0:0:0:1`）——必须先于去端口，
    // 否则 IPv6 会被 `split(':')` 截断成首段。
    if let Ok(ip) = host.parse::<IpAddr>() {
        return ip.is_loopback();
    }
    // `host:port` / `[v6]:port` / `[v6]`：与 Host/Origin 判据同一去端口语义。
    let stripped = origin_guard::strip_port(host);
    // `localhost` 忽略大小写，`localhost.`（FQDN 尾点）同判。
    if stripped.trim_end_matches('.').eq_ignore_ascii_case("localhost") {
        return true;
    }
    // 去端口后可能得到回环 IP（如 `127.0.0.1:18777`）。
    stripped.parse::<IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(entries: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in entries {
            h.insert(k.parse::<header::HeaderName>().unwrap(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn peer(ip: &str) -> Option<SocketAddr> {
        Some(SocketAddr::new(ip.parse().unwrap(), 40000))
    }

    /// 全真基线（后续反例逐个改一项来构造）。
    fn loopback_headers() -> HeaderMap {
        headers(&[("host", "127.0.0.1:18777")])
    }

    // ── 四条件组合：全真 + 关键反例 ─────────────────────────────

    #[test]
    fn all_true_conditions_pass() {
        assert!(is_local_request(&loopback_headers(), peer("127.0.0.1")));
        // Origin 存在但同为回环（浏览器访问 localhost 页面）同样命中
        let h = headers(&[("host", "localhost:18777"), ("origin", "http://localhost:18777")]);
        assert!(is_local_request(&h, peer("::1")));
    }

    #[test]
    fn rejects_non_loopback_peer() {
        // 直连远程：对端非回环
        assert!(!is_local_request(&loopback_headers(), peer("192.168.5.216")));
        assert!(!is_local_request(&loopback_headers(), peer("10.0.0.7")));
    }

    #[test]
    fn rejects_missing_peer() {
        // extensions 缺失（测试脚手架 / 非常规接入）→ fail-closed
        assert!(!is_local_request(&loopback_headers(), None));
    }

    #[test]
    fn rejects_domain_host() {
        // 同机反代 / Vite 代理：对端是回环，但 Host 被改写为域名 → 不放行
        let h = headers(&[("host", "omniterm.example.com")]);
        assert!(!is_local_request(&h, peer("127.0.0.1")));
        // LAN 访问 dev 前端（Vite 转发），Host 是 LAN IP → 不放行
        let h = headers(&[("host", "192.168.5.216:18778")]);
        assert!(!is_local_request(&h, peer("127.0.0.1")));
    }

    #[test]
    fn rejects_missing_host() {
        // 无 Host：HTTP/1.1 规定必带，缺失即畸形流量 → fail-closed
        assert!(!is_local_request(&HeaderMap::new(), peer("127.0.0.1")));
        // 非 UTF-8 Host 同样视为缺失
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        assert!(!is_local_request(&h, peer("127.0.0.1")));
    }

    #[test]
    fn rejects_malformed_host() {
        // Host 带 scheme（畸形）：strip_port 得到 `http`，非回环字面量
        let h = headers(&[("host", "http://127.0.0.1")]);
        assert!(!is_local_request(&h, peer("127.0.0.1")));
        // 冒号前不是回环 host
        let h = headers(&[("host", "example.com:127.0.0.1")]);
        assert!(!is_local_request(&h, peer("127.0.0.1")));
    }

    #[test]
    fn rejects_cross_site_origin() {
        // 恶意网页 CSRF：免密后没有 cookie 兜底，必须由条件 3 挡
        let h = headers(&[("host", "127.0.0.1:18777"), ("origin", "https://evil.com")]);
        assert!(!is_local_request(&h, peer("127.0.0.1")));
        // Origin 是 LAN 形态（经局域网访问本机前端）
        let h = headers(&[("host", "127.0.0.1:18777"), ("origin", "http://192.168.5.216:18777")]);
        assert!(!is_local_request(&h, peer("127.0.0.1")));
    }

    #[test]
    fn rejects_null_or_malformed_origin() {
        // `Origin: null`（sandboxed iframe / file://）→ 不放行
        let h = headers(&[("host", "127.0.0.1:18777"), ("origin", "null")]);
        assert!(!is_local_request(&h, peer("127.0.0.1")));
        // 畸形 Origin（无 scheme / 空 host 段）→ 不放行
        for bad in ["127.0.0.1:18777", "http://", "http://:18777"] {
            let h = headers(&[("host", "127.0.0.1:18777"), ("origin", bad)]);
            assert!(!is_local_request(&h, peer("127.0.0.1")), "origin={bad}");
        }
        // 非 UTF-8 Origin → 不放行
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("127.0.0.1:18777"));
        h.insert(header::ORIGIN, HeaderValue::from_bytes(b"\xff\xfe").unwrap());
        assert!(!is_local_request(&h, peer("127.0.0.1")));
    }

    #[test]
    fn accepts_ipv6_origin_and_host() {
        let h = headers(&[("host", "[::1]:18777"), ("origin", "http://[::1]:18777")]);
        assert!(is_local_request(&h, peer("::1")));
        let h = headers(&[("host", "0:0:0:0:0:0:0:1"), ("origin", "http://[0:0:0:0:0:0:0:1]")]);
        assert!(is_local_request(&h, peer("::1")));
    }

    #[test]
    fn rejects_proxy_forward_headers() {
        // 显式注入转发头的代理（如 Caddy 默认注入 X-Forwarded-For/-Host/-Proto，
        // nginx 需显式配置）：Host 即使被判为回环，条件 4 也逐一挡住四种转发头
        for name in PROXY_FORWARD_HEADERS {
            let mut h = loopback_headers();
            h.insert(
                name.parse::<header::HeaderName>().unwrap(),
                HeaderValue::from_static("1.2.3.4"),
            );
            assert!(!is_local_request(&h, peer("127.0.0.1")), "header={name}");
        }
    }

    // ── Host 形态穷举（is_loopback_host）────────────────────────

    #[test]
    fn loopback_host_forms() {
        for host in [
            "localhost",
            "LOCALHOST",
            "LocalHost",
            "localhost.",
            "127.0.0.1",
            "127.0.0.1:18777",
            "127.0.0.2",
            "::1",
            "[::1]",
            "[::1]:18777",
            "0:0:0:0:0:0:0:1",
            " 127.0.0.1 ", // trim
        ] {
            assert!(is_loopback_host(host), "host={host} must be loopback");
        }
    }

    #[test]
    fn non_loopback_host_forms() {
        for host in [
            "",
            "example.com",
            "0.0.0.0",
            "0.0.0.0:9077",
            "::",
            "[::]",
            "192.168.5.216",
            "10.0.0.7:9077",
            "term-dev.tokitoken.com",
            "127.0.0.1.evil.com",
            "localhost.evil.com",
            "http://127.0.0.1",
            // 畸形方括号串：strip_port 原样返回 → parse 失败 → 非回环（不得截出 ::1）
            "[::1]@evil.com",
            "[::1]:80@evil.com",
        ] {
            assert!(!is_loopback_host(host), "host={host} must NOT be loopback");
        }
    }

    #[test]
    fn host_forms_drive_is_local_request() {
        // Host 形态与 peer 组合的行为级收敛（表驱动，与上面纯函数穷举互为补充）
        let cases: [(&str, Option<SocketAddr>, bool); 10] = [
            ("localhost", peer("127.0.0.1"), true),
            ("LOCALHOST", peer("::1"), true),
            ("localhost.", peer("127.0.0.1"), true),
            ("127.0.0.1:18777", peer("127.0.0.1"), true),
            ("127.0.0.2", peer("127.0.0.1"), true),
            ("[::1]:18777", peer("::1"), true),
            ("::1", peer("::1"), true),
            ("0:0:0:0:0:0:0:1", peer("::1"), true),
            ("example.com", peer("127.0.0.1"), false),
            ("", peer("127.0.0.1"), false),
        ];
        for (host, peer_addr, expected) in cases {
            let h = headers(&[("host", host)]);
            assert_eq!(
                is_local_request(&h, peer_addr),
                expected,
                "host={host:?} peer={peer_addr:?}"
            );
        }
    }

    #[test]
    fn peer_unspecified_is_not_loopback() {
        // 0.0.0.0 对端（非回环）不放行；显式钉住 is_loopback 语义
        assert!(!is_local_request(&loopback_headers(), peer("0.0.0.0")));
    }

    #[test]
    fn v4_mapped_peer_is_not_loopback_fail_closed() {
        // 刻意 fail-closed：std `IpAddr::is_loopback` 只认 `::1`（不识别 v4-mapped），
        // `--host ::` 双栈绑定时内核可能给出 `::ffff:127.0.0.1` 形态的对端 → 判非回环。
        // 方向安全（少放行一次免密，不会误放），边界由 auth-not-enforced.md 记录。
        assert!(!is_local_request(&loopback_headers(), peer("::ffff:127.0.0.1")));
    }
}
