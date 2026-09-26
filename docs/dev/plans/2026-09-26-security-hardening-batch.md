# 安全加固批次：fail-closed 监听 / WS Origin 收敛 / CORS 收紧 / 审计日志 / 端点限流

> 状态：**Phase 1–2 已实施（2026-09-26）**；Phase 3–5 待实施
> 触发条件：修改 `src/main.rs`（启动校验 / CORS layer）、`src/ws/terminal.rs` 与 `src/ws/acp.rs`（WS 入口）、`src/api/mod.rs`（路由挂载）、`src/api/files.rs` / `src/api/git.rs`（审计与限流触点）、新增审计表 migration 前**必读**
> 来源：`docs/dev/plans/archive/2026-09-01-improvement-directions.md` 2026-09-26 复审——该盘点的安全项 S1/S3/S5/S6 未落地、S2 半落地，本计划承接剩余部分
> 关联：`docs/reference/auth-not-enforced.md`（鉴权现状表，本计划落地后须回写）、`docs/architecture/backend.md`（分层约定）、`docs/dev/performance-and-safety.md` §P1（审计表上限）、`docs/dev/plans/2026-08-13-port-forward-proxy.md`（P4 安全加固与 Origin 先例）

## 背景

2026-09-01 改进方向盘点（已归档）把「安全欠账」列为 P0：不做会限制部署场景。2026-09-26 逐项复审源码确认以下欠账仍在：

| # | 缺口 | 现状证据 | 危害 |
|---|------|----------|------|
| S1 | 非回环监听 + 鉴权关闭 = 默认裸奔 | `src/main.rs:1035-1043` 仅 `tracing::warn!`，无强制力；无 `--insecure-no-auth` 逃生门 | 用户误配 `0.0.0.0` + 未开 auth 时，任何能访问端口的人完全控制本机（执行任意命令、读全部文件），且警告极易被忽略 |
| S2' | 主 WS 入口无 Origin 校验 | `src/api/mod.rs:39-44` 三个入口（`ws_terminal_handler` / `ws_external_terminal_handler` / `ws_acp_handler`）不做校验；代理入口 `src/proxy/mod.rs:158-187` 已有 `origin_matches_host` 但未收敛复用 | 恶意网页可跨站建立 WS（CSWSH），借受害者的已登录会话驱动终端/agent |
| S3 | CORS 全放开 + 无 CSRF 断言 | `src/main.rs:987` `CorsLayer::permissive()` | 当前仅依赖 SameSite=Lax 单点防御，浏览器策略变化即失效 |
| S5 | 敏感操作无审计 | git push（`src/api/git.rs:234`）、文件写/删/上传（`src/api/files.rs:805/595/502`）、agent 配置变更（`src/api/agents.rs:77/119/172`）均无留痕；代理入口无「开通」原子事件可插（`src/proxy/mod.rs:124` catch-all） | 多设备/误操作/被入侵后无法回答「谁动了什么」；port-forward 计划 P4 的审计待办一直未做 |
| S6 | 重端点无限流 | `src/auth/rate_limit.rs` `LoginGuard` 只覆盖登录面（IP+失败计次语义） | **已确认 files/git/agents/settings/sessions 全在 `require_auth_mw` 保护下**（`src/api/mod.rs:26-45`）；真正无保护的是 `proxy::routes()`（`:51`，与 `/api/v1` 平级）与 `agent_events`（public 组，靠回环+会话 token） |

分级口径沿用原盘点：**P0 = 信任基座**。S1 是其中仍存在的**最高危单点**（原盘点判断，复审确认未变）。

## 范围与优先级

