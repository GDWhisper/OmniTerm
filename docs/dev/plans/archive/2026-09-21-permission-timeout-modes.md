# 权限请求超时：三模式可配 + 超时告知带请求详情

> 状态：已实施（2026-09-21）
> 触发条件：修改 `src/acp/reaper.rs`（超时三分支）、`src/acp/permission.rs`（`pick_auto_option` / 请求摘要）、`src/api/settings.rs`（permission-timeout 路由）、`src/main.rs`（`PermissionTimeoutConfig` 注入）、`frontend/src/components/Settings/Settings.tsx`（`PermissionTimeoutSection`）、system 消息 detail 渲染任一项前必读
> 关联：`docs/architecture/backend.md`（ACP 生命周期 / blocks 两态 / Settings 表）、`docs/dev/plans/archive/2026-08-18-permission-recycle-notice.md（本计划翻盘其「不做自动 Allow」决策，文末勘误）`、`docs/architecture/frontend.md`（设置面板结构）、`docs/workflows/agent-edit-manual.md`（Settings 维护约定）

## 背景

2026-08-18 计划落地了「权限超时回收前写 system 消息告知」，但用户实测反馈两个缺口：

1. **回来后不知道自己错过了什么**：告知是纯文案（「已自动取消该请求并回收会话」），不含请求内容与当时的可选项——用户无法判断那次审批该不该点、错过了哪些选项。
2. **超时行为没得选**：30 分钟一刀切 cancel + kill。有的用户希望 agent 挂着自己回来再答（长任务中途离开），有的希望到点自动放行让任务继续——唯一选项是"会话被杀，重开继续"。

根因：超时阈值与行为都是后端硬编码（`REQUIRES_ACTION_RECYCLE_SECS`），告知载荷只有一句文案。

## 范围与优先级

- P0：设置面板三模式（一直等待 / 自动推进 / 超时中止）+ 共用倒计时（分钟，1..60，默认 30）
- P0：三种模式到点行动都写**带详情的 system 消息**（工具名/类型、内容预览、可选项、auto 模式选中项、超时分钟），前端本地化渲染
- P1：启动时 GET 回填两项后端设置（修复 `getAcpIdleRecycle` 定义后从未被调用、刷新后滑块重置默认值的缺口）
- 不纳入（理由）：
  - 权限请求到来即落库成聊天消息——会刷屏；在线场景 banner + 断连重放已覆盖，超时告知才需要持久化
  - sidebar 全局横幅 / 浏览器 Notification——08-18 计划已明确留后，本轮维持
  - banner 上显示实时倒计时——设置里的分钟数已表达；需要时后续在 `PermissionBanner` 加倒计时徽标
  - auto 模式可指定"自动选哪个选项"的子设置——D2 固定优先级已覆盖主要诉求；翻盘条件见 D2

## 设计决策 / ADR

**D1 三模式语义**（settings 表 `acp_perm_timeout_mode`，白名单 abort/auto/wait）：

| 模式 | 到点行为 | 会话 |
|---|---|---|
| `abort`（默认） | cancel + kill，写带详情 system 消息 | 回收（原安全策略） |
| `auto` | `pick_auto_option` 逐笔代替用户应答全部 pending，每笔一条带详情 system 消息 | 保留，agent 继续执行 |
| `wait` | 无任何动作（含跳过 prompt-stale 定稿） | 保留，banner 挂到用户回来 |

- 否决项：保持硬编码单模式（用户明确要选择权）；wait 模式也保留 10 分钟 prompt-stale 定稿（会把"等审批"回合误判卡死并广播结束，与用户随后的应答竞态——09-19 幽灵行计划的同一类竞态）。
- 翻盘条件：实测 wait 模式下 agent 长时间挂起导致前端无任何"仍在等待"反馈 → 给 banner 加心跳/倒计时徽标（P1 排除项的触发条件）。

