use std::io;

/// Write data to a PTY master.
///
/// On Unix, uses raw `libc::write` to avoid the `portable_pty::MasterWriter::drop`
/// bug that injects `\n\x04`. On Windows (ConPTY), uses `MasterWriter` directly
/// since the Unix tty-layer bug does not apply.
#[cfg(unix)]
pub fn write_pty(fd: i32, data: &[u8]) -> io::Result<usize> {
    let n = unsafe {
        libc::write(fd, data.as_ptr() as *const libc::c_void, data.len())
    };
    if n < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(n as usize)
    }
}

#[cfg(windows)]
pub fn write_pty(
    writer: &mut dyn io::Write,
    data: &[u8],
) -> io::Result<usize> {
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

#[cfg(windows)]
pub fn kill_session_process(pid: u32) {
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::System::Console::{
        GenerateConsoleCtrlEvent, CTRL_CLOSE_EVENT,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_TERMINATE,
    };

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