| 阶段 | 方向 | 目标 | 预估 |
|------|------|------|------|
| Phase 1 | S1 fail-closed | 消灭「默认裸奔」，保留显式逃生门 | 小（半天） |
| Phase 2 | S2' 主 WS Origin 校验 | 与代理入口收敛为同一共享校验 | 小（半天） |
| Phase 3 | S3 CORS 收紧 | 从 permissive 改为白名单（从 `.env.local` 派生 + 代理子域通配），dev 路径已实测不走跨端口 CORS | 中（1 天） |
| Phase 4 | S5 审计日志 | 敏感操作留痕 + 有界表 + 设置页可查 | 中（1–2 天） |
| Phase 5 | S6 端点限流 | 先出评估结论（目标端点已确认在 auth 保护下）→ 若成立抽共享 `SlidingWindow` 实施 | 中（1 天，**先评估再实施**） |

### 不纳入范围（含理由）

- **OAuth/多用户体系**：产品是单人工具，多租户是过度设计（沿用原盘点结论）。
- **WAF 级防护**：交给反代层，宿主部署方案另见 D2（部署标准化 backlog）。
- **auth 机制本身改造**（默认开启、会话管理等）：属 `docs/reference/auth-not-enforced.md` 既有决策范畴，本文只做「auth 关闭时不许裸奔」的强制，不改变 auth 语义。
- **前端改造以外的即时通讯安全**（如 CSP 头）：与本文同一批次但耦合度低，列为 backlog 候选，不在本计划 Phase 内。

## 设计决策（ADR）

### D1 启动期校验必须是纯函数 + bail!，不做运行时开关

- **决策**：把校验提炼为 `fn enforce_listen_auth(listen_host: &str, auth_enabled: bool, insecure_no_auth: bool) -> anyhow::Result<()>`（源码内联文档写清四格真值表），放在 `daemon_notify_ready` 之前、`bind` 计算之后调用；失败 `anyhow::bail!`。纯函数便于穷举单测，且天然适配前台/daemonize 两路（daemonize 后 stderr 重定向到日志，但 `daemon_notify_fail`（`src/main.rs:575-590`）会把错误原文回传终端，`bail!` 上抛后由 `src/main.rs:1102-1104` 触发，两路可见）。
- **否决项**：① 运行时动态升降校验（监听地址运行中不变，无意义）；② 只升级 warning 为 error 日志（不阻止启动 = 无强制力，正是现状问题）；③ 把 flag 传进 `AppState` 持久化（启动期校验一次即可，持久化会引入「重启后逃生门丢失/残留」语义）。
- **翻盘条件**：若未来支持运行中改监听地址，校验须移入 listener 建立前；若 `--insecure-no-auth` 被大量自动化脚本依赖导致事故，改为「逃生门也需二次确认」。
- **逃生门命名**：`--insecure-no-auth`（可抄 `auth_enabled` 的 `num_args = 0..=1, default_missing_value = "true", value_parser = parse_bool_flag` 风格，env 名 `OMNITERM_INSECURE_NO_AUTH`）。

### D2 WS Origin 校验：复用 `origin_matches_host`，共享函数沉淀到 ws 模块

- **决策**：把 `src/proxy/mod.rs:174-188` 的 `origin_matches_host` 提升为共享（如 `src/ws/mod.rs` 或 `src/utils/`，按 backend.md 分层择一），三个主 WS 入口在 `on_upgrade` 前调用：无 `Origin` 头放行（非浏览器客户端，CSWSH 只能由浏览器触发——与代理入口现行语义一致），有但 host 不匹配 → `403 origin not allowed`。
- **否决项**：① 静态 Origin 白名单比对（代理子域名场景下 host 动态 = 端口，白名单不可枚举；host 一致性比对已覆盖该场景）；② 无 Origin 一律拒绝（会打死 curl/原生 WS 客户端与 hook 类调用）。
- **翻盘条件**：若未来前端部署域与 API 域分离且非子域同 host 模式，改回显式白名单（需同时改代理入口，届时两处一起改）。
- **注意**：`ws_external_terminal_handler` 是外部会话接管入口，同样必须校验（它甚至不需要 DB 记录，风险更高）。