**D2 auto 模式选项挑选优先级：allow_always → allow_once → reject_once → reject_always → 首个可选项**（用户 2026-09-21 拍板 allow_always 优先）。

- 理由：无人值守时一次放行、避免同一请求在后续回合反复挂起；allow_once 次之（最小授权）；无 allow 选项时退 reject（不放行但让 agent 继续回合）；兜底首个（agent 自定义 kind）。
- 代价（知情同意）：auto 模式 = 无人值守时自动放行 agent 操作，allow_always 还会留下持久授权。缓解：默认模式仍是 abort；面板在 auto 模式常驻风险警告；system 消息明示实际选中项。
- 翻盘条件：用户要求固定选 reject / 在设置里指定选项 → 加子设置（选择规则抽在 `pick_auto_option` 一处，改动面小）。

**D3 超时时长共用**：`acp_perm_timeout_min`（1..60，默认 30）供 abort/auto 共用；wait 不使用（滑块隐藏）。复用 `DisconnectSlider`（1..60）；警告线用 `warnAboveMin={30}`——默认 30 即历史行为，只有调得更长才提醒内存驻免（其余三个滑块默认值远低于 30，维持 >= 30 即警告）。

**D4 告知载荷结构化**：system 消息从纯文案升级为 `label`（i18n key，`system.permTimeout.abort|auto`）+ `detail`（`{minutes, tool, kind, content, content_omitted, options, selected, extra}`）。label 存 key、text 列存后端 compose 的中文兜底文案（与 08-18 起 system 行语义一致）；前端 `SystemBlockView` 命中 key 则插值本地化（en/zh），未命中原样显示（历史中文数据可读）。detail 经 WS `system_message` 帧 + DB blocks 两条路到前端（在线广播 / hydrate 各覆盖一半）。

**D5 多实现兼容（§8）**：

- 选项 kind 是协议枚举但实现可能只给 `other`/自定义 name，或线格式中转层用 `option_id`（snake_case）——`pick_auto_option` 同时认 `optionId`/`option_id`，label 取 `name` 优先、缺失回退 kind 原值。
- 请求 JSON 的 toolCall 键同时认 `toolCall`/`tool_call`；content 兼容字符串/数组/`{type:'content'}`/rawInput 兜底（与前端 `extractToolContent` 同源但只取预览，不重排 diff）。
- 一笔都解析不出合法选项时：auto 模式降级为 abort（不能瞎猜也不能永久挂起），warn 日志留痕。
- agent 在完全静默期间连发审批（last_activity 不刷新）时，后续审批可能在到达后一个 tick（≤30s）内被自动处理——已知边界，auto 模式语义（"别等我"）下可接受；升级路径是给 pending 条目记到达时间，本轮不做（会同时改变 abort 的"久无活动"口径）。

**P1 红线落地**：content 预览截断 400 字符（char 边界，省略量进 detail 由前端本地化标注）；单 tick 告知消息上限 `MAX_PERM_NOTICE_REQUESTS`=5（超出的笔数只应答不再逐条告知，warn 留痕）；abort 消息汇总首笔 + `extra` 计数。

## 实施分期（已落地）

Phase 1 后端：`permission.rs` 纯函数（`pick_auto_option` / `summarize_permission_request` / 截断）→ `reaper.rs`（`PermissionTimeoutMode` + `PermissionTimeoutConfig` + 三分支 + notice builder）→ `client.rs`（`SystemNotice{label, detail}` 广播载荷）→ `ws/acp.rs`（帧加 detail）→ `api/settings.rs`（路由 + 校验）→ `main.rs`（AppState 字段 + 启动加载 + reaper 注入 + 解析纯函数）。
Phase 2 前端：`chatStore`（`SystemBlock.detail` + `pushSystemEvent` 第三参）→ `useAcpChat`（帧透传）→ `ChatMessage`（detail 渲染 + i18n）→ `appStore`（`permTimeoutMode/Min`）→ `App.tsx`（启动回填两项设置）→ `Settings.tsx`（`PermissionTimeoutSection`）→ 两个 translation.json。
Phase 3 测试与文档：Rust 21 项新单测（选项优先级/摘要/配置/路由/解析）；前端 7 项新用例 + 既有滑块用例索引修正；backend.md / frontend.md / agent-edit-manual / 08-18 勘误 / CHANGELOG / requirements / 本计划 + AGENTS 索引。

