# OmniTerm 反向代理（端口转发）修复研究报告

> 日期：2026-08-15
> 作者：代码审查 Agent
> 目的：供后续修复 Agent 使用，定位「反复修缮仍不完美」的根因并给出修复路线图

> ## 修复状态（2026-08-16 更新）
>
> **P0 全部完成**（commit `dev f11ddfa`），**P1 全部完成**（commit `dev 4109056`）：
>
> | 编号 | 问题 | 状态 |
> |------|------|------|
> | 4.1 | JS 重写漏 `/api` 无尾随斜杠 | ✅ 已修 |
> | 4.2 | 缺 `X-Forwarded-*` 头 | ✅ 已修（已有值保留不覆盖） |
> | 4.3 | 缺 `<base>` 标签重写 | ✅ 无需改码——现有 `href` 属性正则已覆盖，补测试确认 |
> | 4.4 | 缺 `formaction` 属性 | ✅ 已修 |
> | 4.5 | `Location` 重写缺 `0.0.0.0`/`https` | ✅ 已修 |
> | 4.6 | WS 缺 Origin 校验 | ✅ 已修（CSWSH 防御） |
> | 4.7 | Cookie Domain 对 IP/localhost | ✅ 已修 |
> | 4.8 | SPA polyfill 注入位置 | ⏭️ 已过时——方案已废弃（改为 JS basename 注入，见计划勘误 8） |
> | 4.9 | WS relay 未发 Close 帧 | ✅ 已修（写侧发完残留 Close 再退出，2s 超时兜底） |
> | 4.10 | `Content-Encoding: identity` | ✅ 已修（视为明文可重写） |
> | 4.11 | 请求体 2MB 硬限制 | ✅ 已修（`--proxy-max-body` / `OMNITERM_PROXY_MAX_BODY` 可配置） |
> | 4.12 | `0.0.0.0` Host 重写 | ✅ 无需修改（报告结论） |
> | 4.13 | 子域名 Host 端口剥离 IPv6 | ✅ 已修（`]` 结尾判别） |
>
> **P2 增强项（4.14-4.20）未做**，Phase 3/4 未启动。
> 报告正文保留原始审查快照（含已修复项的「现状」描述），上方状态表为当前唯一权威。
> 修复的差异点：① regex crate 不支持 lookaround，4.1 用捕获组 + 函数式边界判定（而非报告建议的 lookahead）；② 4.3 实际已覆盖（误报）。

## 1. 文件清单

| 路径 | 说明 |
|------|------|
| `src/proxy/mod.rs` | 主模块：路由、HTTP 转发、header 重写、响应体重写、SPA polyfill、端口白名单、子域名路由 |
| `src/proxy/ws.rs` | WS 双向 relay |
| `src/api/auth.rs` | token_cookie/clear_cookie（带 Domain 子域名支持） |
| `src/auth/mod.rs` | verify_request 供 proxy_host_mw 复用 |
| `src/main.rs:690-713` | proxy client 构造、state 注入 |
| `frontend/src/utils/proxyUrl.ts` | 前端 URL 重写 |
| `frontend/src/components/Chat/Markdown.tsx` | 聊天链接点击重写 |
| `frontend/src/hooks/useTerminal.ts` | 终端链接点击重写 |
| `frontend/src/App.tsx` | 设置 proxyDomain |
| `frontend/vite.config.ts` | dev 代理配置 |

## 2. 参考实现

| 参考 | 本地路径 | License | 借鉴点 |
|------|----------|---------|--------|
| code-server `src/node/proxy.ts` | `~/coding/research/code-server/src/node/proxy.ts` | MIT | 子域名方案 + header 重写 + WS relay |
| code-server `src/node/routes/domainProxy.ts` | 同上 | MIT | 子域名路由、鉴权、OPTIONS 跳过 |
| code-server `src/node/routes/pathProxy.ts` | 同上 | MIT | 路径前缀路由、base 剥离 |
| code-server `src/node/http.ts` | 同上 | MIT | getHost、getCookieDomain、authenticateOrigin |
| jupyter-server-proxy `handlers.py` | `~/coding/research/jupyter-server-proxy/jupyter_server_proxy/handlers.py` | BSD-3-Clause | 路径前缀方案、rewrite_response、X-Forwarded-* |

## 3. 架构总览

