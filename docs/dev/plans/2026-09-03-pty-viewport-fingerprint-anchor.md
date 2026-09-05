# pty 历史视口指纹锚点（方案 C 续）

> 状态：已实施（2026-09-03）
> 触发条件：用户报告「pty 上翻后顶部旧内容不刷新 / 一部分旧内容像被冻结，来回切换终端后正常」。2026-08-30 的「绝对锚定」修复未解决。
> 关联：`docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md`（方案 C，D1-D6）、`docs/dev/plans/backlog/pty-scroll-handover.md`（§零 核查点 3）、`docs/dev/debug-patterns/terminal-pty.md` 模式 10

## 背景（全部为实测数据，非推断）

复现手段：Playwright 驱动真实前端 + WS 探针（`scripts/` 之外的一次性脚本），以及直连后端 WS 的 Node 探针。

| 现象 | 实测 |
|------|------|
| 历史**未饱和**时锚点漂移 | 输出 20 行/秒 → 视图以 **5.6 行/秒（输出速率 28%）** 滑向实时端；100 行/秒 → 20 秒漂 **109 行** |
| 历史**饱和**（1000 行）后 | 视图以 **100% 输出速率** 滑动：20 秒内窗口首行 S271 → S1803 |
| 窗口帧内容 | 42 行全部连续、无断裂 |
| xterm 渲染 vs 窗口帧 | 逐行一致（静止后 0 行不一致） |
| 后端响应节奏 | 请求 187 / 响应 187，间隔 p50=100ms，无丢请求 |

**根因**：`y`（距实时屏底部的行数）不是稳定标识。

1. 前端用 `history_size` 反推锚点，但 `historySize` 取自主线程收到的上一帧（30fps，最坏落后 33ms），请求又经 rAF 延迟 ~16ms，于是每次重拉（10 次/秒）都按「当时的 hs」重算一次锚点 → 每轮漂移 ~0.5 行，与 RTT 成正比。
2. 历史饱和后 `hs` 恒定，`y` 被钉死，**`y` 这个量根本无法表达「期间新产出了几行」** → 视图随淘汰以输出速率滑动。真实终端（xterm/wezterm）是把 viewport 钉在缓冲区行上，新输出追加在下方，只有回绕淘汰到所在位置时视图才开始滑动。
3. 「已输出行数」在 `history_size` 饱和后无法观测：alacritty 的 `Grid` 是环形缓冲，`scroll_up` 只转私有字段 `zero`，无任何公开计数。

**已排除**（均有实测支撑，避免重复排查）：窗口帧内容与 xterm 渲染不一致；alt-screen 进入/退出粘连（实测退出后接管恢复）；僵尸观察者（关闭后 0 陈旧行、反复 attach/detach 15 次后 0 陈旧行）；多观察者共享 diff 基线（用户确认单页面）；折行/CJK 内容差异；xterm 本地 scrollback 残留（实测 `scrollHeight == clientHeight`）。

## 范围与优先级

- **P0**：锚点精确不动 —— 未饱和与饱和两种情形都对齐真实终端语义。
- **P1**：协议字段与单测同步更新；计划文档勘误。
- **不纳入**：resize 期间的锚点保真（reflow 会改变行内容，指纹必然失配，退回按 y 定位即可，属已知降级）；alt-screen 期间视口（D4 已禁用接管）；tmux 路径（copy-mode，不受影响）。

## 设计决策

### D1：锚定**内容指纹**，而非位置

请求携带窗口首行的指纹，后端按指纹在**有界窗口**内重定位该行当前的位置，按新位置出窗口并回传实际 `y` 与新指纹。

