# OmniTerm 改进方向全景（功能 × 安全）

> 状态：**已归档 · 方向盘点（2026-09-01 建，2026-09-26 复审修订）**——本文只做方向选型与优先级排序，**不构成实施承诺**；任何方向落地前须另起独立实施计划。
> 复审结论（2026-09-26）：S2/S4/F1/F2 四项已落地（链接触见下）；安全缺口 S1/S3/S5 与体验向 F3/F4/F5/D1/D4/D5 初判「仍未落地、依旧有效」，已拆分为 `docs/dev/plans/2026-09-26-security-hardening-batch.md`（实施计划）与 `docs/dev/plans/backlog/improvement-directions-remaining.md`（backlog 跟踪）。**S1/S3/S5 随后在同日 Phase 1/3/4 实施完毕**（见下方追记与「落地状态」小节），唯独 S6 仍在评估中。
> **追记（2026-09-26，Phase 1–4 落地）**：S1 / S2' / S3 / S5 四项已实施完毕（fail-closed 启动、WS Origin 校验收敛、CORS 收紧、安全审计日志），本表中相应状态以「落地状态」小节为准；S6 与体验向各项仍未落地。
> 触发条件：用户要求基于领域知识盘点改进方向。
> 关联：`docs/reference/requirements.md`（已有需求）、`docs/dev/plans/backlog/`（既有积压）、`docs/reference/auth-not-enforced.md`、`docs/dev/plans/2026-08-13-port-forward-proxy.md`（P4 安全加固）。

---

## 1. 背景：站在哪里

调研基线（2026-09-01）：

- **已具备**：双引擎（tmux 冻结 + 自研 pty/RLE 差分帧）、ACP 会话全生命周期（审批、重连续接、空闲回收、工时记账、归档）、文件管理器 + SSE 监视、git 面板全套、端口转发代理（含路径重写）、JWT 鉴权（可开关）、登录限流、一键自更新。
- **安全短板**：auth 默认关闭；主终端/ACP WS 无 Origin 校验（CSWSH 风险）；`CorsLayer::permissive()` 且无 CSRF token；业务端点无限流；`fs::sanitize_path` 有 `allow_escape` 与 git-toplevel 放行兜底；自更新无签名校验。
- **产品定位**：「一个浏览器标签页观察并驱动多个 AI coding agent」——竞品参照系是 Claude Squad / tmuxinator / zellij / ttyd 一类的终端编排器，以及 Claude Code 网页版、OpenHands 一类的 agent 控制台。OmniTerm 的差异化在「多会话舰队化 + 深度 agent 会话语义（审批/工时/位置链接）」，改进方向应围绕放大这一差异化，而不是去补竞品都有的通用终端功能。

---

## 2. 方向总览（分级）

分级口径：**P0 = 安全欠账/信任基座**（不做会限制部署场景）；**P1 = 放大核心定位**（舰队观测与驱动效率）；**P2 = 体验锦上添花**（需求证明后再排）。

### 2.1 P0 · 安全加固：从「能用」到「敢暴露」

