//! CORS 策略：默认仅同源，外加显式 origin 白名单。
//!
//! 威胁模型（与 WS 入口同源，见 `origin_guard.rs` 模块注）：恶意网页
//! evil.com 在用户浏览器里对 OmniTerm 发 fetch/XHR。此前
//! `CorsLayer::permissive()` 对所有来源回 `Access-Control-Allow-Origin: *`
//! （不含 credentials，故带不了 cookie），任何站点都能**读到**我们接口的
//! 返回值——包括 `/auth/check`、`/system/info`（泄露 `proxy_domain`）等
//! 无鉴权可读的信息面。收紧后：只有**同源**与**显式配过的 origin** 能读。
//!
//! ## 三条允许规则（判定顺序即实现顺序）
//!
//! 1. **无 `Origin` 头 = 放行**——**框架保证，不经谓词**：`CorsLayer::call` 取
//!    `parts.headers.get(ORIGIN)`，`AllowOrigin::to_future` 是 `origin.filter(...)`，
//!    `None` 上 predicate 压根不被调用，请求原样透传给 inner service（headers/body
//!    不被碰）。无 Origin 的请求（curl / 脚本 / 原生客户端）本就不在浏览器同源
//!    策略管辖内，CORS 对它没有任何意义。
//! 2. **`Origin` 的 host 与请求 `Host` 一致**（忽略端口，大小写不敏感）
//!    = 放行。复用 [`super::origin_guard::origin_matches_host`]——同一条
//!    「host 一致性」判据在 WS 与 HTTP 两道防线上各用一次，不复制实现。
//!    这条同时覆盖**代理子域形态**（`{port}.{base_host}` 下前端与 API
//!    同 host，与 WS 入口同理）。
//! 3. **`Origin` 逐字命中显式白名单** = 放行。反代部署下 Host 被 nginx
//!    改写（`proxy_set_header Host $proxy_host`）时同源判定必然失败，
//!    必须由用户显式声明「我的前端域是 X」。
//!
//! ## 已知边界（勿合并）
//!
//! - **CORS 只管「浏览器能否读响应」，不管「请求是否执行」**：不被允许的 origin
//!   拿到的仍是**完整业务响应**，只是没有 `Access-Control-Allow-Origin` 头，
//!   JS 读不到。故跨站写请求在服务端照样执行——**不能拿收紧 CORS 当 CSRF 防护**。
//!   写操作的实际兜底：auth 开启时 `SameSite=Lax` 让跨站 fetch 带不上 cookie ⇒ 401；
//!   auth 关闭时由 S1（非回环监听 + auth 关闭拒绝启动）收口。
//! - **CORS 收紧不能替代 WS Origin 校验**：WebSocket 握手不吃 CORS 同源赦免，
//!   CSWSH 面仍由 `origin_guard.rs` 独立防御（两条防线）。
//! - **白名单不推导、不兜底**：dev.sh 只以 CLI 传 `-p`、不 export
//!   `BACKEND_PORT`，后端读不到前端端口；`--proxy-domain` 在 dev 不传
//!   （见计划 D3 校正 5）。故允许集合**只能**来自显式配置，缺省即空集
//!   （判定 2/3 都不命中即拒），**不得写死域名兜底**。
//! - **`X-Forwarded-Host` 不作判据**：`CorsLayer` 不读它，且客户端可伪造
//!   ——不校验反代链路就信任它等于把白名单拱手让给攻击者。
//! - **缺 `Host` 时本模块拒绝、WS 入口放行**（入口策略刻意分叉，理由见
//!   `origin_is_allowed` 注）——判定函数共享，入口策略不共享。

use axum::http::{HeaderValue, request::Parts as RequestParts};
use std::sync::Arc;

/// 显式 origin 白名单的条目上限。
///
/// 允许集合**不是累积结构**（每次启动从配置解析一次），但仍按 §P1 设显式
/// 上限：超限时保留**前 N 条**并 warn —— 白名单是人工维护的部署配置，超限
/// 几乎必是配置错误（如把一整个日志/监控域的列表粘了进来），静默丢弃尾条
/// 会让「配了却没生效」难以排查。按条目数而非字节数：每条都必须是完整
/// origin，单条长度天然有界（见 [`MAX_ORIGIN_BYTES`]）。
pub const MAX_ORIGIN_ENTRIES: usize = 32;

/// 单条 origin 字符串的字节上限。
///
/// origin = `scheme://host[:port]`，合法值远小于此；超长条目必是配置错误
/// （例如误填了 URL + query）。超限条目直接丢弃并 warn，不进入集合
/// ——`HeaderValue` 本身有 ~64KB 上限，但 64KB 的垃圾字符串进入判定只会
/// 让每次请求都比对一坨无意义字节。
pub const MAX_ORIGIN_BYTES: usize = 256;