### D3 CORS 收紧：默认仅同源，白名单从 `.env.local` 派生

- **决策**：`CorsLayer::permissive()`（`src/main.rs:987`，最外层、生产与 dev 同一条路径、无 dev_mode 分支）替换为「默认仅同源；允许集合从 `.env.local` 派生（`FRONTEND_PORT` / `DOMAIN` 组合）+ 代理子域 `{port}.{base_host}` 通配」。`tower-http` 的 `cors` feature 已在 `Cargo.toml:20` → 不引入新依赖。
- **dev 路径已实测确认（2026-09-26）**：dev 前端 `:9076`、后端 `:9075`，但 `/api` 与 `/proxy` 均走 vite proxy 同源中转（`frontend/vite.config.ts:30-46`，`ws: true`）→ **dev 期不产生跨端口 CORS 请求**，收紧不打断 `dev.sh` 与 WS 链路。真正产生跨源请求的是：直连后端端口、移动端真机/局域网 IP、代理子域形态（`docs/architecture/frontend.md:300` `setProxyDomain`）。
- **边界声明（勿合并）**：CORS 收紧**不能**替代 S2 —— WebSocket 握手不受 CORS 约束，CSWSH 面必须由 Phase 2 的 WS Origin 校验独立防。S3 与 S2 是两条独立防线。
- **否决项**：① 白名单硬编码端口/域名（违反配置统一管理红线——端口名已在 AGENTS.md 点名禁硬编码）；② 仅加注释不动代码。
- **翻盘条件**：若未来前端与 API 非子域同 host 部署，白名单须显式包含该集合并沉淀进 `.env.local` 注释。

### D4 审计日志：独立有界表 + 写入点收敛，不做 JSON 大列

- **决策**：新建 `audit_log` 表（迁移按 `migrations/20260913_add_config_options_snapshot.sql` 的注释风格写清列语义；**新增文件，勿改已有 migration**），列至少含 `id / actor / action / target / detail_json / created_at`；写入点收敛为一个审计函数（禁止各 handler 各写各的——§7① 同一判断多处出现）；**上限按 §P1 红线**：条目数 + 单条 detail 字节数双上限（条目超限滚动删最旧，detail 超限截断并**显式标注省略量**且按字符边界切），并配单测（含守恒断言）。读取口走 settings 页（只读最近 N 条）。
- **已确认写入点（2026-09-26 勘察，精确行号）**：
  - 文件写/删/上传：`src/api/files.rs:805` `write_file`（三分支：绝对路径直写 / `allow_escape` / 受限）、`:595` `delete_file`、`:502` `upload_file`
  - git push：`src/api/git.rs:28` 路由 → `:234` `git_push` handler（**强推**：`repo::push` 未见 `--force` 参数，强推语义须实施时确认是否需单独分流）
  - agent 配置变更：`src/api/agents.rs:19-22` 路由 → `:77 create_agent` / `:119 update_agent` / `:172 delete_agent`
  - **落差（须显式记录）**：代理端口**没有「开通」原子事件**——`src/proxy/mod.rs:124` 只有一个 catch-all `/proxy/{*path}`（dispatch 在 `:142`），任何端口首次被访问即打通。审计只能插在 `proxy_handler` 入口（按「首次出现的 host+port 记一条」），本文把它从原计划的「端口开通」改述为「代理入口首次访问」。
- **settings 助手现状（影响读写口实现）**：`src/api/settings.rs` **无共享 helper**，是「每 key 一对 handler」模式——读 `:54 get_acp_idle_recycle`、写 `:74 set_acp_idle_recycle`、多 key 样例 `:138-151 set_permission_timeout`；另 `src/main.rs:845/865/882/890` 有一份启动期读取。S5 若需读口设置项，按 §7① 应顺手抽 `settings_get/settings_upsert` 助手（已有 ≥4 处同型样板）。
- **否决项**：① 塞进 settings 表当 JSON（无界且难查，违反 §P1 精神）；② 只打 tracing 日志（用户不可查，日志轮转型不在我们手里）；③ 审计全部 git 写操作（9 个写类路由全审会写放大，只审 `push` + 文档述明的「强推」）。
- **翻盘条件**：若审计表增长远超预期且轮转删除影响排查，改为「按 action 分类保留期」分级策略。