两种代理形态：

```
# 路径前缀（默认，无域名要求）
http://<omniterm-host>:<port>/proxy/<target-port>/<rest-path>

# 子域名（需配置 --proxy-domain）
http://<target-port>.<proxy-domain>:<omniterm-port>/<rest-path>
```

- 路径前缀路由：`/proxy/{*path}` （`src/proxy/mod.rs:119`）
- 子域名路由：最外层 middleware `proxy_host_mw`（`src/proxy/mod.rs:193`，仅 `base_host` 配置时挂载）

## 4. 问题清单

### P0 — 必须修复的正确性缺陷

#### 4.1 JS 重写漏掉 `/api`（无尾随斜杠）

- **文件**：`src/proxy/mod.rs` 第 562 行 `rewrite_js`
- **正则**：`(["'`])/api/` 要求匹配 `/api/`（带尾随斜杠）。`'/api'` 或 `"/api"` 不会被重写。
- **影响**：如果目标 SPA 用 `fetch('/api')`、`axios.get('/api')`、`path === '/api'` 等，浏览器会请求 `/api`（OmniTerm 根路径）→ 404。
- **修复**：正则改为 `(["'`])/api(?:/|$|["'`])` 或拆分为 `(["'`])(/api(?:/|$|?|#|\\s|["'`]))`。注意 `"/api"` 后可能紧跟 `?`（`"/api?key=1"`）、`#`（`"/api#section"`）、空白、引号结束）。
- **测试**：增加 `rewrite_js_prefixes_api_without_trailing_slash` 测试用例。

#### 4.2 缺少 `X-Forwarded-*` 头

- **文件**：`src/proxy/mod.rs` 第 584-595 行 `rewrite_request_headers`
- **现状**：没有设置 `X-Forwarded-For`、`X-Forwarded-Proto`、`X-Forwarded-Host`。
- **计划文档**：D6 明确写了「追加/重写为 OmniTerm 侧值」，但代码未实现。
- **影响**：目标应用依赖这些头来判断 HTTPS、获取客户端 IP、生成正确 URL 等时行为异常。
- **修复**：在 `rewrite_request_headers` 中追加：
  ```rust
  "x-forwarded-for" => {
      if let Some(remote) = original.get(header::X_FORWARDED_FOR) {
          // 追加；若已有则追加逗号分隔
      } else {
          // 从连接信息获取客户端 IP
      }
  }
  "x-forwarded-proto" => out.insert(name.clone(), HeaderValue::from_static("http")),
  "x-forwarded-host" => {
      if let Some(host) = original.get(header::HOST) {
          out.insert(name.clone(), host.clone());
      }
  }
  ```
- **参考**：code-server `http.ts:getHost` 读取 `Forwarded` / `X-Forwarded-Host`；jupyter-server-proxy `handlers.py:335-338` 设置 `X-Forwarded-Context` / `X-Forwarded-Prefix`。

#### 4.3 缺少 `<base>` 标签重写

- **文件**：`src/proxy/mod.rs` 第 494 行 `rewrite_html`
- **现状**：只重写 `src|href|srcset|action|poster`，漏掉了 `<base href="...">`。
- **影响**：如果目标应用有 `<base href="/">` 或 `<base href="/subdir/">`，所有相对路径的解析会绕过 `/proxy/{port}` 前缀，直接落到 OmniTerm 根路径 → 404。SPA 路由适配 polyfill 对此无能为力。
- **修复**：在 `rewrite_html` 中增加：
  - 匹配 `<base` 的 `href` 属性，值加前缀。
  - 注意：如果 `<base>` 的 `href` 已经是 `/proxy/{port}/` 则跳过。
- **优先级**：高，因为大量 SPA 使用 `<base>` 标签，尤其是 new-api 等。

#### 4.4 缺少 `formaction` 属性重写

- **文件**：`src/proxy/mod.rs` 第 494 行 `rewrite_html`
- **正则**：`src|href|srcset|action|poster`，漏掉了 `formaction`。
- **影响**：HTML5 `<button formaction="/submit">` 或 `<input formaction="/upload">` 的表单提交不会经过代理前缀 → 404。
- **修复**：在正则中增加 `formaction`。

#### 4.5 `Location` 重写缺少 `0.0.0.0` 和 `https://`

