use std::io;

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
