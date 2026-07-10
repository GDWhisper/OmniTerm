# 移动端 scroll mode 进入 copy mode 后无法翻页

> **状态**：待修复（与 `b950cf1` 无关，是 pre-existing 基础设施 bug）。
> **复现概率**：100%（iOS Safari + Android Chrome 移动端均触发）。
> **影响范围**：移动端 MobileKeyBar 的 ↑/↓/PgUp/PgDn 在 scroll mode 下完全失效。
> **推荐方案**：见文末"方案 1"，改动面最小、绕开故障层最彻底。

## 症状

移动端点 "滚动" 按钮进入 scroll mode（UI 高亮、tmux `pane_in_mode=1`）后，按 ↑/↓/PgUp/PgDn 全部**没有任何翻页效果**。再次点 "滚动" 退出 scroll mode 也正常。

桌面端用 `tmux send-keys` 直发 k/PgUp 也复现——所以与前端无关。

## 诊断证据

> 关键观察：tmux 进入了 copy mode（`pane_in_mode=1`），但**所有 paging 键被静默丢弃**，`scroll_position` 始终为 0。

### 实测脚本

`/tmp/ws_test7.py`（完整复现路径：WS → 后端 → PTY → tmux client）：

```python
# 关键步骤：连 WS、发 5 条 echo 建历史、进 copy mode、发 k*3、看 tmux 状态
await ws.send(b'\x02[')        # 前缀 + [ = 进入 copy mode
await ws.send(b'k' * 3)         # 连发 3 次 k
# tmux display-message 读 scroll_position → 0, 没动
```

### 三路测试结果（同一 session）

| 路径 | 操作 | tmux 状态变化 |
|---|---|---|
| **TEST 1** WS → PTY | 进 copy + `k*3` | `pos=0 → 0` ❌ |
| **TEST 2** `tmux send-keys`（绕开 PTY）| 进 copy + `k*3` | `pos=0 → 0` ❌ |
| **TEST 3** `tmux send-keys -X copy-mode` + WS `k*3` | 进 copy + `k*3` | 连 copy mode 都没进（`-X` 用法问题，跳过）|

**TEST 2 是关键**：连 `tmux send-keys` 直发（tmux 官方通道，绕开 PTY 那一路）都不能动 position → 问题**不在前端、不在 PTY 写入**。

### capture-pane 证据

`tmux capture-pane -e -p -S -30` 在 copy mode 下抓取屏幕内容：

```
 1: pax@pax-GEM12:/tmp$ echo X1
 2: X1
 3: pax@pax-GEM12:/tmp$ echo X2
 4: X2
  ...
```

**屏幕仍是 live content（echo 输出 + 提示符），没被重绘成 scrollback**。tmux 进入 copy mode 后，pane 应当被 scrollback 视图重绘——这一步没发生。

### tmux 状态（display-message）

| 状态字段 | 期望 | 实际 |
|---|---|---|
| `#{pane_in_mode}` | 1 | 1 ✓ |
| `#{scroll_position}` | k*3 后 > 0 | 0 ❌ |
| `#{copy_cursor_x},#{copy_cursor_y}` | 应有变化 | 始终 `20,10` ❌ |

## 根因分析（高置信度，未直接定位到代码行）

PTY 那一头的 tmux client 在 copy mode 下吞掉了所有 paging 键。最可能的原因（按可能性排序）：

### 理论 1（**最可能**）：双 client attach 导致 pane redraw 失锁

后端为每个 session 起了一个 **`tmux -C attach-session`** 进程（`src/tmux/control_mode.rs:38-44`，v0.1.0 起就有，活动监控用）。加上 PTY 那一头的 tmux client，**同一 session 有 2 个 attach 客户端**。

- scrollback 更新事件可能只被 control mode client 看到，PTY client 端 pane 视图卡在"live content"
- PTY 写入的键被某个 client 抢占

**支持证据**：
- `pane_in_mode=1` 说明 session 级别进了 copy mode
- 但 `scroll_position=0` 不动 + 屏幕不重绘 → 视图同步断开
- `tmux send-keys`（走 server 命令通道，与 PTY client 无关）也不动 → 不仅是 PTY 层的输入竞争，而是 pane 视图状态本身卡死

**反证/削弱证据**：
- 双 client attach 在普通模式下工作正常（echo 命令能双向通信），仅 copy mode 出问题
- tmux 官方支持多 client attach，所以不一定是这个

### 理论 2：PTY terminal mode 未正确切到 raw，导致键被 line discipline 拦截

PTY 默认是 cooked mode（canonical + echo），tmux 通常会切 raw。如果切 raw 失败：
- `k` 会被 line buffer 拦住（无 newline）
- `\x02[` 的 0x02 (Ctrl+B) 是 INTR/QUIT 候选字符，可能被解释为信号

**反证**：
- 第一次 `prefix [` 成功进入 copy mode，说明 0x02 至少当时没被解释为信号
- 但 line discipline 状态可能随模式变化（copy mode 可能触发 VDSUSP 之类）

### 理论 3：`mouse on` 影响 copy mode 的键处理

后端 `src/tmux/mod.rs:76-78` 启用了 `set-option mouse on`。mouse-on 状态下，xterm.js 发送的 PageUp 可能被 tmux 解释为"滚轮事件"而不是"PgUp 键"。