| # | 方向 | 要点 | 依据 |
|---|------|------|------|
| S1 | **非回环监听默认拒绝启动（fail-closed）** | 监听非 127.0.0.1 且 `auth_enabled=0` 时，从「打印警告」升级为「拒绝启动，除非显式 `--insecure-no-auth`」。现状是警告极易被忽略，等于默认裸奔 | auth-not-enforced.md 自述「部署公网前必须开启」，但机制上没有任何强制力；这是当前最高危单点 |
| S2 | **WS Origin 校验（CSWSH 防护）** | ~~主终端/ACP 三个 WS 入口补 Origin 白名单比对~~ **✅ 已落地 2026-09-26 复审：仅代理入口** | 落地范围：`src/proxy/mod.rs:158-187` 的 `origin_matches_host()`（host 一致性比对 + 畸形 Origin 拒绝 + 单测），服务于 `/proxy/{port}/ws` 子路径。**未落地**：`src/api/mod.rs:39-44` 的三个主 WS 入口（`ws_terminal_handler` / `ws_external_terminal_handler` / `ws_acp_handler`）仍无 Origin 校验——收敛为同一共享函数的目标只完成一半，剩余部分归 `2026-09-26-security-hardening-batch.md` |
| S3 | **收紧 CORS + 最小化 CSRF 面** | `CorsLayer::permissive()` 改为从 `.env.local` 读取的 Origin 白名单；变更类请求评估加 Origin/Referer 断言 | 当前依赖 SameSite=Lax 单点防御，浏览器策略一旦变化即失效 |
| S4 | **自更新完整性校验** | ~~一键更新下载产物校验签名或至少 sha256 摘要比对~~ **✅ 已落地** | `src/update.rs:445` `verify_digest()` 校验 `sha256:` 摘要（未知算法/不匹配均拒绝），`src/update.rs:415-418` 接入下载链路；无摘要发布时不静默放行。单测覆盖三条分支 |
| S5 | **敏感操作审计日志** | git push/强推、文件写/删、agent 配置变更、代理端口开通写入有界审计表（或结构化日志），设置页可查 | port-forward 计划 P4 已列「审计日志」待办，本项把它推广为全局约定；也是多设备使用时的「谁动了我的会话」答案 |
| S6 | **业务端点分级限流** | 文件上传/下载、git 操作、agent 配置测试等重端点加粗粒度限流（复用 `LoginGuard` 的滑动窗口原语） | 现有限流只覆盖登录面；auth 关闭场景下这些端点是资源与数据双重暴露口 |

**不纳入**：OAuth/多用户体系（产品是单人工具，多租户是过度设计）；WAF 级防护（交给反代层，见 D2）。

### 2.2 P1 · 舰队观测与驱动效率（放大核心定位）

| # | 方向 | 要点 | 依据 |
|---|------|------|------|
| F1 | **Token/成本记账面板** | ~~从 ACP session_update 的 usage 信息累积每会话/每项目/每日的 token 与估算成本~~ **✅ 已落地（呈现层）** | `frontend/src/components/Chat/UsageIndicator.tsx`：token 数 + 成本展示（多币种 ISO 4217 符号映射，未命中币种回退「代码+数值」）+ 上下文占用环；通道 `chatStore.ts` 的 `setUsage`。**注意边界**：当前是会话内实时呈现，未做每项目/每日的持久化累积与汇总面板——若要汇总记账另起计划 |
| F2 | **审批策略分级（降低审批疲劳）** | ~~按项目配置权限策略：只读自动放行/写操作人工审批/高危强制审批~~ **✅ 已落地（超时策略形态）** | `src/acp/permission.rs:121-127` `pick_auto_option` + abort/auto/wait 三模式（2026-09-21 用户拍板 allow_always→allow_once 优先级），见 `docs/dev/plans/archive/2026-09-21-permission-timeout-modes.md`。**注意边界**：落地形态是「超时自动处置策略」而非「按项目分级的权限策略」；若要做 project 级策略分层，另起计划 |
| F3 | **任务状态通知落地** | requirements 中 ⚪ 通知功能的具体化：turn 结束/异常退出/长时间无输出 → 浏览器 Notification API + 可选 webhook（URL 配置走 settings 表） | 检测方式可先简后繁：ACP turn 状态天然有界事件；pty 侧用「输出静默时长 + 进程存活」双信号，不做 CPU 监控 |
| F4 | **聊天历史全文搜索 + 导出** | SQLite FTS5 索引 chat_messages，聊天面板顶部搜索；单会话导出 Markdown | 会话归档已落地，归档后的检索是其自然续作；FTS5 是 SQLite 内建模块，无新依赖 |
| F5 | **命令面板（Ctrl+K）** | 全局快速跳转：项目/会话/文件/动作；纯前端，数据从既有 store 派生 | 多会话舰队场景下鼠标点树的成本随会话数线性上涨；此类面板是低成本高感知的效率杠杆 |

