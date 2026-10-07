use std::io;

/// SSH 会话泄漏变量：后端从 SSH 会话 daemon 化启动（dev.sh 于 SSH 登录内运行）时，
/// 进程树继承 `SSH_CLIENT`/`SSH_CONNECTION`/`SSH_TTY`，本模块 spawn 的所有子进程
/// （pty shell、tmux client、ACP 终端命令）会继续携带。部分 CLI 据此判定自己运行在
/// SSH 会话中并切换行为——实测 agy (1.1.27) 见**任一** `SSH_*` 变量即改用文件
/// token 存储而非 keyring（日志 `Using file-based token storage because SSH
/// session detected`；仅剩 SSH_CLIENT/SSH_TTY 也触发，2026-09-08 实验确认），
/// 导致同一机器的原生终端（无 SSH 变量）免验证、OmniTerm 终端却要重新登录。
/// OmniTerm 派生的都是**本机本地进程**，继承这些变量纯属启动链路残留，
/// 一律移除（2026-09-08 实测验证：见 internal 排查记录）。
pub const SSH_LEAK_ENV_VARS: [&str; 3] = ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"];

/// 父会话运行态指针泄漏变量：宿主进程树从 codebuddy 会话派生时（OmniTerm 后端在
/// codebuddy 终端里启动、或从这类 OmniTerm 派生的任何子进程/终端）会一路继承这些
/// 变量；新进程读到「父会话已占用的服务端口/内部服务 URL」后误当自己的配置：
///
/// - `SERVER__PORT` / `SERVER__HOST`：codebuddy 服务监听目标。新进程启动期直接
///   `listen` 继承来的端口，被父会话占用 → `EADDRINUSE` 未处理异常 → 启动流程
///   中断（2026-10-06 实测两种入口：`codebuddy --acp` 的 `session/new` 永久挂起
///   ——不清理 120s+ 无响应 / 只清此项 84ms 成功 / 反向注入被占端口 100% 复现；
///   `codebuddy` TUI 空白卡死——污染环境 18s 无渲染，干净环境对照正常渲染）。
/// - `CODEBUDDY_SERVICE_PROXY_URL`：指向父会话 hook 服务的内部 URL，不清则新
///   agent 的 hook 调用被错误路由到父会话。
/// - `CODEBUDDY_GATEWAY_AUTH`：网关认证材料，泄漏进派生进程是凭据扩散（安全面）。
///
/// 这四项与 codebuddy 自身 spawn 子进程时删除的清单一致（其 bundle `spawnInner`
/// 删 `SERVER__PORT`/`SERVER__HOST`/`CODEBUDDY_GATEWAY_AUTH`——对端承认这些不该
/// 传子进程，只是没覆盖「宿主继承」入向）。只清「会让新进程访问/占用父会话资源」
/// 的指针类变量；纯信息类（会话/请求 ID、telemetry BAGGAGE 等）暂无故障证据，
/// 暂不清——未来若发现同类故障再登记。
pub const SESSION_LEAK_ENV_VARS: [&str; 4] =
    ["SERVER__PORT", "SERVER__HOST", "CODEBUDDY_SERVICE_PROXY_URL", "CODEBUDDY_GATEWAY_AUTH"];

/// 全部启动链路泄漏变量（SSH 会话残留 + 父会话运行态指针）的单一真源。
/// 新增派生点清理、构造 `env -u` 命令串时一律以它为准（勿各自维护清单）。
pub fn startup_leak_env_vars() -> impl Iterator<Item = &'static str> {
    SSH_LEAK_ENV_VARS.into_iter().chain(SESSION_LEAK_ENV_VARS)
}

/// 从 tokio `Command` 移除全部启动链路泄漏变量。
pub fn strip_leak_env_async(cmd: &mut tokio::process::Command) {
    for var in startup_leak_env_vars() {
        cmd.env_remove(var);
    }
}

/// 从 portable_pty `CommandBuilder` 移除全部启动链路泄漏变量。
pub fn strip_leak_env_builder(cmd: &mut portable_pty::CommandBuilder) {
    for var in startup_leak_env_vars() {
        cmd.env_remove(var);
    }
}

/// Write data to a PTY master.
///
/// On Unix, uses raw `libc::write` to avoid the `portable_pty::MasterWriter::drop`
/// bug that injects `\n\x04`. On Windows (ConPTY), uses `MasterWriter` directly
/// since the Unix tty-layer bug does not apply.
#[cfg(unix)]
pub fn write_pty(fd: i32, data: &[u8]) -> io::Result<usize> {
    let n = unsafe { libc::write(fd, data.as_ptr() as *const libc::c_void, data.len()) };
    if n < 0 { Err(io::Error::last_os_error()) } else { Ok(n as usize) }
}

#[cfg(windows)]
pub fn write_pty(writer: &mut dyn io::Write, data: &[u8]) -> io::Result<usize> {
    writer.write(data)
}

