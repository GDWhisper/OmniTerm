# PTY Herdr 式全缓冲前端渲染

> **状态**：✅ **已立项（2026-08-28）**。核查确认本方案是唯一架构自洽的出路：cell_frame 模式下前端 xterm scrollback 结构性冻结（详见 `pty-scroll-handover.md` §零 核查点 3），滚轮问题的唯一出路是把历史视图职责整个移交后端。前提已验证：后端 grid 实际使用 **alacritty_terminal**（非早期文档所述 avt），配有 1000 行 scrollback（`vt.rs` `scrolling_history: VT_SCROLLBACK_LINES`），`encode_viewport_frame` 的数据基础真实存在。实施前需过一遍文末「实施前评审决策点」。
> **进度**：Phase 1 ✅（2026-08-28：`encode_viewport_frame` + `viewport_request` 控制帧 + 有界通道，前后端协议字段 `viewport: y` 已定型；前端未消费，行为无变化）。Phase 2 ✅（2026-08-28：前端 `ViewportController` + `attachCustomWheelEventHandler` 接管 + D3 状态机 + D4 alt-screen 互斥 + 单测 17 例；实施偏差见下方「Phase 2 实施勘误」）。Phase 3（手动回归验收 + 开关移除）待实施。
> **触发条件**：重新评估终端滚动架构、或前端渲染层改造时参考。
> **关联**：`docs/dev/plans/2026-08-13-port-forward-proxy.md`（协议设计）、
> `docs/dev/plans/backlog/pty-cell-frame-viewport-scroll.md`（方案 B，已撤销）。

## 背景

当前架构：

```
PTY 后端 VT grid ──cell_frame──→ xterm.js ──→ 用户
```

xterm.js 同时承担两重职责：
1. **渲染引擎**：绘制可见屏幕
2. **历史缓冲**：维护 scrollback buffer，响应滚轮

cell frame 架构已经接管了 (1)，但 (2) 仍由 xterm.js 的 scrollback 承担。方案 A 让两者和平共处，方案 B 让两者坐标对齐，方案 C 彻底放弃 xterm scrollback，由后端全权提供历史内容。

Herdr（以及 WezTerm、Zed Terminal 等现代终端）的做法是：**后端保存全部输出历史，前端只负责请求和渲染当前视口**。前端不管 scrollback，不管偏移量，不管坐标映射——它只渲染"后端说我应该看到的内容"。

## 方案

### 架构

```
PTY 后端 VT grid（含 1000 行 scrollback）
    │
    ├─ 正常输出：30fps cell_frame（仅可见屏，或全屏）
    │
    ├─ 滚轮/翻页 → 前端请求 viewport 窗口：
    │    WS 发送 { type: 'viewport_request', y: offset }
    │    → 后端 encode_viewport_frame(y) → 仅该窗口的 cell_frame
    │
    └─ resize → 后端 invalidate + 全帧
```

### 核心改动

#### 1. 后端：新增 viewport 编码模式

```rust
pub fn encode_viewport_frame(&mut self, session_id: &str, viewport_y: i32) -> String {
    let grid = self.term.grid();
    let rows = self.term.screen_lines();
    let cols = self.term.columns();
    
    // 编码 viewport 窗口：从 viewport_y 开始的 rows 行
    let start_row = viewport_y.max(0) as usize;
    let out_rows: Vec<RowData> = (start_row..(start_row + rows))
        .filter(|&r| r < grid.total_lines())
        .map(|r| self.encode_row_static(grid, cols, r))
        .collect();
    
    let frame = CellFrame {
        t: "cell_frame",
        session_id,
        width: cols as u16,
        height: rows as u16,
        full: true,
        overlay: false,
        row_indices: None,
        rows: out_rows,
    };
    serde_json::to_string(&frame).expect("CellFrame serialization must not fail")
}
```

#### 2. 前端：接管滚动行为

```typescript
// 前端 viewport 管理器
class ViewportController {
  private ws: WebSocket
  private term: Terminal
  private currentY = 0 // 当前 viewport 在缓冲区中的偏移
  
  onWheel(deltaY: number) {
    this.currentY = (this.currentY + deltaY.sign).clamp(0, maxScrollback)
    this.requestViewport(this.currentY)
  }
  
  requestViewport(y: number) {
    this.ws.send(JSON.stringify({ type: 'viewport_request', y }))
  }
}
```

### 改动清单

| 文件 | 改动 |
|---|---|
| `src/engine/pty/vt.rs` | 新增 `encode_viewport_frame(y)` 方法 |
| `src/engine/pty/terminal_ws.rs` | WS 读循环新增 `ClientControl::ViewportRequest { y }` |
| `src/ws/terminal.rs` | 新增 `ClientControl::ViewportRequest` 变体 |
| `frontend/src/hooks/useTerminal.ts` | 新增 viewport 控制器；滚轮时发送 viewport_request |
| `frontend/src/hooks/useCellFrame.ts` | viewport 帧标记（用于区分"正常帧"和"历史帧"） |

