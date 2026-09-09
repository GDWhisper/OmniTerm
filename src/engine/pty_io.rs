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

/// 从 tokio `Command` 移除 SSH 会话泄漏变量。
pub fn strip_ssh_leak_env_async(cmd: &mut tokio::process::Command) {
    for var in SSH_LEAK_ENV_VARS {
        cmd.env_remove(var);
    }
}

/// 从 portable_pty `CommandBuilder` 移除 SSH 会话泄漏变量。
pub fn strip_ssh_leak_env_builder(cmd: &mut portable_pty::CommandBuilder) {
    for var in SSH_LEAK_ENV_VARS {
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

    /// 两个 strip 函数（tokio Command / portable_pty builder）都要移除 SSH 泄漏
    /// 变量，且不影响其他显式设置的变量。
    #[tokio::test]
    async fn tokio_command_strips_ssh_leak_vars() {
        // env_clear 隔离父进程环境（本机测试进程可能自带 SSH_CONNECTION），
        // spawn `env` 验证子进程实际环境里没有泄漏变量。
        let mut cmd = tokio::process::Command::new("/usr/bin/env");
        cmd.env_clear();
        for var in SSH_LEAK_ENV_VARS {
            cmd.env(var, "leak");
        }
        cmd.env("OMNITERM_KEEP", "1");

        strip_ssh_leak_env_async(&mut cmd);

        let out = cmd.output().await.expect("env 应可执行");
        assert!(out.status.success());
        let lines: Vec<String> =
            String::from_utf8_lossy(&out.stdout).lines().map(String::from).collect();
        for var in SSH_LEAK_ENV_VARS {
            assert!(
                !lines.iter().any(|l| l.starts_with(&format!("{var}="))),
                "{var} 不应出现在 spawn 进程环境里"
            );
        }
        assert!(lines.iter().any(|l| l == "OMNITERM_KEEP=1"));
    }

    #[test]
    fn builder_strips_ssh_leak_vars() {
        let mut cmd = portable_pty::CommandBuilder::new("true");
        for var in SSH_LEAK_ENV_VARS {
            cmd.env(var, "leak");
        }
        cmd.env("OMNITERM_SESSION_ID", "s1");

        strip_ssh_leak_env_builder(&mut cmd);

        for var in SSH_LEAK_ENV_VARS {
            assert!(cmd.get_env(var).is_none(), "{var} 不应留在 CommandBuilder 环境里");
        }
        assert_eq!(cmd.get_env("OMNITERM_SESSION_ID"), Some(std::ffi::OsStr::new("s1")));
    }
}