- **文件**：`src/proxy/mod.rs` 第 672-680 行 `rewrite_location`
- **现状**：只处理 `http://localhost:{port}` 和 `http://127.0.0.1:{port}`。
- **影响**：目标应用如果绑定 `0.0.0.0` 并重定向到 `http://0.0.0.0:{port}/`，或使用 `https://localhost:{port}`，不会被重写，浏览器直接尝试连接失败。
- **修复**：增加 `http://0.0.0.0:{port}` 和 `https://localhost:{port}` 和 `https://127.0.0.1:{port}` 的匹配。

#### 4.6 WS 缺少 Origin 校验

- **文件**：`src/proxy/ws.rs` 和 `src/proxy/mod.rs` 第 208-215 行 `proxy_host_mw`
- **现状**：WS 请求没有 Origin 校验，只是重写 Origin 为 `http://127.0.0.1:{port}`。
- **影响**：如果目标应用对 WS 的 Origin 校验严格，可能被绕过；但更主要的是：**子域名入口的 WS 请求没有校验 Origin 是否来自 OmniTerm 自身**，存在 CSWSH（Cross-Site WebSocket Hijacking）风险。
- **修复**：在 `proxy_host_mw` 的 WS 分支增加 Origin 校验：从请求中提取 Origin，与 `Host` 头对比或与 `trusted-origins` 配置项对比。
- **参考**：code-server `http.ts:ensureOrigin`。

#### 4.7 Cookie Domain 对 IP / localhost 的处理

- **文件**：`src/api/auth.rs` 第 103-136 行 `token_cookie` / `clear_cookie`
- **现状**：当 `base_host` 配置后，直接设置 `Domain=base_host`。如果 `base_host` 是 IP（如 `192.168.5.216`）或 `localhost`，浏览器规范**不允许**设置 `Domain` 属性（因为 Domain 必须包含至少一个点），导致 cookie 设置失败，子域名鉴权永久失效。
- **影响**：用户配置 `--proxy-domain 192.168.5.216` 时，子域名无法通过鉴权。
- **修复**：参考 code-server `http.ts:getCookieDomain`，在 `token_cookie` 中判断 `base_host` 是否为 IP / localhost / 无点域名，若是则不加 Domain 属性（保持 host-only）。
- **测试**：`parse_proxy_host` 解析 IP 子域名？`3000.192.168.5.216` 本身是无效 hostname（子域名字段不能以数字开头？实际上 `3000` 作为子域名是合法的，但 `192.168.5.216` 作为 base 域名，域名不能是纯数字 + 点，所以 `parse_proxy_host` 应该返回 None。但用户可能误配置。需要防御。

### P1 — 中优先级

#### 4.8 SPA polyfill 注入位置不正确

- **文件**：`src/proxy/mod.rs` 第 402-422 行 `build_spa_polyfill` + 第 290-292 行使用
- **现状**：`build_spa_polyfill` 返回 `<script>...</script>`，然后被 `extend_from_slice` 到 HTML 正文前，产生：
  `<script>...</script><!DOCTYPE html><html>...`
- **影响**：不符合 HTML 规范（DOCTYPE 前不能有脚本），虽然大多数浏览器执行，但可能在某些严格解析器（如 AMP 验证器、某些网站的客户端检测）中报错。且计划文档说「在 HTML `<body>` 开头内联」，实际是在 `<!DOCTYPE html>` 之前。
- **修复**：将 polyfill 注入到 `<body>` 标签之后。可以：
  1. 在 `rewrite_html` 中通过正则插入 `<body>` 后，或
  2. 在 `rewrite_html` 找到 `<body>` 标签并在其后插入（更可靠）。
  保持当前的前置逻辑作为 fallback（如果找不到 `<body>` 则前置）。

#### 4.9 WS relay 未发送 Close 帧

- **文件**：`src/proxy/ws.rs` 第 136-148 行 `relay_inner` 的 `tokio::select!`
- **现状**：当 relay 一侧结束时，`select!` 返回，然后 `abort()` 所有任务。上游没有收到 WS Close 帧，可能保持连接超时。
- **影响**：上游服务器资源泄漏（连接数增加，直到超时）。
- **修复**：在 `abort` 之前，尝试向上游发送 Close 帧。可以：
  1. 在 `read_client` 和 `read_up` 循环中，收到 Close 时不仅 break，还通过另一个 channel 通知对方 send Close。
  2. 或者，在 `select!` 之后，发送 Close 到另一侧 channel（如果未关闭）。
  但注意：`select!` 返回时，对方可能已经关闭。可以尝试发送，若失败则忽略。