- **否决：后端新增「已输出行数」计数器（包装 vte Handler）** —— 致命缺陷：`alacritty_terminal::Term::input()` 在字符触发自动折行时**内部调用 `self.wrapline()`**（→ `linefeed()`），不经过我们的 Handler 包装层，长行折行导致的滚动（agent 输出最主要的滚屏来源）计数不到；且需透传 66 个 trait 方法，vte 新增方法会静默失效。
- **否决：协议改「距历史顶部绝对行号」** —— 仅修正未饱和时的漂移；饱和后（agent 会话常态）仍随淘汰以输出速率滑动，对本次症状无改善。
- **翻盘条件**：若指纹搜索在真实负载下成为 CPU 热点，或重复行（大段空行）导致可见跳动 → 改回「绝对行号 + 后端淘汰计数」。

### D2：重定位放在后端，前端不做位置推算

后端持有 grid 真相源，能在请求到达的同一时刻用最新 `history_size` 换算位置，天然免疫 RTT 与帧率滞后。前端只保留「用户滚动时按偏移定位、刷新时按指纹定位」两种意图。

### D3：有界搜索，由近及远取首个匹配

- 搜索半径 `ANCHOR_SEARCH_RADIUS = 512` 行（P1 有界），命中即停；未命中退回请求 `y`。
- 只需向旧端（索引变小）搜索即可覆盖淘汰位移，但 reflow / RI 会反向移动，故双向交替搜索。
- 重复行导致的误匹配只发生在内容完全相同的行之间 → 视觉等价，无害。
- 复用已有 `hash_grid_row`（diff 引擎同款），无新增指纹实现。

### D4：协议字段（两端同步发布，无跨版本兼容负担）

- 请求：`{ type: "viewport_request", y: <int>, fp: <hex string>|null }`；`fp` 为 null = 用户主动滚动（按偏移定位）。
- 响应帧：新增 `viewport_fp: Option<String>`（十六进制），仅窗口帧携带 = 所服务窗口首行指纹。
- 指纹用十六进制**字符串**传输：u64 超过 JS 安全整数范围，不能走 JSON number。

### D5：用户滚动与刷新的意图区分

`scrollBy` / `pageScroll`（用户意图）→ `fp: null`；`notifyLiveOutput` 触发的重拉（保持锚点）→ 带上一次响应的 `fp`。这是两种语义的分水岭，混用会让后端把用户刚滚走的位置再拉回来。

## 实施分期

### Phase 1 — 后端（`src/engine/pty/`）

| 产出 | 文件 |
|------|------|
| `encode_viewport_frame` 接收 `fp: Option<u64>`，按指纹重定位 | `vt.rs` |
| `ANCHOR_SEARCH_RADIUS` 常量 + `relocate_anchor()`（有界、由近及远） | `vt.rs` |
| `CellFrame` 新增 `viewport_fp: Option<String>` | `frame.rs` |
| `ClientControl::ViewportRequest { y, fp }`（fp 十六进制解析，非法值按 null 处理） | `src/ws/terminal.rs` |
| 读循环解析 fp 并透传 | `terminal_ws.rs` |
| 单测：命中/未命中/边界钳制/半径上限/饱和淘汰重定位 | `vt.rs` `#[cfg(test)]` |

### Phase 2 — 前端

| 产出 | 文件 |
|------|------|
| `CellFrame` 类型补 `viewport_fp`，`sendRequest(y, fp)` | `useCellFrame.ts`、`useTerminal.ts` |
| 控制器：删除 `anchorFromTop`/`anchorY()`，改为维护 `anchorFp`；刷新带 fp、用户滚动清 fp | `viewportController.ts` |
| 单测：刷新带 fp、滚动清 fp、响应同步 fp、未命中回退 | `viewportController.test.ts` |

### Phase 3 — 实测验证

- 浏览器探针复测：未饱和与饱和两种场景，锚点漂移应为 **0 行**（判据：连续采样窗口首行恒定）。
- 回归：`scripts/pty-frame-regression.mjs`；`cargo test --workspace`；`pnpm build`（含 tsc）。

### Phase 4 — 文档闭环

- `docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md`：就地加「勘误」块（原绝对锚定方案已证伪）。
- `docs/dev/debug-patterns/terminal-pty.md`：模式 10 追加案例证据 + 新规律「相对偏移不是稳定标识，位置型锚点必须改为内容型锚点」。
- `CHANGELOG.md`：实质性修复条目。