/// 解析逗号分隔的 origin 白名单（`--cors-allowed-origins` /
/// `OMNITERM_CORS_ALLOWED_ORIGINS`）。
///
/// 规则：
/// - 按 `,` 切分，逐条 trim；**空段跳过**（`"a,,b"` 与 `"a,b"` 等价，
///   容忍末尾逗号与手写换行粘贴）。
/// - 单条超 [`MAX_ORIGIN_BYTES`] → 丢弃 + warn。
/// - 总条数超 [`MAX_ORIGIN_ENTRIES`] → 保留前 N 条 + warn（见常量注释）。
/// - 去重且保持**首次出现的顺序**（顺序只影响 warn 的可读性，判定是集合
///   语义；用 `Vec` + `contains` 而非 `HashSet`，因为 `HeaderValue` 的
///   `Hash` 不可用且条目数有界，O(n) 查找成本可忽略）。
///
/// **不做 scheme 补全 / 大小写规范化**：CORS 的 `Origin` 头按字节比对，
/// 规范化只会造成「配了 `HTTP://X` 以为能匹配」的错配。配置必须写浏览器
/// 地址栏里的那个完整 origin（含 scheme 与端口）。另注意
/// `HeaderValue::from_str` 会**静默拒绝**含控制字符（含 `\0`、`\r\n`、非
/// ASCII 控制码）的条目并走 warn 分支——不属于「规范化」，但同样让
/// 「以为配上了」的条目失效。
pub fn parse_allowed_origins(raw: &str) -> Vec<HeaderValue> {
    let mut out: Vec<HeaderValue> = Vec::new();
    for entry in raw.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        // 上限检查放在 push 之前：否则恰好 N 条的合法配置会误报「超出」，
        // 且 warn 里声称的「保留前 N 条、丢弃尾条」与代码实际行为不符
        // （§P1：超限策略必须与宣称一致，且要有边界单测兜住）。
        if out.len() >= MAX_ORIGIN_ENTRIES {
            tracing::warn!(
                "cors allowed origins exceeded {} entries, keeping the first {} entries",
                MAX_ORIGIN_ENTRIES,
                MAX_ORIGIN_ENTRIES
            );
            break;
        }
        if entry.len() > MAX_ORIGIN_BYTES {
            // 按字符边界截断：直接 `&entry[..MAX_ORIGIN_BYTES]` 在多字节字符
            // 跨第 256 字节时会 panic（§P1 明确要求按字符边界切）。
            let clipped: String = entry.chars().take(MAX_ORIGIN_BYTES).collect();
            tracing::warn!(
                "cors allowed origin too long ({} bytes > {}), dropped: {}...",
                entry.len(),
                MAX_ORIGIN_BYTES,
                clipped
            );
            continue;
        }
        if let Ok(v) = HeaderValue::from_str(entry) {
            if !out.contains(&v) {
                out.push(v);
            }
        } else {
            tracing::warn!("cors allowed origin is not a valid header value, dropped: {entry}");
        }
    }
    out
}

/// 同源 / 白名单并集判定（给 `AllowOrigin::predicate` 用）。
///
/// 一个闭包同时实现两条判据：tower-http 无法把两种 `AllowOrigin` 策略取
/// 并集，但 `predicate` 可以按任意规则返回 bool（见计划 D3 校正 3）。
///
/// 闭包捕获 `Arc<[HeaderValue]>` 而非 `Vec<HeaderValue>`：`predicate` 要求
/// `Fn + Send + Sync + 'static`，`Arc` 让闭包 clone 便宜且无锁。
pub fn origin_is_allowed(
    origin: &HeaderValue,
    parts: &RequestParts,
    allowed: &Arc<[HeaderValue]>,
) -> bool {
    // 白名单逐字命中（不依赖 Host，反代改写 Host 的场景唯一活路）。
    if allowed.iter().any(|a| a == origin) {
        return true;
    }
    // 同源判定：Origin host ↔ 请求 Host。Host 缺失 / 非 UTF-8 时
    // `host_from_headers` 返回 None → 落到白名单分支的结果（false），
    // 即拒绝——与 WS 入口不同，这里**不能**因「无 Host」放行：CORS 判定
    // 只对带 Origin 的请求有意义，而带 Origin 却无 Host 的请求在 HTTP/1.1
    // 下不可能来自浏览器（同 origin_guard 的推理），但浏览器也绝不会
    // 在这种情况下发送 Origin，故拒绝不影响真实用户。
    match crate::ws::host_from_headers(&parts.headers) {
        Some(host) => crate::ws::origin_matches_host(origin, host),
        None => false,
    }
}

