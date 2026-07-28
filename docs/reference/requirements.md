# 需求清单

> 此文档仅在人工明确要求时更新，记录产品功能需求和待办事项。

**优先级说明：**
- 🔴 **高** — 近期重点实现
- 🟡 **中** — 正常排期
- 🔵 **低** — 锦上添花，不着急
- ⚪ **未明确** — 待讨论

---

## 快捷键设置 🟡

- [ ] **插件化快捷键模式** — 通过 tmux 插件生态（如 tmux-sensible, tmux-pain-control 等）实现快捷键定制，OmniTerm 提供 UI 开关和插件管理，不重复造轮子。底层拦截代码已就绪（appStore.keybindingMode + useTerminal handler），等插件系统就绪后激活。

## 改动记录 ⚪

- [ ] **新增改动记录栏** — 在界面中新增一个「改动记录」面板，记录本次会话中改动过的文件和新增的文件，按时间倒序排列，支持点击文件名直接打开文件预览。

## Sidebar 便条 🔵

- [ ] **收起 Sidebar 后显示快捷便条** — 当 Sidebar 收起时，为每个项目、工作区、会话生成小便条（图标/缩略图），方便用户一键展开对应内容。
  - ⚠️ 待打磨：交互形式、视觉样式、信息密度需要进一步设计

## 通知功能 ⚪

- [ ] **任务状态通知** — 当终端任务发生以下情况时，向用户发送通知：
  - 任务完成
  - 任务意外中断（异常退出）
  - 任务死循环（长时间无输出或 CPU 占用异常）
  - ⚠️ 待定：具体检测方式（轮询 tmux pane 状态 / hook / 资源监控）


## ACP 会话 ⚪

- [ ] **todos list 看板功能** — ACP 会话的 todos list 看板功能未成功实现，待评估：放弃该功能，或换用更高级模型处理。（2026-07-24 记录）

## Multiplexer 引擎 ⚪

- [ ] **rmux 双引擎支持** — 新增 rmux 作为 tmux 的替代 multiplexer 引擎，逐步过渡为主引擎，tmux 降级为 fallback。
  - 项目地址：https://github.com/Helvesec/rmux
  - 需要抽象出统一的引擎接口（trait），tmux 和 rmux 各自实现
  - 配置项切换引擎选择
  - 后续计划：rmux → 主引擎，tmux → fallback

## Windows 后台服务支持 ⚪

- [ ] **`--daemonize` / `stop` / `status` Windows 实现** — 目前 `start -d`、`stop`、`status` 在 Windows 上直接报错退出（`bail!` / `exit(1)`），需补齐。
  - **`--daemonize`**：调用 `FreeConsole()` 脱离控制台（一行 API，现有 `windows-sys` 已含 `Win32_System_Console`）
  - **`pid_exists`**：用 `OpenProcess` + `WaitForSingleObject(0)` 替代当前 `return false` stub
  - **`stop`**：用 `OpenProcess(PROCESS_TERMINATE)` → `TerminateProcess` 强杀（等价 Unix `SIGKILL`）；优雅退出需额外 IPC（named event），可后续迭代
  - **优雅退出**：daemonize 后无控制台，`ctrl_c()` 永不触发。如需要 ACP 子进程回收等清理逻辑，需用 named event `"omniterm-shutdown-{pid}"` 做关闭通知
  - 预估改动量 ~50 行，全在 `src/main.rs`，无新增依赖