**削弱证据**：WS 用的是 binary `\x1b[5~`，这是标准的 CSI 5 ~ PageUp 序列，tmux 的 mouse mode 不应拦截键盘序列。

## 排障过程已排除的方向

- ✅ **不是 `b950cf1`（IME 禁用）引入** — `git log` 显示 `af2b230`（2026-07-07）之前 PTY/tmux 集成就没变，scroll mode 修复只动 `sendScrollKeys` 状态机，不动 PTY 写入路径
- ✅ **不是 PTY 写入失败** — `tmux send-keys`（绕 PTY）也失败
- ✅ **不是 control mode 抢占输入** — control mode 进程只读 stdout，不消费 stdin
- ✅ **不是 WS binary frame 协议问题** — `write_pty` 用 `libc::write` 直写 fd，不做 frame 解析
- ✅ **不是 sendScrollKeys 状态机错误** — 屏幕 `pane_in_mode=1` 说明 prefix 正确进入 copy mode
- ✅ **不是终端 escape sequence 不对** — `\x1b[5~` 是 xterm 标准 PageUp，tmux 一定认识
- ✅ **不是 tmux 4 种 send 策略的问题** — 单发/分开发/带 delay/send-keys 都失败

## 建议修复路径

### 方案 1（**推荐**）：前端 → 后端 REST 端点 → `tmux send-keys`，绕开 PTY

**思路**：彻底放弃 PTY 这一路做 scroll paging。新增端点 `POST /api/v1/sessions/{id}/scroll`，body `{"direction":"up|down"}`，后端用 `tmux send-keys -t <name> -X copy-mode` 进 copy mode + `k`/`j` 滚动，或直接 `tmux send-keys -t <name> k`（前提是 copy mode 已进入）。

**改动**：

| 文件 | 改动 |
|---|---|
| `src/api/sessions.rs` | 新增 `POST /:id/scroll` 端点 + handler |
| `src/tmux/mod.rs` | 新增 `pub async fn scroll_session(name, dir)`，内部用 `tmux send-keys` |
| `frontend/src/api/client.ts` | 新增 `scrollSession(id, dir)` 方法 |
| `frontend/src/hooks/useTerminal.ts` | `sendScrollKeys` 改为：第一次仍用 WS（确保进入 copy mode 立即翻一页），后续调用 `scrollSession` REST |
| 文档 | 更新 `docs/architecture/backend.md` + `frontend.md` |

**优点**：
- 改动面小，全部在已知的"前端 <-> 后端"边界上
- 完全绕开故障的 PTY 层，最稳
- 不需要理解 PTY/copy mode 卡死的根因（节省调试时间）

**缺点**：
- 多一次 HTTP 往返（~5-10ms），但用户感觉得到吗？scroll 是手动操作，5ms 几乎无感
- 第一次进 copy mode + 第一次翻页仍走 PTY（保持现状），所以方案 1 不"完整"修好 PTY

**验收**：
- 移动端连按 ↑ 5 次，tmux `scroll_position` 从 0 递增到 5
- `pnpm test` 全过 + 现有 6 个 scroll mode 单测不破
- 桌面端无回归

### 方案 2：诊断并修 PTY copy mode 通路

**思路**：深挖 PTY/copy mode 卡死的根因。可能方向：
- 在 `pty_pair.master` 创建后立即 `tcsetattr` 强制 raw 模式
- 调查 `mouse on` + copy mode 交互
- 改用 `tmux server` 模式而非 client attach 模式

**风险**：诊断耗时不可控（已经花了 1 小时定位到这一层），可能牵扯进 tmux 内部行为或 terminal 驱动的暗坑。

**不建议作为优先方向**——除非方案 1 验证后发现有更严重问题。

### 方案 3：放弃 tmux copy mode，前端自己做 buffer 缓存

**思路**：前端 xterm 维护一份独立的 scrollback，scroll mode 时直接前端渲染，不动 tmux。

**缺点**：
- 改动大（要拦截 xterm 输出流、复制 buffer 状态）
- 与 tmux copy mode 的 select-and-copy 流程冲突（v0.1.0 已经依赖 tmux copy mode 做复制）
- 工作量估计 1-2 天

**不推荐**。

## 复现命令（一键验证）

```bash
# 启服务
./dev.sh start

# 跑 TEST 1+2（WS 路径 + send-keys 路径）
python3 /tmp/ws_test7.py

# 单独看 tmux 状态
tmux display-message -t lt_<session-uuid-prefix> \
  -p 'mode=#{pane_in_mode},pos=#{scroll_position},cur=#{copy_cursor_x},#{copy_cursor_y}'
```

## 相关 commit

- `af2b230` 2026-07-07 修过类似症状（"移动端滚动态被悄悄关闭导致上下键无法翻页"）——但只修了 `sendScrollKeys` 状态机，**没修 PTY 翻页通路**。这个 bug 一直存在，只是被那个 commit 部分掩盖了。
- `b950cf1` 2026-07-10（当前 HEAD 之前）— 加 IME 禁用，与本 bug 无关。

## 预防建议

1. PTY 集成层（`src/ws/terminal.rs` + `src/tmux/control_mode.rs`）应补充**集成测试**：连 WS → 发 `prefix [` + 多次 k → 断言 `scroll_position` 递增。这种 bug 只在端到端行为下出现，单测抓不到。
2. `tmux send-keys` 作为 fallback 通道值得保留——它绕开 PTY 那一路，是验证"PTY 层有没有坏"的金标准。