/// 启动时打一行生效的 CORS 策略（INFO）：便于部署后排障「配了白名单为何不生效」。
pub fn log_cors_policy(allowed: &[HeaderValue]) {
    if allowed.is_empty() {
        tracing::info!("cors policy: same-origin only");
    } else {
        let list: Vec<&str> = allowed.iter().map(|v| v.to_str().unwrap_or("<non-utf8>")).collect();
        tracing::info!("cors policy: same-origin + explicit allowlist {:?}", list);
    }
}

/// 供测试用：把判定逻辑暴露成不需要 `RequestParts` 的输入形态。
///
/// `RequestParts` 构造代价高（要完整 request），单测只需「Origin + Host +
/// 白名单」三元组即可穷举判定，故把真源逻辑收在这里，`origin_is_allowed`
/// 与它共用同一段实现（§7① 同一判断不得有两份）。
#[cfg(test)]
pub fn decide(origin: &str, host: Option<&str>, allowed: &[&str]) -> bool {
    use axum::http::header;
    let Ok(origin) = HeaderValue::from_str(origin) else {
        return false;
    };
    let allowed: Vec<HeaderValue> =
        allowed.iter().filter_map(|a| HeaderValue::from_str(a).ok()).collect();
    let arc: Arc<[HeaderValue]> = allowed.into();
    let mut builder = axum::http::Request::builder().method("GET").uri("/");
    if let Some(h) = host {
        builder = builder.header(header::HOST, h);
    }
    let req = builder.header(header::ORIGIN, origin.clone()).body(()).expect("valid request");
    let (parts, ()) = req.into_parts();
    origin_is_allowed(&origin, &parts, &arc)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 白名单解析（parse_allowed_origins）────────────────────

    #[test]
    fn parse_allowlist_skips_empty_segments() {
        // 末尾逗号 / 手写粘贴的空段都不该产生空条目（空 HeaderValue 会让
        // 「无法配置成功」变得极难排查）。
        let out = parse_allowed_origins("https://a.example.com,,https://b.example.com,");
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], "https://a.example.com");
        assert_eq!(out[1], "https://b.example.com");
    }

    #[test]
    fn parse_allowlist_dedups_keeping_first_order() {
        let out = parse_allowed_origins(
            "https://a.example.com, https://b.example.com ,https://a.example.com",
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0], "https://a.example.com");
    }

    #[test]
    fn parse_allowlist_preserves_exact_bytes() {
        // 不补 scheme、不改大小写：CORS 按字节比对，规范化只会制造错配。
        let out = parse_allowed_origins("HTTPS://A.Example.COM:8443");
        assert_eq!(out[0], "HTTPS://A.Example.COM:8443");
    }

    #[test]
    fn parse_allowlist_drops_too_long_entry() {
        let long = format!("https://a.example.com/{}", "x".repeat(MAX_ORIGIN_BYTES));
        let out = parse_allowed_origins(&long);
        assert!(out.is_empty(), "超长条目必须丢弃: {out:?}");
    }

    #[test]
    fn parse_allowlist_caps_entries() {
        // §P1：条目数上限 + 保留前 N 条（超限几乎必是配置错误）。
        let raw: String = (0..MAX_ORIGIN_ENTRIES + 5)
            .map(|i| format!("https://{i}.example.com"))
            .collect::<Vec<_>>()
            .join(",");
        let out = parse_allowed_origins(&raw);
        assert_eq!(out.len(), MAX_ORIGIN_ENTRIES);
        assert_eq!(out[0], "https://0.example.com");
    }

    #[test]
    fn parse_allowlist_exact_cap_is_not_over_limit() {
        // 恰好 N 条的合法配置**不得**被当成超限（否则 warn 谎报「超出」且宣称
        // 丢弃尾条，与 §P1「超限策略必须与宣称一致」冲突）。
        let raw: String = (0..MAX_ORIGIN_ENTRIES)
            .map(|i| format!("https://{i}.example.com"))
            .collect::<Vec<_>>()
            .join(",");
        let out = parse_allowed_origins(&raw);
        assert_eq!(out.len(), MAX_ORIGIN_ENTRIES);
        assert_eq!(
            out[MAX_ORIGIN_ENTRIES - 1],
            format!("https://{}.example.com", MAX_ORIGIN_ENTRIES - 1)
        );
    }

    #[test]
    fn parse_allowlist_over_cap_keeps_exactly_first_n() {
        // 超限时保留的必须是**前 N 条**，不多不少（含「多出条目被丢弃」的语义）。
        let raw: String = (0..MAX_ORIGIN_ENTRIES + 3)
            .map(|i| format!("https://{i}.example.com"))
            .collect::<Vec<_>>()
            .join(",");
        let out = parse_allowed_origins(&raw);
        assert_eq!(out.len(), MAX_ORIGIN_ENTRIES);
        for (i, v) in out.iter().enumerate() {
            assert_eq!(v.to_str().unwrap(), format!("https://{i}.example.com"));
        }
    }

    #[test]
    fn parse_allowlist_drops_multibyte_overlong_entry_without_panic() {
        // §P1 字符边界：超长条目含多字节字符（每个 3 字节）跨第 256 字节时，
        // 直接 `&entry[..256]` 会 panic（已用 `rustc` 单独复证）。这里钉住
        // 解析函数本身不 panic 且该条目被丢弃。
        let long = format!("http://x.example.com/{}", "中".repeat(90)); // 270 字节
        assert!(long.len() > MAX_ORIGIN_BYTES);
        let out = parse_allowed_origins(&long);
        assert!(out.is_empty(), "超长多字节条目必须被丢弃: {out:?}");
    }

    #[test]
    fn parse_allowlist_keeps_multibyte_entry_within_limit() {
        // 边界内（≤256 字节）的多字节条目本身合法（UTF-8 的 HeaderValue），
        // 不应被误丢——上限管的是字节数而非字符数。
        let ok = format!("http://x.example.com/{}", "中".repeat(50)); // 150 字节
        assert!(ok.len() <= MAX_ORIGIN_BYTES);
        let out = parse_allowed_origins(&ok);
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn parse_allowlist_empty_input_is_empty() {
        assert!(parse_allowed_origins("").is_empty());
        assert!(parse_allowed_origins("   ").is_empty());
        assert!(parse_allowed_origins(",,").is_empty());
    }

    // ── 三规则判定（decide，穷举）────────────────────────────

    #[test]
    fn cors_allows_same_origin() {
        assert!(decide("http://127.0.0.1:9077", Some("127.0.0.1:9077"), &[]));
        // 端口不同、host 相同 → 同源（同 WS 入口口径）
        assert!(decide("https://omniterm.lan", Some("omniterm.lan:443"), &[]));
        // 大小写不敏感
        assert!(decide("http://Omniterm.LAN", Some("omniterm.lan"), &[]));
    }

    #[test]
    fn cors_allows_proxy_subdomain_origin() {
        // 代理子域形态：Origin host 与请求 Host 一致（{port}.{base_host}）
        assert!(decide("http://3000.omniterm.lan:9777", Some("3000.omniterm.lan:9777"), &[]));
    }

    #[test]
    fn cors_rejects_cross_site() {
        assert!(!decide("https://evil.com", Some("127.0.0.1:9077"), &[]));
        // 畸形 Origin（无 scheme）拒绝
        assert!(!decide("127.0.0.1:9077", Some("127.0.0.1:9077"), &[]));
        // 空 host 段拒绝
        assert!(!decide("http://:9077", Some("127.0.0.1:9077"), &[]));
    }

    #[test]
    fn cors_rejects_when_host_absent() {
        // 与 WS 入口的关键差异：无 Host 时**拒绝**而非放行。
        // 理由见 origin_is_allowed 注：带 Origin 却无 Host 的请求不可能
        // 来自浏览器，但也无法证明其同源，按拒绝处理。
        assert!(!decide("http://127.0.0.1:9077", None, &[]));
    }

    #[test]
    fn cors_allows_whitelisted_even_when_host_differs() {
        // 反代形态：nginx `proxy_set_header Host $proxy_host` 改写 Host 后
        // 同源判定必失败，白名单是唯一活路。
        assert!(decide(
            "https://term.example.com",
            Some("omniterm:9777"),
            &["https://term.example.com"]
        ));
        // 白名单里没有 → 仍拒
        assert!(!decide(
            "https://other.example.com",
            Some("omniterm:9777"),
            &["https://term.example.com"]
        ));
    }

    #[test]
    fn cors_whitelist_is_exact_byte_match() {
        // 白名单不做同源放宽：不同端口 = 不同条目，避免「配了 https 却因
        // 端口不符被拒」的错配被误当成 bug 修。
        assert!(!decide(
            "https://term.example.com:8443",
            Some("omniterm:9777"),
            &["https://term.example.com"]
        ));
        assert!(decide(
            "https://term.example.com",
            Some("omniterm:9777"),
            &["https://term.example.com"]
        ));
    }
}