## 验收标准 / 验证清单

- [x] `cargo test --workspace` 全过（含 21 项新单测：allow_always 优先、reject 兜底、畸形请求 None、截断守恒、模式白名单、路由默认/越界/热更新、启动解析回退）
- [x] `cargo clippy --all-targets -- -D warnings` / `cargo fmt --all` 零告警
- [x] 前端 `pnpm test` 699 全过（Settings 权限超时 7 例 + chatStore detail 1 例 + 既有滑块用例改 4 滑块）
- [x] `pnpm exec tsc -b` / `pnpm lint`（0 error，18 项存量 warning 与改动前一致）/ `pnpm build` 通过
- [ ] 手动回归（dev 环境，需维护者执行）：临时调小 `acp_perm_timeout_min` 至 1 → 三种模式各验证：abort 聊天出现带工具/选项的告知且刷新后仍在；auto 告知明示选中项且 agent 继续执行；wait 会话不被回收、banner 重连后仍在

## 风险与文档闭环

| 风险 | 缓解 |
|---|---|
| auto 模式无人值守自动放行 | 默认 abort；面板常驻风险警告；告知明示选中项；用户显式选择该模式（D2 知情同意） |
| wait 模式回合永不结束（前端卡 running） | 与用户"一直等待"诉求一致；prompt-stale 已跳过；agent 崩溃仍有 crash 通道收敛 |
| 历史中文 system 行 | label 未命中 i18n key 时原样显示（`t(key, {defaultValue})`） |
| system 消息 text 列中文、UI 英文 | text 列仅作可读兜底（system 行无复制/搜索入口）；UI 渲染走 i18n |

- `CHANGELOG.md` ✅（Added 条目）
- `docs/architecture/backend.md` ✅（permission 超时行为、Settings 表两 key、API 两条、blocks detail）
- `docs/architecture/frontend.md` ✅（设置面板结构、system detail 渲染链路）
- `docs/dev/plans/archive/2026-08-18-permission-recycle-notice.md` ✅（勘误块：自动 Allow 决策翻盘）
- `docs/workflows/agent-edit-manual.md` ✅（Settings entry：三滑块 → 四滑块 + 模式行）
- `docs/reference/requirements.md` ✅（自动断连/回收超时可调条目标注权限超时）
- `AGENTS.md` 文档索引 ✅（本文件登记行）

## 勘误：时长改秒制 + 新增「总是」/30 秒档（2026-10-01）

**D3（时长共用，分钟制 1..60）被用户要求翻盘**：面板滑块要「总是」和「30 秒」两个档位。落地取舍：

- **单位换秒**（settings `acp_perm_timeout_min` → `acp_perm_timeout_secs`，API 字段 `{mode, minutes}` → `{mode, seconds}`）。理由：30 秒在分钟制里无法表达；reaper 本来就按秒判定（`AtomicU64`），换算只发生在边界一处。存量 DB 兼容——GET / 启动解析在新键缺失时回退读旧分钟键，PUT 时删除旧键；旧键不再产出。
- **档位表**（`acp::reaper::is_valid_perm_timeout_secs` 为单一真源，前后端同值）：`0` 或 ≤3600 的 30 秒倍数。滑块全程 30 秒一档（`PERM_TIMEOUT_STEP_SECS=30`），未做「只有 30 秒特殊、其余仍按分钟」的刻度映射——那会让 30 秒与 1 分钟挤在左端几乎无法分辨。
- **`0` = 「总是」，语义随模式而变**（用户拍板：「只在自动推进模式下生效，总是——指自动放行，不等待」）：
  - `auto`：视为立刻到点，有未决请求即 `auto_advance_permissions`（不等用户）；
  - `abort` / `wait`：**没有触发点 = 永不超时**，且与 `wait` 同样跳过 prompt-stale 定稿——否则「等审批」的回合会被 10 分钟 prompt-stale 误判卡死并广播结束（与 D1 拒绝在 wait 下保留 prompt-stale 是同一个竞态）。
  - 面板只在 auto 模式把滑块下限放到 0，其余模式从 30 秒起；从 auto（0）切走时按时长下限夹回 30 秒，避免停在拖不到且语义无效的值上。用户要「不中止」仍用 `wait` 模式。
