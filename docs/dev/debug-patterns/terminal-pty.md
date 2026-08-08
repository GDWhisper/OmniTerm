# 终端与 PTY — 调试模式

覆盖：MasterWriter Drop 副作用、字节能到达≠语义能到达、跨进程分隔符选型、平替实现边缘语法、FitAddon 桌面像素常量、escape-time 时序矩阵。

---

## 模式 1：第三方库 Drop 隐式副作用（PTY 变体）

**终端-Drop**：`portable_pty::MasterWriter::Drop` 会在 drop 时往 PTY fd 写 `\n + VEOF(0x04)`，raw mode 的 agent 收到 EOF 中断任务。writer fd 是 dup 出来的独立 fd，drop master 不失效。**从源头避免副作用**：不创建会 drop 时写 fd 的对象，用 `master.as_raw_fd()` 直接 `libc::write`，master drop 后 write 返 EBADF 自然退出。

**适用**：任何经 PTY 的进程清理路径；改清理逻辑先看库源码 Drop 实现。

**案例证据**：
- 2026-06-28 切换/删除会话时 agent 任务被中断（"像被 Ctrl+C"），strace 证实 drop 写 `\n\x04`，10 次 ~4 次复现。修复：不用 take_writer，writer 线程裸 fd 写。
- 2026-06-23 早期同根因：切换会话 TUI 多一行 + opencode 断联，drop 前显式 SIGHUP 的修复不充分。

---

## 模式 2：字节能到达 ≠ 语义能到达（时序分帧）

**终端-时序**：终端复用器（tmux/psmux）对字节流做时序敏感重新分帧：孤立 `\x1b` 等待 `escape-time`（默认 500ms）区分 Alt/功能键，两个 `\x1b` 合并成 `\x1b\x1b` 一次转发，对 TUI 是完全不同的键。**「延迟 + 无反馈」会诱导用户行为落入故障窗口**：单次 ESC 延迟 500ms 本身只是慢，但诱导快速重按恰好触发合并。对协议软件测「时序矩阵」（单发/窗口内连发/窗口外连发），字节级实测到达分组。

**适用**：经 tmux 的托管终端按键问题；所有把 tmux 当基础设施的产品应设 `escape-time` 0–50ms。

**案例证据**：
- 2026-07-26 opencode 无法中止任务（需连按两次 ESC）。raw-mode 字节记录器实测：100ms 间隔双 ESC 到达 pane 为单次 `\x1b\x1b`。修复：spawn client 时 `set-option -s escape-time 10`。

---

## 模式 3：跨进程文本协议的分隔符选型必须先验证中间层不改写

**终端-分隔符**：tmux `-F` 格式串里的**非打印字节**不原样输出，而是转成字面八进制文本（`\x1f` 变 `\037`）。选分隔符稳妥顺序：领域内被禁止出现的可打印字符（tmux session 名禁 `:`、路径禁 `\0`）> 控制字符（需逐层验证）。「程序读到的」与「人眼看到的」在含转义序列的输出里完全不同——验证输出用 `xxd`/`od -c` 看字节，不肉眼看渲染。

**适用**：任何经 shell/终端复用器/日志管道的文本协议分隔符；「我发的 X 为什么收到的不是 X」类问题第一步原样捕获对端输出。

**案例证据**：
- 2026-07-26 agent_watch 用 `\x1f` 做分隔符，Rust split 后 `parts.len()==1` 解析 0 个 pane。修复：改 `:` 分隔（session 名禁 `:`）+ 自由文本字段放末段 `splitn` 兜住。

---

## 模式 4：平替实现只保证主路径兼容，边缘语法是断裂带

**终端-平替**：drop-in replacement（psmux/busybox/mawk）对核心子命令兼容度高，但链式命令、引号展开、隐式默认值这类「语法胶水」最容易分岔。对平替实现只用最简单的单命令调用，复合需求拆成多次调用。**「退出码 0 + 无输出」是「命令被理解成另一种模式」的特征签名**（崩溃会非零退出，exit 0 说明程序认为自己的工作做完了——只是和你以为的不是同一件）。诊断交互式程序必须复制真实运行环境（TTY/ConPTY）——管道下 `isatty` 检测切换行为完全不同；目标程序发终端探针（DSR/DA）时诊断工具要扮演终端回复它。

**适用**：Windows 平替 tmux/psmux；任何「换了个实现行为就变」的场景。

**案例证据**：
- 2026-07-29 psmux 遇 `;` 链式命令进入一次性命令模式执行完 exit 0 不 attach → Windows 终端只剩 "attached" 提示无 shell。修复：按平台 cfg 拆分，windows 只跑纯 `new-session -A`，escape-time 单独一次性设置。

---

## 模式 5：第三方库的「桌面环境」像素常量假设在移动端失效

**终端-像素**：xterm FitAddon 固定预留 `DEFAULT_SCROLL_BAR_WIDTH=14px` 滚动条宽，且取容器 border-box 未扣 padding。触摸设备滚动条是 overlay（宽 0）→ 内容网格比容器右缘少 ~11px，黑色背景透出成「黑条」。**凡第三方库有桌面环境像素常量假设（滚动条宽/字体度量/光标形状），移动端视觉异常先 grep 库源码里的常量，再怀疑自己布局**。字体「测量宽度」与「渲染宽度」亚像素偏差在行尾累积成截断：最后一列溢出量 = 字形宽 − 测量 cellW（与列数无关），`.xterm-screen` 比 `cols × cellW` 略宽即有缓冲。移动端修复必须按比例/按运行时测量自适应（安全余量用 cellW 比例而非固定 px），CSS 相对单位覆盖 inline 像素宽。

**适用**：移动端终端渲染、任何第三方 UI 库的尺寸计算；「被遮挡/截断」先区分内容被裁 vs 内容没延伸到那里（量内容元素 vs 容器元素几何差）。

**案例证据**：
- 2026-08-04 移动端 tmux 右侧黑条（screen 367px vs viewport 378px，gap 11px）+ 行尾字符截断（余量 0.6px，临界视口宽度溢出被裁）。修复：覆盖 `fit.proposeDimensions` 按 clientWidth − padding 取整列数并预留 `0.13 × cellW` 余量 + 移动端隐藏原生滚动条 + `.xterm-screen`/行 div `width:100%` 并取消行 div `overflow: hidden`。