### 设计决策

#### Q1: 显示/隐藏 xterm 原生 scrollbar？

Modern 终端的答案是**隐藏**——视觉上用户看到的是后端提供的内容，xterm scrollbar 与之无关反而造成困惑。`overflow: clip` 已到位，scrollbar 已隐藏（coarse 设备额外 CSS）。如果 viewport 模式启用，强制隐藏 scrollbar。

#### Q2: 30fps 定时器在滚动时怎么处理？

**暂停**。用户在滚动历史时不需要实时更新（没有人会在 scrollback 里跑 top）。viewport_request 是按需触发的单向请求-响应，不需要周期性整帧刷新。

```
用户停止滚动 200ms 后 → 恢复 30fps（避免错过新输出）
→ 此时 viewport_y 归 0（底部），恢复正常全帧流
```

#### Q3: 复制/选择怎么处理？

xterm.js 的文本选择仍正常工作——它操作的是**当前渲染在屏幕上的内容**。用户在选择历史内容时，前端已经在显示该 viewport 窗口的内容，xterm 的选择 API 可以正确捕获。

唯一区别：此时后端 PTY 的"活动屏"和前端显示的可能不一致。但这在 tmux copy mode 中也是常态——复制和实时输出是独立的。

### 验收标准

1. 滚轮上下滚动如原生终端般流畅（无闪烁、无弹跳、无坐标错位）
2. 在 scrollback 中看到新输出 → 自动弹回底部（与 WezTerm/VSCode 终端一致）
   > **勘误（2026-08-30）**：第 2 条改为**绝对锚定刷新**，不弹回底部。实测
   > Phase 2 只实现了「回底且停止滚动 200ms → 恢复 live」，遗漏了新输出路径，
   > 导致上翻后视口永久冻结在上翻时刻的快照（在 `top` 里滚一下，之后 12s 的
   > 输出完全不可见，只有切换会话才恢复）。落地为三条：① 后端所有 cell_frame
   > 携带 `history_size`，前端按「距历史顶部的绝对行」锚定重算 y，使用户看到
   > 的行保持不变（真实终端 scrollback 语义，且保留「输出洪流中查历史」能力，
   > 一味弹底会让 T4 场景失效）；② 任意键盘输入自动回底（真实终端语义：光标
   > 必须在活动行）；③ 有未查看新输出时显示「下方有新输出 · 回到底部」提示条。
   > 细节见 `frontend/src/utils/viewportController.ts` 顶部注释。
3. 选择（Shift+拖拽）在 scrollback 中正常工作
4. 移动端 touch-scroll 同样精确
5. resize 后正确重绘

### 与方案 B 的取舍对比

| 维度 | 方案 B（Viewport-Relative） | 方案 C（Herdr 式） |
|------|---------------------------|-------------------|
| 改动量 | 中等（前端坐标映射 + 后端 viewport_y 字段） | 较大（新请求类型 + 滚动状态机 + 定时器暂停/恢复） |
| 滚动精准度 | 好（坐标对齐后滚动无错位） | 最好（后端精确提供视口内容，零猜测） |
| 性能 | cell_frame JSON 体积不变 | 低活跃期零 cell_frame（滚动中无 30fps 开销） |
| 复杂度 | 坐标映射的逻辑分散在前端和后端 | 状态机集中在前端（viewport controller） |
| 与现有架构兼容性 | 渐进增强，可独立开关 | 需要重构滚动相关代码（useTerminal + useCellFrame + Terminal.tsx） |
| 用户体验 | 接近方案 C | 与 WezTerm/VSCode 终端平级 |

**建议**：先做 B 验证坐标对齐的正确性，再考虑 C 做最终体验优化。B 是 C 的垫脚石。

> ⚠️ **勘误（2026-08-28）**：上文"先做 B"的建议随方案 B 撤销而作废——B 的前提（前端 viewport 偏移）已被证明不存在，直接按本方案实施。

### 实施前评审决策点（2026-08-28 评审补充）

以下决策点基于 xterm.js 6.0.0 与 alacritty_terminal 0.26.0 源码验证，实施时按此推进；翻盘就地加勘误。

**D1 wheel 接管点与鼠标协议互斥（已验证可行）**
xterm.js 6.0.0 的 wheel 处理顺序：① 应用侧注册了 mouse wheel（鼠标协议激活）→ 直接交给应用，② `attachCustomWheelEventHandler` 返回 false → 取消默认滚动，③ 否则走 viewport 滚动。方案 C 用 ② 接管；鼠标协议场景（tmux mouse mode / vim / htop）在 ① 已被消费，**天然互斥，无需自行判断**。

