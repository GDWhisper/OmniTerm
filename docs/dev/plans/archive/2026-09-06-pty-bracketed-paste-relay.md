# pty 会话多行粘贴变多次发送 — bracketed paste 模式中继

> 状态：已实施（2026-09-06，含勘误见 §2/§D3；手动回归 §4 第 10 条待用户执行）
> 触发条件：用户报告「pty 终端在 agent 的 TUI 输入框内复制多行内容时直接变成分段、多次发送，而不是完整的一块」
> 关联：`docs/dev/debug-patterns/terminal-pty.md` 模式 9（双终端模拟器家族）；`docs/architecture/backend.md` cell_frame 字段登记区

## 0. 交接状态（2026-09-06，排查会话产出）

| 事项 | 状态 |
|------|------|
| 根因排查 + 方案设计（用户已确认「实施」） | ✅ 完成，即本文档 |
| 本计划文档 + CLAUDE.md 文档索引登记 | ✅ 完成 |
| 代码实现（§4 第 1-7 条） | ✅ 完成（2026-09-06；第 5 条实际访问路径为 `term.modes.bracketedPasteMode`，见 §2 勘误） |
| 自动化验证（cargo test / tsc / lint / 帧回归脚本） | ✅ 完成（§4 第 8-9 条：工作区 391 测试 + 新增 3 项、tsc/lint 零新增、帧回归 20/20） |
| 手动粘贴回归（§4 第 10 条，已登记 `user-testing.md` §4.7） | ❌ 待用户执行（移动端/多行文本需真人与真机） |
| 文档闭环 + 提交 | ✅ 完成（2026-09-06 提交；手动回归发现问题另行修复） |

排查会话里建的任务跟踪器（#2 后端 / #3 前端 / #1 验证闭环）不跨会话存活，接手以 §4 清单为准，不必重建跟踪器。

接手者注意：动第一行代码前无需重新排查——§2 的六项前提已逐点核实（含 alacritty `TermMode::BRACKETED_PASTE` 变体拼写、xterm bundle 粘贴逻辑反解），直接按 §4 实施。

## 1. 根因（已确证，非推测）

**bracketed paste 模式序列 `ESC[?2004h/l` 被 cell_frame 架构吞掉，前端 xterm 的 `bracketedPasteMode` 恒为 false。**

完整证据链（全部经源码逐点核实）：

1. agent TUI（Ink 系 CLI）启动时向终端发 `ESC[?2004h` 开启 bracketed paste；此后粘贴应由终端包装成 `ESC[200~…文本…ESC[201~` 再上行，TUI 靠这对标记把整块文本原样插入输入框。未包装时多行文本里的 `\r`（换行转换后）被 TUI 当逐次 Enter → 逐行提交，即症状。
2. pty 是「双终端模拟器」架构：raw 输出由**后端 alacritty VT** 消费，模式状态记在服务端（alacritty `term.mode()` 的 `TermMode::BRACKETED_PASTE = 1 << 4`，已核实变体拼写）。
3. cell_frame 模式下前端只收 grid 重渲染帧，raw 字节流**只排干不转发**——`src/engine/pty/terminal_ws.rs:254`（`_ = rx.recv()` 分支）。
4. 因此前端 xterm 永远看不到 `?2004h`；`term.reset()`（会话切换，`useTerminal.ts:233`）还会再清一次。帧协议也没有任何模式字段可恢复它（`frame.rs` CellFrame 全字段已核对）。
5. 桌面端 Ctrl+V 走 xterm 原生 paste（bundle 已核实：`s(e, r.decPrivateModes.bracketedPasteMode …)`）——按错误的模式判断，不加包装裸发。
6. **第二条受损路径**：移动端长按粘贴 `Terminal.tsx:97` `handlePaste` 用 `navigator.clipboard.readText()` 后直接 `sendData(text)`，完全绕过 xterm——连 `\n→\r` 转换都没有，无论模式状态如何都必坏。
7. tmux 会话无此问题：raw 字节直通，前端 xterm 是唯一终端模拟器，自己跟踪 `?2004h`；tmux 还会向外层转播该模式。

## 2. 已核验的实现前提

