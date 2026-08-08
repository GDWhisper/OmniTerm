# 已知未解问题与已排除方向

> 本文件存放**未完成诊断的调查状态**（症状 + 已排除方向 + 待查清单），目的是避免下次排查重复已排除的方向。
> 注意：未解问题不等于已修 bug——这里的记录没有产出结论，只有调查边界。产出结论后按领域迁入对应模式文件。

---

## tmux 终端「长期累积换行」— 已排除方向记录（未修复）

**症状**：
- tmux 终端里长期累积多余的换行——放着不动，过一会儿多出 1 行
- agent 输入框也总是会有换行
- **仅 desktop 出现**，mobile 不出现
- 项目初期就有，未修复

> 来自 pi session `019f13fc`（2026-06-29）的调查。session 被中断，未产出最终诊断，但已系统性排除一批方向。

### 已排除的方向

| 方向 | 排除依据 |
|------|---------|
| `a184961` 的 MasterWriter 修复不完整 | 10/10 顺序测试 + 20/20 并发测试全部 clean；`libc::write` 替代 `MasterWriter` 后不再有 `\n\x04` 泄漏；strace 验证通过 |
| `7a1bb25` 的 SIGHUP 顺序问题 | SIGHUP 先于 master drop 发送，清理路径正确 |
| 前端 `sendData` 注入 `\n` | `Terminal.tsx` 的 handleKey 只发 Ctrl/Esc/Tab/方向键，不发 `\n` |
| 前端 `sendScrollKeys` 注入 | 只发 `\x02[` (Ctrl+B [) 和方向键，无 `\n` |
| `xterm.writeln` 写入 PTY | `writeln` 的 `\r\n` 写入 xterm 内部 display buffer，不走 PTY |
| `Ctrl+Shift+X` handler | 只在用户显式触发时发 `'y\n'`，非持续源 |
| MobileKeyBar 的 Enter 键 | mobile 路径本就没 Enter，与 desktop-only 症状一致 |
| `master.resize()` 调用频率 | 确认 backend 收到 resize 就调，不检查 size 是否真的变了；但 `resize()` 只是 `ioctl(TIOCSWINSZ)`，不写字节到 PTY |

### 确认但不构成根因的发现

| 发现 | 细节 |
|------|------|
| React StrictMode 在 dev 模式启用 | `main.tsx` 确认 `<StrictMode>`；会导致 effects 运行两次（mount → cleanup → mount），在 dev 模式下 WS 快速断开/重连（log 中 4-5ms 间隔的 connect/disconnect 对） |
| Agent poll task 仅在有 hook 且 WS 打开时运行 | `terminal.rs:299` 的 `if hook_enabled` 守卫；不会为所有 session 创建 poll task |
| `useTerminal.ts` 有 StrictMode 双重注册防护 | `// Guard against duplicate registration` 注释存在，但实际防护是否完备未验证 |

### 待查方向（下次排查从这里开始）

1. **backend PTY writer 线程的写字节逻辑**（`terminal.rs:254-300`）：是否有未预期的 `\n` 写入路径
2. **`tmux new-session -A` 的 attach 行为**：新 client attach 时 tmux server 是否向 pane 写入 setting/restore 字节
3. **SIGHUP 清理路径**（`terminal.rs:450+`）：SIGHUP → master drop → fd 关闭的时序是否在所有竞态下安全
4. **xterm.js `term.onData` 在 StrictMode 下的行为**：dev 模式双挂载时 onData 回调是否重复注册，导致按键被双发
5. **"window 不动也出"的场景**：需要抓取 backend log 在 bug 出现时的完整事件序列（attach → idle → 换行出现的精确时刻）
6. **生产构建（非 dev）是否复现**：区分 React StrictMode 效应和真正 bug