- **告知载荷**：`detail.minutes` → `detail.seconds`；文案口径统一为「整分钟报分钟、其余报秒」（与后端 `format_perm_duration` 同规则），30 秒档不再显示成「0 分钟」。历史行只有 `minutes`，前端按 ×60 回退（`utils/permTimeout.ts`，单测覆盖）。auto + 「总是」档另给一句无等待文案 `system.permTimeout.autoAlways`（沿用「N 秒未获响应」会自相矛盾）。
- **翻盘条件**：若将来要把「总是」扩展为 abort 模式的「永不中止」（等价 wait），则面板下限应对所有模式放开到 0，本条「只在 auto 露出」的前端约束即可撤掉——后端语义已经支持，无需再改 reaper。

## 勘误：「总是」档改为权限请求到达唤醒，不等 tick（2026-10-09）

**用户实测缺陷**：设置「自动推进 + 总是」后仍有十几秒等待。根因——上节勘误承诺 `auto + 0`「有未决请求即 `auto_advance_permissions`（不等用户）」，但该判定只在 `run_reaper` 的 30 秒 tick（`TICK_SECS`）上被评估，权限请求到达后实际等 0~30 秒（均值 ~15 秒），与「不等待」语义矛盾。

**修复**（`src/acp/reaper.rs` / `src/acp/client.rs`）：

- `PermissionTimeoutConfig` 增加 `Notify` 唤醒信号（`notify_perm_request` / `wait_perm_request`）；`run_reaper` 主循环改为 `select!`（定时 tick ∥ 到达唤醒），两种唤醒源执行同一轮检查——判定条件完全不变，只是评估时机更快。
- 触发点在 ACP 权限请求闭包：`handle_request` → `begin_wait` **之后**唤醒（`begin_wait` 在前保证 reaper 的 `resolve → end_wait` 不会倒挂等待计时）。
- 绑定走 `AcpClient::attach_perm_timeout`（与 `attach_persistence` / `attach_config_prefs` 同模式），仅 create-session / load restore 两个真实注册点调用；能力探针不绑定 → 无唤醒，回退 tick 兜底（探针不产生用户可见审批）。
- `PUT /api/v1/settings/permission-timeout` 写入后同样唤醒：已有未决审批时切到「总是」档不必等下一个 tick。
- 唤醒**无条件**触发（不限 auto+0）：多跑一轮是幂等的（全部触发条件基于「时间阈值 + 未决数」，提前评估只会更及时），避免在客户端复制一份「何时该唤醒」的判定造成两处漂移（工程准则 7）。
- 定时 tick 保留：idle / 非零档权限超时 / prompt-stale 仍是时间阈值制，30 秒粒度足够；D5「久无活动」口径不变（非零档仍按距最后活动计时，唤醒只让它更及时）。
- 回归防线：`fake_agent_tests::always_auto_mode_answers_permission_on_arrival_not_next_tick`（放过首轮立即 tick 后发请求，断言数秒内自动应答 + 告知广播/落库 + 选中项送达 agent）；`reaper::perm_request_notify_wakes_waiter_and_is_not_lost`（唤醒不丢语义）。