### D5 S6 先评估后实施，不在本计划承诺必须做

- **决策**：Phase 5 第一步是评估而非编码。**已确认的路由拓扑（2026-09-26）**：`src/api/mod.rs:24` 为 public 组（仅 `health` / `auth` / `agent_events`）；`:26-45` protected 组含 13 组路由 + 3 条 WS，第 45 行挂 `require_auth_mw`（本体 `src/auth/mod.rs:111-119`）→ `files`(:34) / `git`(:36) / `agents`(:37) / `settings`(:32) / `sessions`(:31) **全部在 auth 保护下**。两个例外：① `agent_events::routes()` 在 public 组（边界 = 回环 + 会话专属 token，已有 `MAX_HOOK_BODY_BYTES=1024` / `MAX_HOOK_ENTRIES=256` 有界）；② `proxy::routes()` 与 `/api/v1` 平级、**不经过 auth 中间件**（`:51`）。
- **原语可用性纠正（重要）**：`src/auth/rate_limit.rs:10-44` 的 `LoginGuard` 是 **IP 维度 + 失败计次**语义（`is_blocked`/`record_failure`/`record_success`），**不适配**「上传频次」这类纯计数限速。所谓「复用」必须落到实处为**抽共享 `SlidingWindow` 结构**（ip/session_id → 窗口内时间戳），LoginGuard 与业务端点各自组合它。IP 取法参照 `src/api/auth.rs:79/98/120`（`ConnectInfo<SocketAddr>`，`main.rs:1093` 已挂 `into_make_service_with_connect_info`）。
- **结论路径**：若评估判定「auth 已开 + 端点已保护 + 无单用户重客户端滥用面」，本 Phase 直接关闭并在此记录，不硬做；唯一明确候选是 **`/proxy/{*path}` 转发路径**（无 auth 保护），但它是通用反代而非业务端点，限流策略需单独设计（否则会限死正常转发）。
- **否决项**：为「计划完整性」而实施无实际收益的限流（反模式）；把 `LoginGuard` 硬套到上传计数（语义错配）。
- **翻盘条件**：发现 auth 开启下仍存在单用户重客户端滥用（如移动端重连风暴、批量脚本），再按共享 `SlidingWindow` 落地分级限流。

## 实施分期

| Phase | 改动 | 产出 | 依赖 |
|--------|------|------|------|
| 1 | `src/main.rs`：新增 `insecure_no_auth` 字段 + `enforce_listen_auth()` 纯函数 + `#[cfg(test)]` 真值表单测 | 裸奔路径关闭；`cargo test` 覆盖四格 | 无 |
| 2 | 共享校验函数提升 + 三个主 WS 入口接线 + 单测（同源放行/跨站拒/无 Origin 放行） | CSWSH 面收敛为单一真源 | Phase 1 无依赖，可并行 |
| 3 | `src/main.rs` CORS 构造替换 + dev 路径实测（cors 请求从 dev 前端发出） + 单测 | CORS 不再 permissive | 依赖 dev 环境验证 |
| 4 | migration + 审计函数 + files/git/agents/proxy 写入点接线 + 上限单测 + settings 读口 | 敏感操作可查、有界 | 无强依赖，宜在 Phase 1 后 |
| 5 | 评估报告（先出结论）→ 若成立再泛化限流 | 或限流落地，或明确关闭并记录 | Phase 1 改变前提，须在其后 |

## 验收标准 / 验证清单