| 前提 | 结论 | 出处 |
|------|------|------|
| 后端模式可读 | `VtState::mode()` 已暴露 `TermMode` 副本 | `vt.rs:689` |
| alt_screen 先例 | overlay 帧已按 `mode().contains(TermMode::ALT_SCREEN)` 携带标记，结构完全同型可抄 | `vt.rs:563` |
| 大段粘贴写入安全 | `PtyAttach::write` 是循环写尽（EAGAIN/0 显式报错），单帧几百 KB 无截断风险 | `pty/mod.rs:236` |
| xterm 公开 API | `term.paste(data)` 存在（typings:1275），内部自带 `\r?\n→\r` 转换 + 按自身 `bracketedPasteMode` 包装（bundle 核实） | `@xterm/xterm` typings |
| xterm 模式读取 | `term.bracketedPasteMode`（boolean，只读，typings:1919）——同步逻辑用「与 xterm 实际值对比」可自愈。**勘误（实施时发现）**： typings:1919 行号正确但该属性在 `IModes` 接口上，实际访问路径为 `term.modes.bracketedPasteMode`（Terminal 类 typings:863 暴露 `modes: IModes`）；顶层无此属性，tsc 即拦截。不影响 D3 设计，只改访问路径 | 同上 |
| CellFrame 构造点 | 仅 `vt.rs` 三处（`encode_frame_body` / `encode_overlay_frame` / `encode_viewport_frame`），无散落构造 | rg 核实 |
| 自动应答过滤器 | `ptyInputFilter.ts` 白名单形态均为完整应答串（`^…$`），**不会**误伤 `ESC[200~` 粘贴包，无需改动 | rg 核实 |

## 3. 设计决策

**D1：模式经帧协议中继，不重开 raw 转发。**
理由：cell_frame 的存在意义就是不再转发 raw 流；为一个字段重开违反架构方向。`?2004h` 是纯解析态（无渲染副作用），塞进 JSON 帧零风险。

**D2：`bracketed_paste` 字段跟随 `history_size` 的全帧携带先例（所有帧都带），不用 alt_screen 的「仅 overlay」先例。**
理由：alt_screen 靠 SemanticEvent 事件对（enter/exit）触发 overlay 帧保证不漏；bracketed paste 没有对应语义事件，若仅 overlay 携带则 TUI 启动到下次 overlay 之间前端一直是错的状态。全帧携带的代价与 `history_size` 同级（~15 字节/帧，backend.md 已有同类论证）。
注意：diff 帧也带（它是「所有帧」的一部分），前端对比的是 xterm 当前实际值，重复同步是幂等 no-op。

**D3：前端同步方式 = 消费帧时与 `term.bracketedPasteMode` 不一致则向 xterm 写 `ESC[?2004h` / `ESC[?2004l`。**
理由：xterm 只认从输入流解析的模式状态；没有公开 setter。写序列让 xterm 自己的解析器更新 `decPrivateModes`，原生 paste 路径（Ctrl+V / 中键 / contextmenu）随之全部自动修复。用「与实际值对比」做门禁：会话切换 reset 后首帧即恢复；不一致才写，帧流高频不产生写放大。

**D4：移动端 `handlePaste` 改走 xterm `term.paste(text)`，不再手拼 `sendData`。**
理由：根治双问题——绕过 xterm 的换行转换 + 绕过模式包装。且对 tmux 会话的移动端长按粘贴是**顺手修复**（此前裸发 `\n` 对 shell 是两次 Enter，同样错误）。
否决项：在 `handlePaste` 里手拼 `200~` 包装——需要自己维护模式真值（xterm 内部 `decPrivateModes` 才是权威），且丢掉换行转换，复制品劣于原生 API。
翻盘条件：若 `term.paste` 与 xterm 版本升级后的 onData 过滤链有冲突（粘贴文本撞上 `ptyInputFilter` 白名单形态——理论不可能，白名单锚定完整应答串且粘贴经 bracket 包装开头不是 ESC 前缀应答形态），实测发现再评估。

**D5：不改 `ptyInputFilter`。**
已核实其匹配均为 `^…$` 整串锚定，bracketed paste 包（含任意文本）不可能命中 DA/CPR 等应答形态。留此记录防止后人「顺手加防御」反而弄坏。

## 4. 实施清单（精确到行）

### 后端（Task #2）

1. `src/engine/pty/frame.rs` — `CellFrame` 在 `alt_screen` 字段后加：
   ```rust
   /// bracketed paste 模式标记（2026-09-06）：所有帧携带，取编码时刻
   /// `mode().contains(TermMode::BRACKETED_PASTE)`。前端据此同步 xterm 的
   /// decPrivateModes——cell_frame 模式下 raw 流不转发，TUI 发的 ?2004h
   /// 前端永远收不到，不同步则多行粘贴被 TUI 逐行当 Enter 提交。
   #[serde(skip_serializing_if = "Option::is_none")]
   pub bracketed_paste: Option<bool>,
   ```
   （Option<bool> 与 alt_screen 同型；统一 `Some(bool)`，None 仅是兼容余量。）

2. `src/engine/pty/vt.rs` — 三处构造点补字段：
   - `encode_frame_body`（~746 行区）：`bracketed_paste: Some(self.mode().contains(TermMode::BRACKETED_PASTE))`
   - `encode_overlay_frame`（~551 行区）：同上
   - `encode_viewport_frame`（~627 行区）：同上（历史窗口帧也带——模式真值与会话态相关，与视口位置无关）

