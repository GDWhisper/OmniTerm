//! macOS：`osascript` + `choose folder`。
//!
//! 起始目录经环境变量传入（AppleScript 的 `system attribute` 读取），不拼进
//! 脚本文本；用户取消（error -128）返回固定标记而非错误退出。

use std::ffi::OsString;
use std::path::Path;

use super::{
    CommandSpec, PICK_INITIAL_ENV, PickError, PickOutcome, PickerRun, failure_message, run_spec,
    selected_path_from_stdout,
};

const CANCELLED_MARKER: &str = "OMNITERM_CANCELLED";

const SCRIPT: &str = r#"on run
  set initialDir to system attribute "OMNITERM_PICK_INITIAL"
  try
    if initialDir is missing value or initialDir is "" then
      set chosen to choose folder with prompt "Select project directory"
    else
      set chosen to choose folder with prompt "Select project directory" default location (POSIX file initialDir)
    end if
    return POSIX path of chosen
  on error errMsg number errNum
    if errNum is -128 then
      return "OMNITERM_CANCELLED"
    end if
    error errMsg number errNum
  end try
end run"#;

pub(super) async fn pick(initial: Option<&Path>) -> Result<PickOutcome, PickError> {
    let program = which::which("osascript").map_err(|_| {
        PickError::Unsupported(
            "osascript not found; the native directory picker is unavailable".into(),
        )
    })?;

    let spec = CommandSpec {
        program,
        args: vec![OsString::from("-e"), OsString::from(SCRIPT)],
        env: vec![(
            PICK_INITIAL_ENV,
            initial.map(|path| path.as_os_str().to_owned()).unwrap_or_default(),
        )],
    };

    let run = run_spec(spec).await?;
    classify(run)
}

fn classify(run: PickerRun) -> Result<PickOutcome, PickError> {
    match run.code {
        Some(0) => {
            let text = String::from_utf8_lossy(&run.stdout);
            if text.trim_end_matches(&['\r', '\n'][..]) == CANCELLED_MARKER {
                Ok(PickOutcome::Cancelled)
            } else {
                Ok(PickOutcome::Selected(selected_path_from_stdout(&run.stdout)?))
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn script_reads_initial_dir_from_the_environment() {
        assert!(SCRIPT.contains(PICK_INITIAL_ENV));
        assert!(SCRIPT.contains("choose folder"));
        assert!(SCRIPT.contains("-128"));
    }

    #[test]
    fn cancellation_marker_is_not_an_error() {
        let mut stdout = CANCELLED_MARKER.as_bytes().to_vec();
        stdout.push(b'\n');
        let run = PickerRun { code: Some(0), stdout, stderr: Vec::new() };
        assert_eq!(classify(run).expect("cancel should not be an error"), PickOutcome::Cancelled);
    }

    #[test]
    fn trailing_slash_from_posix_path_is_accepted() {
        let dir = std::env::temp_dir();
        let mut stdout = format!("{}/", dir.display()).into_bytes();
        stdout.push(b'\n');
        let run = PickerRun { code: Some(0), stdout, stderr: Vec::new() };
        match classify(run).expect("temp dir should be selected") {
            PickOutcome::Selected(path) => {
                assert_eq!(path, PathBuf::from(format!("{}/", dir.display())))
            }
            PickOutcome::Cancelled => panic!("expected a selected directory"),
        }
    }

    #[test]
    fn osascript_error_is_reported() {
        let run = PickerRun {
            code: Some(1),
            stdout: Vec::new(),
            stderr: b"execution error: User canceled. (-128)".to_vec(),
        };
        assert!(
            matches!(classify(run), Err(PickError::Failed(message)) if message.contains("execution error"))
        );
    }
}