- [x] `cargo test enforce_listen_auth`（四格真值表全过）
- [x] `cargo test origin`（WS 校验：同源/跨站/无 Origin）
- [ ] `cargo test audit`（条目上限 + detail 字节上限 + 截断守恒断言）
- [ ] 手动：`./dev.sh restart` 后 dev 环境可正常访问（CORS 未打断）
- [ ] 手动：非回环 bind + auth 关闭时启动失败且错误信息可见（前台 + `--daemonize` 两路）
- [ ] `cargo clippy --quiet --workspace --all-targets -- -D warnings` 零新增
- [ ] 前端无改动项（Phase 4 的 settings 读口除外，需 `tsc -b`）

## 风险与文档闭环

| 风险 | 缓解 |
|------|------|
| D1 上线后有人依赖「裸奔启动」的自动化脚本突然失败 | 逃生门 `--insecure-no-auth` + 启动错误文案写清补救动作；这是刻意破坏性变更，须进 CHANGELOG |
| D3 收紧打断 dev / 反代 / 移动端访问 | Phase 3 先跑通 dev 与子域代理两条真实路径再合入；`.env.local` 可配 origin 集合兜底 |
| D4 审计表写放大影响热路径 | 写入点只选「低频高危」动作（push/force、写删、配置变更、开端口），读操作不审计；单条 detail 有字节上限 |

实施后须更新：`docs/reference/auth-not-enforced.md`（回写现状表，S1/S3 落地状态）、`docs/architecture/backend.md`（WS Origin 校验收敛点、审计表结构、`--insecure-no-auth` CLI 新参数）、`CHANGELOG.md`（D1 属破坏性启动行为变更）。

---

## Phase 1 实施记录（2026-09-26）

**产出**：`src/main.rs` 新增 `--insecure-no-auth` / `OMNITERM_INSECURE_NO_AUTH` flag + 纯函数 `enforce_listen_auth(listen_host, auth_enabled, insecure_no_auth)`；原 `tracing::warn!` 块替换为 fail-closed 校验。

**单测**（4 个，`cargo test enforce_listen_auth`）：四格真值表穷举（回环 5 种宿主 × 非回环 5 种宿主 × auth/escape hatch 组合）、逃生门独立性、未知 host fail-closed、错误信息含补救动作。