#### 4.10 `Content-Encoding: identity` 不应跳过重写

- **文件**：`src/proxy/mod.rs` 第 275-278 行
- **现状**：`content_encoding.is_none()` 判断是否跳过重写。如果上游返回 `Content-Encoding: identity`（明文标识），`is_none()` 返回 `false`，跳过重写。
- **影响**：理论上 `identity` 是明文，可以安全重写；但当前跳过导致该情况下的 HTML/JS 不会被重写。虽然罕见，但语义不对。
- **修复**：检查 `content_encoding` 是否为 `identity`（或空字符串），如果是则视为无编码，允许重写。

#### 4.11 请求体 2MB 硬限制无降级

- **文件**：`src/proxy/mod.rs` 第 265-268 行 `MAX_REQUEST_BODY`
- **现状**：超出 2MB 直接返回 400，没有流式上传选项。
- **影响**：用户无法通过代理上传大文件到目标应用。
- **修复**：考虑将 `MAX_REQUEST_BODY` 设为可配置（通过 `ProxyState` 或 env），或对超限请求体做流式转发（不缓存到内存，直接 pipe 到上游）。后者更复杂，但符合「代理」的语义。

#### 4.12 缺少 `0.0.0.0` 的 Host 重写

- **文件**：`src/proxy/mod.rs` 第 584-595 行 `rewrite_request_headers` 的 Host 重写
- **现状**：Host 重写为 `127.0.0.1:{port}`。code-server 用的是 `0.0.0.0:{port}`。
- **影响**：如果目标应用只监听 `0.0.0.0`（所有接口），连接 `127.0.0.1` 仍然有效。但某些应用可能通过 Host 头校验是否匹配。`0.0.0.0` 作为 Host 值可能被某些服务器拒绝。建议改为 `localhost:{port}` 或 `127.0.0.1:{port}` 的现有值保持。
- **修复**：无需修改，`127.0.0.1` 是正确的。

#### 4.13 子域名入口的 `Host` 头剥离端口不完善

- **文件**：`src/proxy/mod.rs` 第 160-173 行 `parse_proxy_host`
- **现状**：`rsplit_once(':')` 剥离端口后缀，但如果是 IPv6 地址（`[::1]:8080`）会误剥离。
- **影响**：IPv6 作为 base_host 的情况极少见，但若用户配置 `[::1]` 作为 proxy-domain，会解析失败。
- **修复**：检查 `host` 是否以 `]` 结尾（IPv6 literal），若是则不做端口剥离。

### P2 — 低优先级 / 增强

#### 4.14 子域名路由模板支持

- **参考**：code-server `domainProxy.ts:9-24` 支持 `{{port}}` 和 `{{host}}` 模板。
- **现状**：OmniTerm 只支持 `{port}.{base}`。
- **建议**：未来可增加 `--proxy-domain` 支持模板字符串，如 `--proxy-domain "code-{{port}}.example.com"`。

#### 4.15 `OPTIONS` 预检请求跳过鉴权

- **参考**：code-server `domainProxy.ts:60-62` 有 `skip-auth-preflight` 标志。
- **现状**：`proxy_host_mw` 对所有请求（包括 OPTIONS）做鉴权。如果目标应用需要 CORS 预检，OPTIONS 请求会被拦截。
- **建议**：增加 `skip-auth-preflight` 配置项，当开启时 OPTIONS 请求跳过鉴权。

#### 4.16 缺少 `rewrite_response` 扩展点

- **参考**：jupyter-server-proxy `config.py:216-248` 允许用户自定义响应重写函数。
- **现状**：响应重写逻辑硬编码在 `forward_http` 中。
- **建议**：将 `rewrite_response` 抽取为 trait 或 closure，允许用户按需扩展（如自定义 header 重写、body 替换等）。

#### 4.17 缺少 `absolute_url` 选项

- **参考**：jupyter-server-proxy `config.py:113` 允许 `absolute_url=True` 时不做路径前缀重写，直接透传绝对 URL。
- **现状**：OmniTerm 始终做路径前缀剥离。
- **建议**：增加 `absolute_url` 选项，让目标应用自己处理代理前缀（如果它支持 `base` 路径）。