/// Terminate a session process.
///
/// On Unix, sends `SIGHUP`. On Windows, attempts a console close event first,
/// then falls back to `TerminateProcess` after 500ms.
#[cfg(unix)]
pub fn kill_session_process(pid: u32) {
    unsafe {
        libc::kill(pid as i32, libc::SIGHUP);
    }
}

/// 进程是否仍存活（僵尸也算存活——未被收割前 pid 还在）。
/// EPERM 表示进程存在但无权限发信号，同样视为存活。
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// 三级进程清理（herdr `pane.rs:1176-1224` 模式）：
/// SIGHUP → 250ms 宽限 → SIGTERM → 250ms → SIGKILL，20ms 轮询提前退出。
/// 用于 PtyEngine 常驻会话的显式 kill；WS 断开不走这里（detach 语义）。
#[cfg(unix)]
pub fn kill_process_escalating(pid: u32) {
    const GRACE: std::time::Duration = std::time::Duration::from_millis(250);
    const POLL: std::time::Duration = std::time::Duration::from_millis(20);

    let wait_exit = |signal: i32| {
        unsafe { libc::kill(pid as i32, signal) };
        let deadline = std::time::Instant::now() + GRACE;
        while std::time::Instant::now() < deadline {
            if !pid_alive(pid) {
                return true;
            }
            std::thread::sleep(POLL);
        }
        !pid_alive(pid)
    };

    if wait_exit(libc::SIGHUP) {
        return;
    }
    if wait_exit(libc::SIGTERM) {
        return;
    }
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[cfg(windows)]
pub fn kill_session_process(pid: u32) {
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::System::Console::{CTRL_CLOSE_EVENT, GenerateConsoleCtrlEvent};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};

    unsafe {
        let _ = GenerateConsoleCtrlEvent(CTRL_CLOSE_EVENT, 0);
    }

    thread::sleep(Duration::from_millis(500));

    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            let _ = TerminateProcess(handle, 1);
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
    }
}

/// Windows（ConPTY）无 unix 式三级信号升级；`kill_session_process`
/// 已是 CTRL_CLOSE + TerminateProcess 两级，直接复用。
#[cfg(windows)]
pub fn kill_process_escalating(pid: u32) {
    kill_session_process(pid);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 清单内容 pin：泄漏变量集合的增删都必须是有意为之（每项对应一个实证
    /// 故障面，理由见各常量文档注释），此断言让「无声改清单」在测试期转红。
    #[test]
    fn leak_env_var_lists_are_pinned() {
        assert_eq!(SSH_LEAK_ENV_VARS, ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"]);
        assert_eq!(
            SESSION_LEAK_ENV_VARS,
            [
                "SERVER__PORT",
                "SERVER__HOST",
                "CODEBUDDY_SERVICE_PROXY_URL",
                "CODEBUDDY_GATEWAY_AUTH"
            ]
        );
    }

    /// 两个 strip 函数（tokio Command / portable_pty builder）都要移除全部启动
    /// 链路泄漏变量（SSH 会话残留 + 父会话运行态指针），且不影响其他显式设置的
    /// 变量。
    #[tokio::test]
    async fn tokio_command_strips_leak_vars() {
        // env_clear 隔离父进程环境（本机测试进程可能自带 SSH_CONNECTION），
        // spawn `env` 验证子进程实际环境里没有泄漏变量。
        let mut cmd = tokio::process::Command::new("/usr/bin/env");
        cmd.env_clear();
        for var in startup_leak_env_vars() {
            cmd.env(var, "leak");
        }
        cmd.env("OMNITERM_KEEP", "1");

        strip_leak_env_async(&mut cmd);

        let out = cmd.output().await.expect("env 应可执行");
        assert!(out.status.success());
        let lines: Vec<String> =
            String::from_utf8_lossy(&out.stdout).lines().map(String::from).collect();
        for var in startup_leak_env_vars() {
            assert!(
                !lines.iter().any(|l| l.starts_with(&format!("{var}="))),
                "{var} 不应出现在 spawn 进程环境里"
            );
        }
        assert!(lines.iter().any(|l| l == "OMNITERM_KEEP=1"));
    }

    #[test]
    fn builder_strips_leak_vars() {
        let mut cmd = portable_pty::CommandBuilder::new("true");
        for var in startup_leak_env_vars() {
            cmd.env(var, "leak");
        }
        cmd.env("OMNITERM_SESSION_ID", "s1");

        strip_leak_env_builder(&mut cmd);

        for var in startup_leak_env_vars() {
            assert!(cmd.get_env(var).is_none(), "{var} 不应留在 CommandBuilder 环境里");
        }
        assert_eq!(cmd.get_env("OMNITERM_SESSION_ID"), Some(std::ffi::OsStr::new("s1")));
    }
}
