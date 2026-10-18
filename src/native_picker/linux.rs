//! Linux：zenity（GNOME）或 kdialog（KDE）。
//!
//! 需要一个可用的图形会话（`DISPLAY` 或 `WAYLAND_DISPLAY`）。工具本身存在但
//! X/Wayland 连接失败时，错误会带着 stderr 尾部返回，由前端 toast 呈现。

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::{
    CommandSpec, PickError, PickOutcome, PickerRun, failure_message, run_spec,
    selected_path_from_stdout,
};

const TITLE: &str = "Select project directory";

pub(super) async fn pick(initial: Option<&Path>) -> Result<PickOutcome, PickError> {
    if !graphical_session() {
        return Err(PickError::Unsupported(
            "no graphical session (DISPLAY/WAYLAND_DISPLAY is unset); use the directory browser in the dialog instead"
                .into(),
        ));
    }

    let tool = match which::which("zenity") {
        Ok(program) => Tool::Zenity(program),
        Err(_) => match which::which("kdialog") {
            Ok(program) => Tool::Kdialog(program),
            Err(_) => {
                return Err(PickError::Unsupported(
                    "no native folder picker found; install zenity (GNOME) or kdialog (KDE), or use the directory browser in the dialog"
                        .into(),
                ));
            }
        },
    };

    let run = run_spec(command_spec(&tool, initial)).await?;
    classify(run)
}

enum Tool {
    Zenity(PathBuf),
    Kdialog(PathBuf),
}

fn graphical_session() -> bool {
    ["DISPLAY", "WAYLAND_DISPLAY"]
        .iter()
        .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()))
}

fn command_spec(tool: &Tool, initial: Option<&Path>) -> CommandSpec {
    match tool {
        Tool::Zenity(program) => {
            let mut args: Vec<OsString> = vec![
                "--file-selection".into(),
                "--directory".into(),
                format!("--title={TITLE}").into(),
            ];
            if let Some(dir) = initial {
                // zenity 的尾斜杠表示「进入该目录」，而不是「选中它」。
                let mut arg = OsString::from("--filename=");
                arg.push(dir.as_os_str());
                arg.push("/");
                args.push(arg);
            }
            CommandSpec { program: program.clone(), args, env: Vec::new() }
        }
        Tool::Kdialog(program) => {
            let mut args: Vec<OsString> =
                vec!["--title".into(), TITLE.into(), "--getexistingdirectory".into()];
            if let Some(dir) = initial {
                // kdialog 的起始目录是 `--getexistingdirectory` 的位置参数。
                args.push(dir.as_os_str().to_owned());
            }
            CommandSpec { program: program.clone(), args, env: Vec::new() }
        }
    }
}

fn classify(run: PickerRun) -> Result<PickOutcome, PickError> {
    match run.code {
        Some(0) => Ok(PickOutcome::Selected(selected_path_from_stdout(&run.stdout)?)),
        Some(1) if stdout_blank(&run.stdout) => {
            if !run.stderr.is_empty() {
                tracing::debug!(
                    stderr = %String::from_utf8_lossy(&run.stderr),
                    "native directory picker cancelled"
                );
            }
            Ok(PickOutcome::Cancelled)
        }
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

fn stdout_blank(stdout: &[u8]) -> bool {
    stdout.iter().all(|byte| matches!(byte, b'\r' | b'\n'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zenity_uses_directory_mode_and_trailing_slash_for_initial_dir() {
        let tool = Tool::Zenity(PathBuf::from("/usr/bin/zenity"));
        let spec = command_spec(&tool, Some(Path::new("/tmp/start")));
        let args: Vec<String> =
            spec.args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert!(args.iter().any(|arg| arg == "--file-selection"));
        assert!(args.iter().any(|arg| arg == "--directory"));
        assert!(args.iter().any(|arg| arg == "--filename=/tmp/start/"));
    }

    #[test]
    fn kdialog_uses_positional_initial_dir() {
        let tool = Tool::Kdialog(PathBuf::from("/usr/bin/kdialog"));
        let spec = command_spec(&tool, Some(Path::new("/tmp/start")));
        let args: Vec<String> =
            spec.args.iter().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(args, vec!["--title", TITLE, "--getexistingdirectory", "/tmp/start"]);
    }

    #[test]
    fn code_one_with_blank_stdout_is_cancelled() {
        let run = PickerRun {
            code: Some(1),
            stdout: b"\n".to_vec(),
            stderr: b"Gtk-WARNING: noisy but harmless".to_vec(),
        };
        assert_eq!(classify(run).expect("cancel should not be an error"), PickOutcome::Cancelled);
    }

    #[test]
    fn code_zero_returns_the_selected_directory() {
        let dir = std::env::temp_dir();
        let mut stdout = dir.to_string_lossy().into_owned().into_bytes();
        stdout.push(b'\n');
        let run = PickerRun { code: Some(0), stdout, stderr: Vec::new() };
        match classify(run).expect("temp dir should be selected") {
            PickOutcome::Selected(path) => assert_eq!(path, dir),
            PickOutcome::Cancelled => panic!("expected a selected directory"),
        }
    }

    #[test]
    fn non_zero_non_cancel_is_an_error() {
        let run = PickerRun { code: Some(5), stdout: Vec::new(), stderr: b"timed out".to_vec() };
        assert!(
            matches!(classify(run), Err(PickError::Failed(message)) if message.contains("timed out"))
        );
    }
}