#### 4.18 缺少 `X-Forwarded-Prefix` / `X-Forwarded-Context`

- **参考**：jupyter-server-proxy `handlers.py:335-338` 设置 `X-Forwarded-Context` 和 `X-Forwarded-Prefix`。
- **建议**：在路径前缀模式下，设置 `X-Forwarded-Prefix: /proxy/{port}` 让目标应用感知其在代理下的上下文路径。

#### 4.19 前端缺少 `0.0.0.0` 和 `[::1]` 匹配

- **文件**：`frontend/src/utils/proxyUrl.ts` 第 38、46 行
- **现状**：只匹配 `localhost|127.0.0.1|0.0.0.0`，没有 `[::1]`。
- **修复**：增加 `fe80::1`? 实际上 IPv6 loopback 是 `[::1]`。正则匹配 `\[::1\]`。

#### 4.20 上游 `https://` 支持

- **现状**：所有上游目标硬编码为 `http://127.0.0.1:{port}`。如果目标服务是 HTTPS（如某些需要 HTTPS 的 OAuth 回调），无法连接。
- **建议**：增加 `opts.https` 选项，或自动检测目标服务是否支持 HTTPS（先尝试 http，返回 302 到 https 则跟随？会增加复杂度）。

## 5. 根因分析

### 5.1 路径前缀方案的选择是最大的弓sort(源)

- 路径前缀方案需要大量的后处理（响应体重写、SPA 路由 polyfill、Location/Cookie 重写）来修补「绝对路径绕过前缀」的缺口。
- 这些后处理每修补一个漏洞，又暴露新的破绽（`<base>` 标签、`formaction`、JS 运行时拼接路径、CSS 内 `url()` 等）。
- 子域名方案天然回避了这些问题，因为浏览器对绝对路径的解析天然落到子域名 Host 上，无需重写正文。
- 但子域名方案需要**可通配符解析的域名**，局域网纯 IP 直连不可用，这是互联网基础设施的限制，代码无法解决。因此 OmniTerm 必须同时维护两个方案，复杂度翻倍。

### 5.2 手写代理（Rust 版本）缺少成熟库的边界覆盖

- code-server 使用 `http-proxy` 库（734 万周下载量），处理了：WS 生命周期、hop-by-hop 头、压缩、流式、错误处理、`X-Forwarded-*` 等。
- OmniTerm 用 `reqwest::Client` + `tokio_tungstenite` 手写，缺失了：
  - 自动解压缩（所以需要剥离 Accept-Encoding，导致上游可能拒绝明文）
  - WS graceful close（没有 Close 帧）
  - 请求体流式上传（需要全部缓存到内存）
  - 响应体流式转发的超时控制
  - 连接复用/池化

### 5.3 参考实现的部分逻辑未移植

- code-server 的 `getCookieDomain`、`ensureOrigin`、`X-Forwarded-Host` 读取、`OPTIONS` 跳过、模板化子域名。
- jupyter-server-proxy 的 `rewrite_response` 扩展、`X-Forwarded-Context`、`absolute_url` 选项。

## 6. 修复路线图

### Phase 1 — 正确性修复（P0, 1-2 天）

1. JS regex 修复 `/api` 漏匹配
2. `X-Forwarded-*` 头追加
3. `<base>` 标签重写
4. `formaction` 属性重写
5. `Location` 重写增加 `0.0.0.0` 和 `https://`
6. WS Origin 校验
7. Cookie Domain 对 IP/localhost 的防御

### Phase 2 — 健壮性修复（P1, 2-3 天）

8. SPA polyfill 注入位置修正
9. WS relay Close 帧发送
10. `Content-Encoding: identity` 处理
11. 请求体限制可配置化
12. 子域名 IPv6 主机名处理
13. 增加单测覆盖

### Phase 3 — 对齐参考实现（P2, 3-5 天）

14. 子域名路由模板支持
15. `OPTIONS` 跳过鉴权
16. `rewrite_response` 扩展点
17. `absolute_url` 选项
18. `X-Forwarded-Prefix` / `X-Forwarded-Context`
19. 前端 IPv6 loopback 支持
20. 上游 HTTPS 支持

