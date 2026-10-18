//! 系统原生目录选择器（Windows / macOS / Linux）。
//!
//! 浏览器无法把用户选中的目录绝对路径暴露给 JS（`showDirectoryPicker` 只返回
//! 句柄），所以「新建项目 → 项目路径」的图形化选择必须由后端在 **运行 OmniTerm
//! 的机器** 上调起系统对话框。该能力天然只对本机访问有意义：远程访问时对话框
//! 会开在服务器上，调用方（`src/api/system.rs`）用 `is_local_request` 拦截。
//!
//! 平台实现：
//! - Windows：PowerShell + `System.Windows.Forms.FolderBrowserDialog`（`-STA`）
//! - macOS：`osascript` + `choose folder`
//! - Linux：`zenity` 或 `kdialog`（需要图形会话）
//!
//! # 有界性（`docs/dev/performance-and-safety.md` §P1）
//!
//! 子进程输出不经 `Command::output()` 全量收集：stdout/stderr 分别以
//! [`MAX_STDOUT_BYTES`] / [`MAX_STDERR_BYTES`] 封顶，超限即杀进程报错。整个
//! 调用受 [`PICK_TIMEOUT`] 约束，子进程带 `kill_on_drop`，浏览器断开或取消时
//! 随 future 一起终止（对话框随之关闭）。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

/// 同一时刻只允许一个原生对话框（多标签页/并发点击会叠加系统窗口）。
pub(crate) static PICK_LOCK: Mutex<()> = Mutex::const_new(());

/// 用户迟迟不操作时的上限；超时后杀掉子进程并返回 504。
pub(crate) const PICK_TIMEOUT: Duration = Duration::from_secs(600);
/// Windows 长路径（UTF-16 最长 32767）按 UTF-8 输出的最坏体积仍小于该值。
pub(crate) const MAX_STDOUT_BYTES: usize = 128 * 1024;
pub(crate) const MAX_STDERR_BYTES: usize = 4 * 1024;
/// `initial_dir` 只用于对话框起始位置；超长请求直接忽略，不进环境变量/命令行。
pub(crate) const MAX_INITIAL_DIR_BYTES: usize = 8 * 1024;

/// 起始目录环境变量名（Windows PowerShell / macOS AppleScript 共用）。
#[cfg(any(target_os = "windows", target_os = "macos"))]
pub(crate) const PICK_INITIAL_ENV: &str = "OMNITERM_PICK_INITIAL";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PickOutcome {
    Selected(PathBuf),
    Cancelled,
}

#[derive(Debug)]
pub(crate) enum PickError {
    /// 平台/桌面环境缺少可用的选择器（或本机无图形会话）。
    Unsupported(String),
    /// 子进程启动/读取/退出异常，或返回的路径不合法。
    Failed(String),
    TimedOut,
}