**不纳入**：多人协作/只读分享链接（单人定位，且分享即扩大安全面，等真实需求）；agent 任务队列编排（与 F2 的策略层重叠，先做策略再谈编排）。

### 2.3 P2 · 体验与运维打磨

| # | 方向 | 要点 |
|---|------|------|
| D1 | **内建 HTTPS（ACME/Let's Encrypt）** | 自托管公网部署的最常见门槛；可选特性，默认关，文档同时保留反代方案 |
| D2 | **部署形态标准化** | docker-compose 模板 + 反代（Caddy/Traefik）示例进 `docs/`；user-testing §10 已记「无 HTTPS 需反代」 |
| D3 | **备份/恢复** | `settings` + SQLite 库 + agent 配置的一键导出/导入；SQLite 用 `VACUUM INTO` 热备 |
| D4 | **亮色主题终端适配** | user-testing 已知限制：亮色主题下终端仍深色；至少做到主题联动的终端配色 |
| D5 | **文件管理器内联编辑** | 小文件直接编辑保存（复用 `fs::write` 端点），免开外部编辑器 |
| D6 | **rmux 双引擎**（requirements 已有） | 保持原计划：先抽引擎 trait；本清单仅确认其仍在轨道上，不重复展开 |
| D7 | **Windows 后台服务补齐**（requirements 已有） | 同上，`--daemonize`/`stop`/`status` 按既有设计实施 |
| D8 | **移动端可用性** | 现有响应式基础上的审批横幅/聊天视图可用性打磨（移动端最常见的操作就是看进度 + 点审批） |

---

## 3. 建议推进顺序与理由

> 以下为 2026-09-01 原始建议；2026-09-26 复审后的实际顺序以 `docs/dev/plans/2026-09-26-security-hardening-batch.md` 与 `docs/dev/plans/backlog/improvement-directions-remaining.md` 为准。

1. **S1 + S2 + S4**（一个安全批次）：三者都是「小改动、大信任收益」，且互不耦合。S1 消灭默认裸奔，S2/S4 堵住两个具体攻击面。预计合计 < 1 周。
2. **F1（成本记账）**：管道已被工时记账验证过，是「确定性最高」的新功能，且直接命中产品定位。
3. **F3（通知）+ F2（审批策略）**：构成「少盯屏也能管舰队」的组合拳；F2 依赖对多实现 `request_permission` 行为的逐一确认（工程准则 §8），需要先做实现差异调研。
4. **F4/F5 与 P2 各项**：按用户反馈信号排期，无强依赖。

## 4. 风险与约束提醒

- **无界红线**：F1 的 usage 累积、F4 的 FTS 索引、S5 的审计表都涉及数据累积，实施时必须遵守 `docs/dev/performance-and-safety.md` §P1（显式上限 + 超限策略 + 单测）。
- **多实现兼容**：F1/F2 依赖 ACP 通知字段，属可选字段高发区（AGENTS §8），实施前须在 `docs/architecture/backend.md` 沉淀各实现差异。
- **架构边界**：S2/S6 动中间件层、F1 动 ACP 层，均须先读对应架构文档与既有 plan（见文档索引触发条件），不得绕过 `EngineRegistry` 分层。

## 5. 文档闭环（若方向被采纳）

- 每个落地方向另起独立实施计划（`docs/dev/plans/YYYY-MM-DD-*.md`）。
- S 系落地后回写 `docs/reference/auth-not-enforced.md` 现状表；F 系需求确认后登记 `docs/reference/requirements.md`（该文件仅人工明确要求时更新）。
- 功能性落地须补 `CHANGELOG.md` 条目；`docs/dev/plans/backlog/` 中与本文重叠项（Windows、rmux）不重复登记。

## 6. 复审记录（2026-09-26）

