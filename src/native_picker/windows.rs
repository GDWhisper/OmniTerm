//! Windows：PowerShell + `System.Windows.Forms.FolderBrowserDialog`。
//!
//! 用 `-EncodedCommand`（UTF-16LE base64）传入固定脚本，避免 `-Command` 的二次
//! 命令行解析/引号陷阱；起始目录经环境变量传入，不拼进脚本。输出路径以 UTF-8
//! 字节直接写 stdout，绕开 PowerShell 的 OEM 代码页（中文用户名/路径必需）。

use std::ffi::OsString;
use std::path::Path;

use super::{
    CommandSpec, PICK_INITIAL_ENV, PickError, PickOutcome, PickerRun, base64_utf16le,
    failure_message, run_spec, selected_path_from_stdout,
};

/// 对话框取消时的退出码。刻意不用 1：PowerShell 未捕获异常也以 1 退出，
/// 两者混在一起会把脚本错误误判成「用户取消」。
const EXIT_CANCELLED: i32 = 10;

const SCRIPT: &str = r#"$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Select project directory'
  $dialog.ShowNewFolderButton = $true
  $initial = $env:OMNITERM_PICK_INITIAL
  if ($initial -and (Test-Path -LiteralPath $initial -PathType Container)) {
    $dialog.SelectedPath = $initial
  }
  $result = $dialog.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 10 }
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}"#;

pub(super) async fn pick(initial: Option<&Path>) -> Result<PickOutcome, PickError> {
    let program = which::which("powershell").or_else(|_| which::which("pwsh")).map_err(|_| {
        PickError::Unsupported(
            "PowerShell not found; the native directory picker is unavailable".into(),
        )
    })?;

    let spec = command_spec(program, initial);
    let run = run_spec(spec).await?;
    classify(run)
}

fn command_spec(program: std::path::PathBuf, initial: Option<&Path>) -> CommandSpec {
    let encoded = base64_utf16le(SCRIPT);
    CommandSpec {
        program,
        args: vec![
            OsString::from("-NoLogo"),
            OsString::from("-NoProfile"),
            OsString::from("-NonInteractive"),
            // WinForms 对话框要求 STA；非 STA 会抛 ThreadStateException。
            OsString::from("-STA"),
            OsString::from("-EncodedCommand"),
            OsString::from(encoded),
        ],
        env: vec![(
            PICK_INITIAL_ENV,
            initial.map(|path| path.as_os_str().to_owned()).unwrap_or_default(),
        )],
    }
}

fn classify(run: PickerRun) -> Result<PickOutcome, PickError> {
    match run.code {
        Some(0) => Ok(PickOutcome::Selected(selected_path_from_stdout(&run.stdout)?)),
        Some(EXIT_CANCELLED) => Ok(PickOutcome::Cancelled),
        Some(code) => Err(PickError::Failed(failure_message(
            &format!("folder picker exited with code {code}"),
            &run.stderr,
        ))),
        None => Err(PickError::Failed(failure_message(
            "folder picker was terminated by a signal",
            &run.stderr,
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn script_uses_the_shared_env_var_and_cancel_exit_code() {
        assert!(SCRIPT.contains(PICK_INITIAL_ENV));
        assert!(SCRIPT.contains("FolderBrowserDialog"));
        assert!(SCRIPT.contains(&format!("exit {EXIT_CANCELLED}")));
    }

    #[test]
    fn command_spec_is_sta_and_uses_encoded_command() {
        let spec = command_spec(
            PathBuf::from("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
            Some(Path::new("C:\\work")),
        );
        let args: Vec<String> =
            spec.args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert!(args.iter().any(|arg| arg == "-STA"));
        assert!(args.iter().any(|arg| arg == "-EncodedCommand"));
        assert_eq!(
            spec.env[0].1,
            OsString::from("C:\\work"),
            "initial dir must travel via env, never inside the script"
        );
    }

    #[test]
    fn cancel_exit_code_is_not_an_error() {
        let run = PickerRun { code: Some(EXIT_CANCELLED), stdout: Vec::new(), stderr: Vec::new() };
        assert_eq!(classify(run).expect("cancel should not be an error"), PickOutcome::Cancelled);
    }

    #[test]
    fn script_error_is_not_mistaken_for_cancel() {
        let run = PickerRun {
            code: Some(1),
            stdout: Vec::new(),
            stderr: b"Exception calling ShowDialog".to_vec(),
        };
        assert!(
            matches!(classify(run), Err(PickError::Failed(message)) if message.contains("ShowDialog"))
        );
    }
}