**D2 请求节流与 stale 响应**
wheel 高频触发：按 rAF 合并、仅发最新 `y`（本地 WS RTT < 1ms，无需额外限速）。响应按 y 单调性判 stale——用户已滚走的窗口帧直接丢弃，不写 xterm。

**D3 全帧流暂停/恢复状态机（细化原 Q2）**
状态：`live`（回底，正常 30fps）/ `viewport`（滚离底部）。进入 viewport：立即停止全帧/overlay/diff 渲染（避免 CUP 写入干扰窗口帧展示——虽然不拉视口，但会污染用户正在看的历史区域）；回底且停止滚动 200ms → 恢复 live 并触发一次 resync。原 Q2 的"暂停 30fps"指前端渲染层暂停，后端定时器不必停（帧到达但不渲染，避免恢复时的状态切换协议）。

**D4 alt-screen 互斥**
后端已有 alt-screen 语义事件（overlay 帧）。alt-screen 激活期间 viewport 控制器禁用，wheel 交回 xterm 默认路径（无 scrollback 时 xterm 自动转方向键发给应用，实测行为正确）。

**D5 历史行列宽**
后端 grid 历史行按会话当前宽度存储，alacritty resize 自带 reflow；`encode_viewport_frame` 按 grid 行编码，前端按当前列宽渲染。超宽内容编码时按当前 cols 裁剪，与可见屏行为一致。

**D6 移动端 touch**
`attachTouchScroll` 产生的模拟 wheel 走同一条 customWheelHandler 路径，自动进入 viewport_request，无额外工作。

**D7 遗留清理（随方案 C 落地一并删除）**
尝试 3 遗留的 `scrollModeRef` 暂存 / `pendingFullRef` flush / 回底 resync 机制：其防御的"全帧拉视口"已被证明不存在（`pty-scroll-handover.md` §零 核查点 2），方案 C 落地后成为死代码，必须移除而非兼容。

**D8 灰度策略**
一次性实现 + 配置开关（如 `OMNITERM_TERMINAL_SCROLLBACK_VIEWPORT`），不做双路径灰度——wheel 接管是行为级切换，无中间态可灰度。

**D9 分期**
Phase 1：后端 `encode_viewport_frame` + WS `viewport_request` 控制帧（含有界约束，参照 performance-and-safety §P1）；Phase 2：前端 ViewportController + customWheelHandler 接管 + D3 状态机；Phase 3：D5/D7 清理 + 手动回归（验收标准见上）。每 Phase 独立可验证、独立提交。

### 不做的

- 不放弃 cell frame diff 机制（正常输出仍用 diff 帧，节约带宽）
- 不做后端行缓存层（VT grid 已经是缓存）
- 不拦截 xterm 的文本选择（保持前端能力）

### Phase 2 实施勘误（2026-08-28，实施时就地记录）

1. **D4 需要协议补字段**：overlay 帧在 AltScreenEnter/Exit **都**会发送，仅凭帧无法区分 enter/exit，前端无法可靠判定 alt-screen 状态。落地为 `CellFrame` 新增可选字段 `alt_screen: bool`（仅 overlay 帧携带，值取编码时刻的 `TermMode::ALT_SCREEN`），协议向后兼容（其余帧省略）。原型示意中「overlay 帧即信号」的假设不成立。
2. **D2 stale-drop 降级为权威同步**：协议无请求回显字段，响应 y 经后端 `history_size` 钳制后与请求值可能不等，「按 y 单调性判 stale」不可靠（会把钳制响应误判为 stale 并永久卡死等待）。实际落地：**不丢弃**，响应 y 权威回写本地 y（无更新请求排队时），有序 WS + rAF 合并（单请求在飞）+ 本地 RTT <1ms 保证收敛，乱序窗口实际不存在。另加防御：live 模式下迟到的 y>0 窗口帧直接丢弃（恢复/重置前发出的残留请求）。
3. **D8 开关定名与范围**：定名 `VITE_TERMINAL_SCROLLBACK_VIEWPORT`（vite.config `define` 从 `.env.local` 注入，缺省开启，置 `0` 关闭）；范围仅限 **wheel handler 挂载点**（关闭即交回 xterm 默认路径——无 scrollback 时自动转方向键，仍是可用降级）。翻页/退出滚动按钮与帧门控不走开关（后端 viewport 路径相对旧 xterm 本地滚动是纯改进，无保留双路径价值）。开关属过渡期脚手架，Phase 3 验收通过后移除。
4. **D7 提前至 Phase 2**：尝试 3 遗留的 `scrollModeRef` 暂存 / `pendingFullRef` flush / pty `onScroll` 回底 resync 与 D3 状态机管转同一处代码（`useCellFrame` 入队门控 + 滚动状态源），留下即双份冲突逻辑。随 D3 落地一并移除（`useCellFrame` 不再感知滚动状态，viewport 期丢帧由控制器 `acceptFrame` 入队前门控）。Phase 3 残余范围：手动回归验收 + 开关移除。