**实测六场景**（全通过）：`0.0.0.0`+auth关→rc=1 拒绝；`0.0.0.0`+auth关+逃生门→正常监听；`0.0.0.0+auth开→正常监听；默认 127.0.0.1→正常监听；`--daemonize`+拒绝组合→rc=1 且错误回传父进程；`--daemonize`+逃生门→后台启动成功。

### 实施偏差（就地记录，遵循 PLAN-TEMPLATE 纪律 3）

1. **回环集合扩充**：除计划预期的 `127.0.0.1|localhost|::1|[::1]` 外，补入 `0:0:0:0:0:0:0:1`（`::1` 的未压缩展开形式，`bind` 字符串不经规范化，该形态此前会被误判为非回环而误拒）。未知/带端口写法按非回环 fail-closed。
2. **校验点位置（时序 bug，实测捕获）**：初版把校验放在 `daemon_notify_ready` 之后，`--daemonize` 路径实测 rc=0 并打印「started in the background」，但后台进程其实已在校验处退出——**父进程拿到假成功信号**。已移至 `daemon_notify_ready` 之前（bind 之后：端口被占仍由 bind 报错，两者不重叠）。
3. **PID 文件先于校验写入**（未改）：PID 文件在 bind 成功后就写入，故拒绝启动时会留下一个指向已退出进程的 stale PID 文件。评估为可接受：`stop` 走的是「进程是否存活」判定而非 PID 文件存在性，且改动它会影响端口占用/DB 失败这两条既有路径的语义。若后续发现 stop 误判再处理。

**回归**：`cargo fmt` / `clippy -D warnings` 零问题；`cargo test --workspace` 550 单测 + 8 + 2 集成全绿（新增 4 个测试）。

**验收勾销**：`cargo test enforce_listen_auth` ✅ / clippy ✅ / 非回环拒绝两路可见 ✅。

---

## Phase 2 实施记录（2026-09-26）

**产出**：新建 `src/ws/origin_guard.rs` 承载共享防线 `enforce_ws_origin(&HeaderMap)`，三个主 WS 入口（`ws_terminal_handler` / `ws_external_terminal_handler` / `ws_acp_handler`）在 `on_upgrade` 之前调用；`src/proxy/mod.rs` 的私有 `origin_matches_host` / `strip_port` 连同三个单测**删除**，改为调 `crate::ws::origin_matches_host`——同一判断不再有两份实现（S2'「半落地」的根因）。

**新增单元测试**（`cargo test origin`，共 17 个）：入口级 8 个——同源放行、同源端口不一致放行、代理子域放行、跨站 403、畸形 Origin 403、**无 Origin 放行**、**无 Host 放行**、空 header map 放行；纯函数 9 个——含本轮新补的 IPv6 字面量、host 大小写不敏感、空 host 段拒绝、Origin 带 path/query 截断。**「无 Origin 放行」原本完全没有测试**：判定函数签名是 `(&HeaderValue, &str)`，表达不了「头不存在」这一态，必须做成入口级 predicate，计划验收项 `cargo test origin`（同源/跨站/无 Origin）这才真正落全。

**实测十场景真实握手**（起独立实例 `--port 19871 --db sqlite://…`，隔离 dev 环境；dev 库 `auth_enabled=1`，`require_auth_mw` 的 401 会先于 Origin 校验返回，看不到边界）：terminal / acp / external / proxy 四个入口各测同源→101、无 Origin→101、跨站→403、畸形→403，**10/10 PASS**，403 响应体逐字 `origin not allowed`，`ws origin rejected` warn 按预期留痕。Node `WebSocket` 裸握手（实测不发 Origin）仍 101 → `scripts/pty-*-regression.mjs` 与 `tests/agent_hook_integration.rs` 的裸握手回归**不受影响**，这是本轮最需要守住的一条。

### 实施偏差（就地记录，遵循 PLAN-TEMPLATE 纪律 3）

1. **落点选 `src/ws/mod.rs` 而非计划 D2 提的 `src/utils/`**：勘察发现 `src/utils/` 是死模块——`src/utils/mod.rs` 只有 1 个字节，`docs/architecture/backend.md:75` 声明的 `src/utils/path.rs` 与实际位置（真实在 `src/fs/mod.rs`）不符，全仓零调用点。启用它必须顺手修文档，属计划外副作用；`src/ws/mod.rs` 本已是三入口收敛点。backend.md:75 的陈旧描述本轮不改，另见 backlog。
2. **`strip_port` 一并提升**：`origin_matches_host` 依赖它，只提前者编译不过（原同为 proxy 私有）。
3. **`host_from_request` 未提升**：它取 `&Request`（仅 proxy WS 分流上下文持有），与 WS 入口的 `HeaderMap` extractor 形态不同；2026-08-13 计划勘误⑤ 明确「共享函数**不能持 `&Request` 跨 await**」。保持 proxy 侧私有取值、共享侧只共享判定，边界更干净。
4. **入口级 403 由 `enforce_ws_origin` 统一返回响应**（而非每个 handler 各写 `StatusCode::FORBIDDEN`）：判定与响应文案同处一份，避免四份文案漂移。proxy 侧需先判 WS 再进 `dispatch`，沿用原 let-chain 形态但改调共享判定函数，行为逐字不变。

**回归**：`cargo fmt` / `clippy -D warnings` 零问题；`cargo test --workspace` 562 单测 + 8 + 2 集成全绿。

**验收勾销**：`cargo test origin` ✅（17 个）/ 三入口 + 代理入口真实握手 10/10 ✅ / 裸握手回归不受影响 ✅。
