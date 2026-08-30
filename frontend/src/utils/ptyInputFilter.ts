/**
 * pty 会话的 onData 自动应答过滤器。
 *
 * eslint-disable no-control-regex：终端转义序列匹配必须使用控制字符（ESC/BEL），
 * 此为本文件的有意行为，非法则无法匹配任何应答形态。
 *
 * 背景（docs/dev/plans/backlog/pty-scroll-handover.md §零 核查点 4）：
 * pty 会话是"双终端模拟器"架构 —— 同一份 raw 输出同时喂给后端 alacritty VT
 * 和前端 xterm.js（仅连接初期的 raw 窗口期；cell_frame 模式下只喂后端）。
 * 查询类序列（设备属性/光标位置/颜色等）到达前端时，xterm.js 会经 onData
 * 自动应答并转发回 PTY。此时 tmux 已经消费了后端 VT 的应答（经
 * `vt.rs` ResponseSink 回写），前端的应答是**纯重复**；tmux 对迟到/多余的
 * 应答不作解析而直接透传给 pane 内 shell，经 PTY echo 回显 —— 症状即会话
 * 切换后屏幕冒出 `1;2c1;2c1;2c`（xterm.js 对 Primary DA 查询 `ESC[c` 的
 * 应答 `\x1b[?1;2c`，ESC 不可见）。
 *
 * 过滤范围（形态锚定整串匹配，均以下方出处为准）：
 *   - DA1 / DA2（设备属性）         —— alacritty identify_terminal 已应答
 *   - CPR / DECXCPR（光标位置）     —— alacritty device_status 已应答
 *   - DSR-OS（操作系统状态）        —— alacritty device_status(5) 已应答
 *   - DECRPM（模式报告）            —— alacritty DECRQM 已应答
 *   - XTWINOPS 窗口尺寸报告         —— 查询方罕见，重复应答无益
 *   - OSC 4/10/11/12 颜色应答       —— alacritty ColorRequest 已应答
 *
 * 明确**不过滤**（放行）：
 *   - 用户键盘输入的所有转义序列（方向键/功能键/修饰键等）—— 形态与上表不重叠
 *   - 鼠标协议上报（SGR `ESC[<p;x;yM` / X10 `ESC[M..`）—— 虽也走 onData 自动
 *     产生，但它是"应用等待的输入"而非身份应答，必须转发
 *   - DCS / DECRQSS 应答 —— 后端 alacritty 0.26 不实现 DECRQSS，前端应答是
 *     tmux 探测的唯一来源，过滤会造成探测超时降级
 *   - tmux / 外部会话整体不启用本过滤（useTerminal 按 runtimeKind 分流）——
 *     那里前端 xterm 是唯一终端模拟器，全部应答必需
 *
 * 形态出处（@xterm/xterm 6.0.0 src/common/InputHandler.ts）：
 *   DA1      sendDeviceAttributesPrimary      `ESC[?1;2c` / `ESC[?6c`
 *   DA2      sendDeviceAttributesSecondary    `ESC[>0;276;0c` 等（均为 `>p;p;pc`）
 *   DECRPM   reportPrivateMode                `ESC[?{m};{v}$y`
 *   DSR-OS   deviceStatus(5)                  `ESC[0n`
 *   CPR      reportCursorPosition             `ESC[{y};{x}R`
 *   DECXCPR  reportExtendedCursorPosition     `ESC[?{y};{x}R`
 *   窗口尺寸 reportWindowSize                 `ESC[8;{rows};{cols}t`
 *   OSC      requestStatusString / 颜色查询    `ESC]{body}ST|BEL`
 */

/* eslint-disable no-control-regex -- 终端转义序列匹配必须使用控制字符 */

const AUTO_RESPONSE_PATTERNS: RegExp[] = [
  /^\x1b\[\?(?:1;2|6)c$/,                              // DA1
  /^\x1b\[>\d+;\d+;\d+c$/,                             // DA2
  /^\x1b\[\?\d+;\d+\$y$/,                              // DECRPM
  /^\x1b\[0n$/,                                        // DSR-OS
  /^\x1b\[\d+;\d+R$/,                                  // CPR
  /^\x1b\[\?\d+;\d+R$/,                                // DECXCPR
  /^\x1b\[8;\d+;\d+t$/,                                // XTWINOPS size report
  /^\x1b\](?:4|1[0-2]);[^\x07\x1b]*(?:\x07|\x1b\\)$/,  // OSC palette/fg/bg answer
]

/**
 * 判断一段 onData 数据是否为 xterm.js 对终端查询的自动应答（而非用户输入）。
 * 命中 → 上层应丢弃，不转发 PTY。
 *
 * 依据 onData 的事件粒度：xterm.js 的自动应答每次单独触发一次 onData，
 * 不与用户输入合并，故"整串精确匹配"不会误伤合法输入。
 */
export function isTerminalAutoResponse(data: string): boolean {
  return AUTO_RESPONSE_PATTERNS.some((re) => re.test(data))
}