| 方向 | 复审结论 | 证据 / 去向 |
|---|---|---|
| S1 fail-closed | ❌ 未落地，依旧有效 | `src/main.rs:1035-1043` 仍仅 `tracing::warn!`；无 `--insecure-no-auth` flag → 归入 2026-09-26-security-hardening-batch Phase 1 |
| S2 WS Origin | ⚠️ 半落地 | 代理入口已落地 `src/proxy/mod.rs:158-187`；三个主 WS 入口（`src/api/mod.rs:39-44`）无校验 → 归入 2026-09-26-security-hardening-batch Phase 2（收敛为共享校验函数） |
| S3 CORS 收紧 | ✅ 已落地（2026-09-26，`security-hardening-batch` Phase 3） | `permissive()` → 默认仅同源 + 显式 origin 白名单（`OMNITERM_CORS_ALLOWED_ORIGINS`），判据真源 `src/ws/cors_policy.rs`；原「从 `.env.local` 派生白名单」的方案因端口推导不可行改为显式配置，且未做变更类请求的 Origin/Referer 断言（CSRF 侧由 `SameSite=Lax` + S1 fail-closed 兜底，理由见 Phase 3 实施记录） |
| S4 自更新校验 | ✅ 已落地 | `src/update.rs:445` `verify_digest()` + 三条单测 |
| S5 审计日志 | ✅ 已落地（2026-09-26，`security-hardening-batch` Phase 4） | 独立有界表 `audit_log`（滚动 1000 条）+ 写入收敛为 `api::audit::record` 一个函数；覆盖文件写/删/上传、git push、agent 配置增删改、代理端口首次访问；读口 `GET /settings/audit-log` + 设置页只读区块。与原设想的两处偏差：① actor 带来源 IP（JWT `sub` 恒为 `admin`，单写身份无区分度）；② 代理端口**没有「开通」原子事件**（catch-all），改为按端口去重记「首次访问」 |
| S6 端点限流 | ❌ 未落地，依旧有效 | 仅登录面 `src/auth/rate_limit.rs` `LoginGuard` → 2026-09-26-security-hardening-batch Phase 5（价值待评估，端点可能已在 auth 保护下） |
| F1 成本记账 | ✅ 已落地（呈现层） | `frontend/src/components/Chat/UsageIndicator.tsx` + `chatStore.ts` `setUsage`；汇总面板模式未做 |
| F2 审批策略 | ✅ 已落地（超时策略形态） | `src/acp/permission.rs:121-127`；project 级分层未做 |
| F3 通知 | ❌ 未落地 | 无 Notification API / webhook → backlog |
| F4 FTS 搜索+导出 | ❌ 未落地 | 无 FTS 索引、无导出 → backlog |
| F5 命令面板 | ❌ 未落地 | 无 Ctrl+K 面板 → backlog |
| D1 HTTPS | ❌ 未落地 | 无 TLS/ACME 依赖 → backlog |
| D2 部署标准化 | ⚠️ 半落地 | 已有 `docker-compose.yml`；反代示例与文档未系统化 → backlog |
| D3 备份/恢复 | ❌ 未落地 | 无 `VACUUM INTO` 导出 → backlog |
| D4 亮色终端 | ❌ 未落地 | 终端配色未联动主题 → backlog |
| D5 内联编辑 | ❌ 未落地 | FileManager 无编辑态 → backlog |
| D6 rmux 双引擎 | ⏸ 维持 | `docs/reference/requirements.md:82-86` 待办未动，不重复登记 |
| D7 Windows daemon | ⏸ 维持 | `docs/reference/requirements.md:90-94` 待办未动，不重复登记 |
| D8 移动端 | ⏸ 部分承接 | 已有 `docs/dev/plans/backlog/pty-mobile-termux-feel.md`，不重复展开 |

**复审方法**：逐项 grep/read 源码与 migration 验证，不采信本文原始描述。工程准则 §8 相关项（F1/F2 的 ACP 字段差异）在复审中确认为「已落地的实现有兜底」，但沉淀工作仍缺，见 backlog。