pub(crate) struct CommandSpec {
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<OsString>,
    pub(crate) env: Vec<(&'static str, OsString)>,
}

pub(crate) struct PickerRun {
    pub(crate) code: Option<i32>,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

/// 调起原生目录选择器。`initial` 不存在时回溯到最近存在的祖先目录。
pub(crate) async fn pick_directory(initial: Option<&Path>) -> Result<PickOutcome, PickError> {
    let initial = initial
        .filter(|path| path.as_os_str().to_string_lossy().len() <= MAX_INITIAL_DIR_BYTES)
        .and_then(|path| usable_initial_dir(Some(path)));

    let future = async {
        #[cfg(target_os = "windows")]
        {
            windows::pick(initial.as_deref()).await
        }
        #[cfg(target_os = "macos")]
        {
            macos::pick(initial.as_deref()).await
        }
        #[cfg(target_os = "linux")]
        {
            linux::pick(initial.as_deref()).await
        }
        #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
        {
            let _ = initial;
            Err(PickError::Unsupported(format!(
                "native directory picker is not supported on {}",
                std::env::consts::OS
            )))
        }
    };

    match tokio::time::timeout(PICK_TIMEOUT, future).await {
        Ok(result) => result,
        Err(_) => Err(PickError::TimedOut),
    }
}

/// 首个存在的祖先目录（含自身）。纯函数，便于单测。
fn usable_initial_dir(initial: Option<&Path>) -> Option<PathBuf> {
    initial?.ancestors().find(|p| p.is_dir()).map(Path::to_path_buf)
}

/// 子进程输出的路径：必须是绝对路径、存在且为目录、严格 UTF-8。
///
/// 只剥离行尾 `\r`/`\n`，不做 blanket-trim——Unix 目录名允许首尾空格。
fn selected_path_from_stdout(stdout: &[u8]) -> Result<PathBuf, PickError> {
    let text = std::str::from_utf8(stdout).map_err(|_| {
        PickError::Failed("the native picker returned a path that is not valid UTF-8".into())
    })?;
    let cleaned = text.trim_end_matches(&['\r', '\n'][..]);
    if cleaned.is_empty() {
        return Err(PickError::Failed("the native picker returned an empty path".into()));
    }
    let path = PathBuf::from(cleaned);
    if !path.is_absolute() {
        return Err(PickError::Failed(format!(
            "the native picker returned a relative path: {cleaned}"
        )));
    }
    if !path.is_dir() {
        return Err(PickError::Failed(format!("the selected path is not a directory: {cleaned}")));
    }
    Ok(path)
}

/// 统一的失败文案：把已封顶的 stderr 尾部附在原因后。
pub(super) fn failure_message(reason: &str, stderr: &[u8]) -> String {
    let detail = String::from_utf8_lossy(stderr);
    let detail = detail.trim();
    if detail.is_empty() { reason.to_string() } else { format!("{reason}: {detail}") }
}

/// 有界读取：最多读取 `cap + 1` 字节，让调用方据此判断是否超限。
async fn read_capped<R: AsyncRead + Unpin>(reader: R, cap: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    reader.take(cap as u64 + 1).read_to_end(&mut buf).await?;
    Ok(buf)
}

/// 启动子进程并在有界输出/超时保护下等待结束。
pub(crate) async fn run_spec(spec: CommandSpec) -> Result<PickerRun, PickError> {
    let mut cmd = tokio::process::Command::new(&spec.program);
    cmd.args(&spec.args)
        .envs(spec.env.iter().map(|(key, value)| (*key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| {
        PickError::Failed(format!("failed to start {}: {e}", spec.program.display()))
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| PickError::Failed("native picker stdout is unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| PickError::Failed("native picker stderr is unavailable".into()))?;

    // 并发读取两条管道，避免任一管道写满导致子进程阻塞。
    let (stdout_result, stderr_result) =
        tokio::join!(read_capped(stdout, MAX_STDOUT_BYTES), read_capped(stderr, MAX_STDERR_BYTES));
    let stdout = stdout_result
        .map_err(|e| PickError::Failed(format!("failed to read native picker stdout: {e}")))?;
    let stderr = stderr_result
        .map_err(|e| PickError::Failed(format!("failed to read native picker stderr: {e}")))?;

    if stdout.len() > MAX_STDOUT_BYTES || stderr.len() > MAX_STDERR_BYTES {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(PickError::Failed("the native picker output exceeded the safety limit".into()));
    }

    let status = child
        .wait()
        .await
        .map_err(|e| PickError::Failed(format!("failed to wait for native picker: {e}")))?;
    Ok(PickerRun { code: status.code(), stdout, stderr })
}

/// `-EncodedCommand` 需要 UTF-16LE 的 base64；只用于固定的 PowerShell 脚本，
/// 项目不为此引入新的 base64 依赖。
#[cfg(any(target_os = "windows", test))]
fn base64_utf16le(text: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = text.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let combined = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((combined >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((combined >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((combined >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 { TABLE[(combined & 0x3f) as usize] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_utf16le_matches_known_vectors() {
        assert_eq!(base64_utf16le(""), "");
        // UTF-16LE "A" = 41 00 → QQA=
        assert_eq!(base64_utf16le("A"), "QQA=");
        // UTF-16LE "AB" = 41 00 42 00 → QQBCAA==
        assert_eq!(base64_utf16le("AB"), "QQBCAA==");
        // UTF-16LE "ABC" = 41 00 42 00 43 00 → QQBCAEMA
        assert_eq!(base64_utf16le("ABC"), "QQBCAEMA");
    }

    #[test]
    fn usable_initial_dir_walks_up_to_existing_ancestor() {
        let base = std::env::temp_dir();
        assert!(base.is_dir());
        let missing = base.join("omniterm-picker-does-not-exist");
        assert_eq!(usable_initial_dir(Some(&missing)), Some(base.clone()));
        assert_eq!(usable_initial_dir(Some(&base)), Some(base));
        assert_eq!(usable_initial_dir(None), None);
    }

    #[test]
    fn selected_path_accepts_absolute_directory_and_strips_line_endings() {
        let dir = std::env::temp_dir();
        let mut raw = dir.to_string_lossy().into_owned().into_bytes();
        raw.extend_from_slice(b"\r\n");
        let parsed = selected_path_from_stdout(&raw).expect("temp dir should be accepted");
        assert_eq!(parsed, dir);
    }

    #[test]
    fn selected_path_rejects_relative_empty_and_non_utf8() {
        assert!(selected_path_from_stdout(b"relative/path").is_err());
        assert!(selected_path_from_stdout(b"").is_err());
        assert!(selected_path_from_stdout(b"/definitely/not/a/real/dir/omniterm").is_err());
        assert!(selected_path_from_stdout(&[0xff, 0xfe]).is_err());
    }

    #[tokio::test]
    async fn read_capped_reads_at_most_cap_plus_one() {
        let data = b"0123456789";
        let out = read_capped(&data[..], 4).await.expect("in-memory read should succeed");
        assert_eq!(out, b"01234");
    }
}