## 验收标准

- [x] 未饱和：持续输出 20 秒，窗口首行**恒定**（漂移 0 行）
- [x] 饱和：持续输出 20 秒，锚定行被淘汰前窗口首行**恒定**；淘汰到达后按真实终端语义随淘汰滑动
- [x] 用户滚动仍按偏移定位，不被指纹拉回
- [x] 窗口帧与 xterm 渲染逐行一致（静止后 0 行不一致）
- [x] 后端单测覆盖：命中 / 未命中回退 / y 钳制 / 半径上限 / 饱和淘汰
- [x] 前端单测覆盖：刷新带 fp、滚动清 fp、响应同步
- [x] `cargo fmt --all` + `clippy -D warnings` 零新增；`pnpm build` 通过；pre-commit 全绿

### 实测记录（浏览器，100 行/秒持续输出）

未饱和起步（hs 291 → 1000），每 1 秒采样窗口首行：

```
  +  1s  y= 194 hs= 405 锚点索引= 211 窗口首行=S210
  +  5s  y= 521 hs= 732 锚点索引= 211 窗口首行=S210
  +  8s  y= 769 hs= 980 锚点索引= 211 窗口首行=S210   ← 历史增长期：内容恒定
  +  9s  y= 851 hs=1000 锚点索引= 149 窗口首行=S210   ← 饱和，淘汰开始：指纹仍跟得上
  + 10s  y= 928 hs=1000 锚点索引=  72 窗口首行=S210
  + 11s  y= 994 hs=1000 锚点索引=   6 窗口首行=S226   ← 锚定行被淘汰 → 随淘汰滑动
  + 20s  y= 994 hs=1000 锚点索引=   3 窗口首行=S972
```

饱和起步（hs 恒 1000）同样：+1s~+10s 窗口首行恒为 S193（锚点索引 804 → 69），
+11s 后锚定行被淘汰才开始滑动。修复前该场景从第一秒就以 100% 输出速率滑动
（20 秒 S271 → S1803）。其余判据：帧内行号断裂 0/183、末帧与渲染不一致 0 行、
静止后 0/42 不一致；`scripts/pty-frame-regression.mjs` 20/20 通过。

## 风险与降级

| 风险 | 缓解 |
|------|------|
| 大段重复行（空行）误匹配 | 由近及远取首个匹配，误匹配只发生在内容相同行之间 → 视觉等价 |
| 锚定行被 TUI 原地重写 → 指纹失配 | 退回按 `y` 定位（等同当前行为），下一轮用户滚动重新锚定 |
| resize reflow 改变行内容 → 失配 | 同上，退回按 `y`；不追求 resize 期间保真（已声明不纳入范围） |
| 搜索未命中时的 CPU 成本 | 半径 512 有界，最坏 1024 次行哈希/请求；请求上限 10 次/秒 |

## 勘误（2026-09-04，TUI 错位排查附带发现）

- **D3「重复行误匹配 → 视觉等价，无害」在 y=0 场景不成立**：y=0 是「回底看
  live 屏」的校准请求（滚回落底 + 回底后 200ms 恢复窗口内的锚点重拉），而
  live 屏顶行（空行/提示符行）与历史行同内容是常态——指纹吸附会把回底帧
  顶成历史窗口，前端 `currentY` 被带偏后恢复定时器的 `currentY == 0` 条件
  失效，视图卡在 viewport 模式显示历史区域。修正：`encode_viewport_frame`
  对 `y = 0` 跳过指纹重定位，恒服务 live 屏（回归测试
  `viewport_frame_y0_ignores_fingerprint_even_when_history_matches`）。
  `y > 0` 的历史窗口吸附语义不变，上表「视觉等价」的判断仅对 y>0 成立。
- 详见 `docs/dev/debug-patterns/terminal-pty.md` 模式 10 追补与模式 12。