3. `vt.rs` 测试模块（照 `overlay_frame_carries_alt_screen_flag` / `regular_frames_omit_alt_screen_field` 的既有写法，~1174 行区）新增：
   - `frame_carries_bracketed_paste_flag`：feed `\x1b[?2004h` 后 `encode_cell_frame` → `parsed["bracketed_paste"] == true`；feed `\x1b[?2004l` 后再编码 → `false`
   - `overlay_frame_carries_bracketed_paste_flag`：enter 后 overlay 帧 → `true`
   - `viewport_frame_carries_bracketed_paste_flag`：enter 后 viewport 帧 → `true`

### 前端（Task #3）

4. `frontend/src/hooks/useCellFrame.ts` — `CellFrame` 接口加 `bracketed_paste?: boolean`（注释指向本计划）。

5. `frontend/src/hooks/useTerminal.ts` — `ws.onmessage` 的 `msg.t === 'cell_frame'` 分支（~281 行）在 `ctl.acceptFrame` 判定**之前**消费（无论帧是否被 viewport 门控丢弃，模式真值都要同步——被丢弃的实时帧同样携带最新模式）：
   ```ts
   // 实际形态（勘误见 §2）：live 复用分支内已有的帧尺寸自愈声明；
   // xterm 6.0 顶层无 bracketedPasteMode，经 term.modes（IModes）读取。
   if (
     live &&
     msg.bracketed_paste != null &&
     live.modes.bracketedPasteMode !== msg.bracketed_paste
   ) {
     live.write(msg.bracketed_paste ? '\x1b[?2004h' : '\x1b[?2004l')
   }
   ```
6. `useTerminal.ts` — 暴露粘贴出口。在 `sendData` 附近加：
   ```ts
   const pasteText = useCallback((text: string) => {
     termRef.current?.paste(text)
   }, [])
   ```
   return 对象加 `pasteText`。注意 `Terminal.tsx` 里 `handlePaste` 的空串守卫已有（`if (text && sendData)`），改后形态 `if (text) pasteText(text)`。

7. `frontend/src/components/Terminal/Terminal.tsx` — 解构 `pasteText`；`handlePaste`（~97 行）改 `pasteText(text)`，删除对 `sendData` 的依赖（依赖数组同步改）。注释补一句：走 xterm paste 获得换行转换 + bracketed paste 包装（模式由 cell_frame 同步）。

### 验证（Task #1）

8. `cargo test --workspace`（重点 `vt.rs` 新测试）；`cd frontend && pnpm exec tsc -b && pnpm lint && pnpm test --run`（重点 `useCellFrame.test.ts` 回归）。
9. `scripts/pty-frame-regression.mjs`（`node scripts/pty-frame-regression.mjs`，需 dev 环境）：在 T7 附近确认帧字段仍全解析——脚本消费帧对象的兼容性检查（现有断言不涉新字段，应全绿；若脚本有「未知字段」断言需同步）。
10. 手动回归（`docs/reference/user-testing.md` 追加用例）：
    - pty 会话跑 claude code（或任意 Ink TUI），复制多行文本 → TUI 输入框内 Ctrl+V → 整块进入输入框，不触发提交
    - 同场景移动端长按粘贴 → 同上
    - tmux 会话移动端长按粘贴多行 → shell 里换行为 `\r`（行为与桌面一致）
    - 会话切换后再粘贴 → 模式仍同步（首帧自愈路径）
11. 按第 5 节闭环文档后提交：`fix: pty 会话 bracketed paste 模式经 cell_frame 中继，修多行粘贴被逐行提交`。

## 5. 文档闭环（实施完成后）

| 文档 | 动作 |
|------|------|
| `docs/dev/debug-patterns/terminal-pty.md` | **模式 9 追加案例证据行**（同家族：双模拟器下影响输入语义的模式状态必须后端中继；本案 = bracketed paste）。不新开条目（家族合并纪律） |
| `docs/architecture/backend.md` | cell_frame 字段登记区（`history_size` 条目后，~150 行）加 `bracketed_paste` 一段：所有帧携带、语义、前端同步方式 |
| `docs/architecture/frontend.md` | 无结构性新增（hook/组件均为改动非新增），不加 |
| `docs/reference/user-testing.md` | 加第 4 节第 10 条的三条用例 |
| `CHANGELOG.md` | 用户可见修复，加条目 |
| 本计划 | 状态改「已实施」，实施偏差就地加「勘误」块 |

## 6. 风险与边界

- **帧体积**：+~20 字节/帧（bool 序列化），与 history_size 同级，可忽略。
- **旧前端/新后端兼容**：字段是新增可选（`skip_serializing_if`），旧前端忽略未知字段，无破坏。
- **新前端/后端未升级**：前端对 `bracketed_paste != null` 判空，旧后端不发了就是 no-op（移动端 pasteText 改造独立受益，不依赖字段）。
- **粘贴内容撞 onData 过滤器**：理论不可能（D5 已核），实测若撞见按 D3 翻盘条件处理。
- **viewport 模式（上翻历史）期间粘贴**：`onData` 链路的 `scrollToLive()` 会先回底，粘贴语义不变——与本修复正交，不需处理。