### Phase 4 — 架构重构（可选，5-10 天）

21. 考虑将**子域名方案提升为默认形态**，路径前缀仅作为纯 IP 场景的降级。两个方案共享同一个核心转发逻辑（`forward_http` / `ws::relay`），路由层不同。
22. 如果持续维护，考虑将核心代理逻辑封装为独立的 crate（如 `omniterm-proxy`），减少边界漏洞。

## 7. 验收标准

### 单元测试

- `proxy::tests::rewrite_js_prefixes_api_without_trailing_slash` — 新增
- `proxy::tests::rewrite_html_prefixes_base_tag` — 新增
- `proxy::tests::rewrite_html_prefixes_formaction` — 新增
- `proxy::tests::location_rewrites_https_and_0_0_0_0` — 新增
- `proxy::tests::request_headers_sets_x_forwarded_for` — 新增
- `proxy::tests::request_headers_sets_x_forwarded_proto` — 新增
- `proxy::tests::request_headers_sets_x_forwarded_host` — 新增
- `proxy::tests::set_cookie_no_domain_for_ip_base` — 新增
- `proxy::tests::proxy_host_parses_ipv6_port` — 新增
- `proxy::ws::tests::enqueue_close_message` — 新增

### 集成测试

- `GET /proxy/3000/` — 静态页面正常返回
- 子域名 `GET 3000.omniterm.lan/` — 正常返回
- WS 双向 relay 建立 + 关闭
- 目标应用含 `<base href="/">` 时路径前缀模式正常
- 目标应用 `'/api'` 端点（无尾随斜杠）正常
- 目标应用 `Location: http://0.0.0.0:3000/` 被重写
- 鉴权开启时未登录 → 401
- 鉴权关闭时子域名开放

## 8. 已知限制（不会修复）

| 限制 | 原因 |
|------|------|
| JS 运行时动态拼接的路径不会重写 | 无法静态分析 JS 运行时行为 |
| CSS 内 `url()` 不会重写 | 导致 CSS 内绝对路径资源 404 |
| 路径前缀形态下 `<base>` 标签的 `href` 如果指向外部 URL 不会重写 | 外部 URL 不需要代理 |
| 上游 HTTPS 服务默认不支持 | 需要用户显式配置 `https://` 选项 |
| 大文件上传仍受 2MB 限制 | 除非改成流式上传（Phase 4 考虑） |

## 9. 附录：关键代码引用

### `rewrite_js` 当前正则（第 562 行）
```rust
static JS_API_RE: OnceLock<Regex> = OnceLock::new();
// ...
fn rewrite_js(body: &[u8], port: u16) -> Vec<u8> {
    let re = JS_API_RE.get_or_init(|| Regex::new(r#"(["'`])/api/"#).expect("valid js api regex"));
    // ...
}
```

### `rewrite_html` 当前正则（第 505 行）
```rust
Regex::new(r#"(?i)(src|href|srcset|action|poster)=(["'])([^"']*)(["'])"#)
```

### `rewrite_location` 当前实现（第 670 行）
```rust
fn rewrite_location(value: &HeaderValue, port: u16) -> HeaderValue {
    // 只处理 http://localhost:{port} 和 http://127.0.0.1:{port}
}
```

### `rewrite_request_headers` 缺少 `X-Forwarded-*`（第 584 行）
```rust
fn rewrite_request_headers(original: &HeaderMap, port: u16, is_ws: bool) -> HeaderMap {
    // 没有设置 X-Forwarded-For / X-Forwarded-Proto / X-Forwarded-Host
}
```

### `token_cookie` 无条件设 Domain（第 103 行）
```rust
fn token_cookie(token: &str, domain: Option<&str>) -> String {
    let builder = Cookie::build(("omniterm_token", token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .max_age(time::Duration::days(90));
    match domain {
        Some(d) => builder.domain(d),  // 对 IP 也会设 Domain，导致 cookie 无效
        None => builder,
    }
    .to_string()
}
```

### SPA polyfill 注入位置（第 290 行）
```rust
let body = match kind {
    RewriteKind::Html => {
        let mut with_polyfill = build_spa_polyfill(port);
        with_polyfill.extend_from_slice(&body);  // 加到 html 前，在 <!DOCTYPE> 之前
        with_polyfill
    }
    RewriteKind::Js => body,
};
```

