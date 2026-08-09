//! Agent CLI 识别（引擎无关）：从命令行字符串识别受支持的 agent。

use crate::agent::state::AgentKind;

/// Detect the agent kind from a command string.
///
/// Extracts the basename (strips path, extensions like `.exe`/`.cmd`/`.bat`, and lowercases),
/// then matches against known agent CLIs.
pub fn detect_agent_kind(command: &str) -> Option<AgentKind> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return None;
    }

    let first_token = cmd.split_whitespace().next()?;

    let basename = first_token.rsplit(&['/', '\\'][..]).next().unwrap_or(first_token);

    let stripped = if let Some(s) = strip_ext(basename, ".exe")
        .or_else(|| strip_ext(basename, ".cmd"))
        .or_else(|| strip_ext(basename, ".bat"))
    {
        s
    } else {
        basename
    };

    match stripped.to_lowercase().as_str() {
        "claude" | "claude-code" => Some(AgentKind::Claude),
        "codex" => Some(AgentKind::Codex),
        "qoder" => Some(AgentKind::Qoder),
        "node" | "nodejs" => {
            let args = &cmd[first_token.len()..];
            detect_agent_in_node_args(args)
        }
        _ => None,
    }
}

/// Scan the arguments after `node`/`node.exe` for agent script path segments.
///
/// Matches paths like `C:\...\claude\bin\cli.js` or `/usr/lib/codex/index.js`
/// by checking if any path segment is a known agent name.
fn detect_agent_in_node_args(args: &str) -> Option<AgentKind> {
    for token in args.split_whitespace() {
        for segment in token.split(&['/', '\\'][..]) {
            let seg_lower = segment.to_lowercase();
            match seg_lower.as_str() {
                "claude" | "claude-code" => return Some(AgentKind::Claude),
                "codex" => return Some(AgentKind::Codex),
                "qoder" => return Some(AgentKind::Qoder),
                _ => {}
            }
        }
    }
    None
}

/// Case-insensitive extension stripping.
fn strip_ext<'a>(name: &'a str, ext: &str) -> Option<&'a str> {
    if name.len() > ext.len() && name[name.len() - ext.len()..].eq_ignore_ascii_case(ext) {
        Some(&name[..name.len() - ext.len()])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_claude() {
        assert_eq!(detect_agent_kind("claude"), Some(AgentKind::Claude));
        assert_eq!(
            detect_agent_kind("claude --dangerously-skip-permissions"),
            Some(AgentKind::Claude)
        );
    }

    #[test]
    fn test_detect_claude_code() {
        assert_eq!(detect_agent_kind("claude-code"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("claude-code --model haiku"), Some(AgentKind::Claude));
    }

    #[test]
    fn test_detect_codex() {
        assert_eq!(detect_agent_kind("codex"), Some(AgentKind::Codex));
        assert_eq!(detect_agent_kind("codex --help"), Some(AgentKind::Codex));
    }

    #[test]
    fn test_detect_case_insensitive() {
        assert_eq!(detect_agent_kind("Claude"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("CLAUDE"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("Codex"), Some(AgentKind::Codex));
    }

    #[test]
    fn test_detect_strip_extensions() {
        assert_eq!(detect_agent_kind("claude.exe"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("Claude.EXE"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("codex.cmd"), Some(AgentKind::Codex));
        assert_eq!(detect_agent_kind("claude.bat"), Some(AgentKind::Claude));
    }

    #[test]
    fn test_detect_full_path() {
        assert_eq!(detect_agent_kind("/usr/local/bin/claude"), Some(AgentKind::Claude));
        // Windows path — use a path without spaces (split_whitespace breaks on spaces)
        assert_eq!(detect_agent_kind("C:\\Claude\\claude.exe"), Some(AgentKind::Claude));
    }

    #[test]
    fn test_detect_non_agent() {
        assert_eq!(detect_agent_kind("bash"), None);
        assert_eq!(detect_agent_kind("zsh"), None);
        assert_eq!(detect_agent_kind("vim"), None);
        assert_eq!(detect_agent_kind(""), None);
        assert_eq!(detect_agent_kind("  "), None);
    }

    #[test]
    fn test_detect_qoder() {
        assert_eq!(detect_agent_kind("qoder"), Some(AgentKind::Qoder));
        assert_eq!(detect_agent_kind("qoder.exe"), Some(AgentKind::Qoder));
        assert_eq!(detect_agent_kind("C:\\Users\\x\\qoder.exe"), Some(AgentKind::Qoder));
    }

    #[test]
    fn test_detect_windows_negative_samples() {
        assert_eq!(detect_agent_kind("claudette.exe"), None);
        assert_eq!(detect_agent_kind("codextool.exe"), None);
        assert_eq!(detect_agent_kind("qodercli.exe"), None);
        assert_eq!(detect_agent_kind("C:\\Program Files\\claudette.exe"), None);
    }

    #[test]
    fn test_detect_node_wrapper_claude() {
        assert_eq!(
            detect_agent_kind("node C:\\Users\\x\\claude\\bin\\cli.js"),
            Some(AgentKind::Claude)
        );
        assert_eq!(
            detect_agent_kind("node.exe /usr/local/lib/claude/index.js"),
            Some(AgentKind::Claude)
        );
    }

    #[test]
    fn test_detect_node_wrapper_codex() {
        assert_eq!(
            detect_agent_kind("node C:\\tools\\codex\\bin\\main.js"),
            Some(AgentKind::Codex)
        );
    }

    #[test]
    fn test_detect_node_wrapper_non_agent() {
        assert_eq!(detect_agent_kind("node server.js"), None);
        assert_eq!(detect_agent_kind("node.exe app/index.js"), None);
    }
}
