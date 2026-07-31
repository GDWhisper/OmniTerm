/// Built-in agent presets for first-run experience.
///
/// On startup, OmniTerm checks whether each preset's `command` is findable on
/// PATH (via `which` on Unix / `where` on Windows). Only commands that are
/// actually installed are inserted into the `agents` table (INSERT OR IGNORE
/// keeps subsequent re-runs idempotent and preserves user edits).
///
/// The same preset data is mirrored in `frontend/src/components/Settings/presets.ts`
/// so Settings can render "fill-in" buttons for users who deleted a preset and
/// want to restore it (or added a previously-missing CLI later).
use sqlx::SqlitePool;
use std::process::Command;

struct AgentPreset {
    id: &'static str,
    display_name: &'static str,
    command: &'static str,
    args_json: &'static str,
}

const BUILTIN_PRESETS: &[AgentPreset] = &[
    AgentPreset {
        id: "preset-claude",
        display_name: "Claude Code",
        command: "claude-agent-acp",
        args_json: "[]",
    },
    AgentPreset {
        id: "preset-codex",
        display_name: "Codex",
        command: "codex-acp",
        args_json: "[]",
    },
    AgentPreset {
        id: "preset-gemini",
        display_name: "Gemini CLI",
        command: "gemini",
        args_json: r#"["--experimental-acp"]"#,
    },
    AgentPreset {
        id: "preset-opencode",
        display_name: "OpenCode",
        command: "opencode",
        args_json: r#"["acp"]"#,
    },
    AgentPreset {
        id: "preset-qwen",
        display_name: "Qwen Code",
        command: "qwen",
        args_json: r#"["--experimental-acp"]"#,
    },
    AgentPreset {
        id: "preset-kiro",
        display_name: "Kiro",
        command: "kiro-cli",
        args_json: r#"["acp"]"#,
    },
    AgentPreset {
        id: "preset-qoder",
        display_name: "qoder",
        command: "qodercli",
        args_json: r#"["--acp"]"#,
    },
    AgentPreset {
        id: "preset-qoder-cn",
        display_name: "qoder cn",
        command: "qoderclicn",
        args_json: r#"["--acp"]"#,
    },
    AgentPreset {
        id: "preset-oh-my-pi",
        display_name: "oh-my-pi",
        command: "omp",
        args_json: r#"["acp"]"#,
    },
];

/// Test whether `name` is findable on PATH.
fn command_exists(name: &str) -> bool {
    #[cfg(windows)]
    let (checker, arg) = ("where", name);
    #[cfg(not(windows))]
    let (checker, arg) = ("which", name);

    Command::new(checker)
        .arg(arg)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Seed built-in agent presets for commands that are actually installed.
///
/// Uses `INSERT OR IGNORE` so re-running on the same DB is a no-op and
/// user-edited presets are never overwritten.
pub async fn seed_builtin_presets(db: &SqlitePool) {
    for preset in BUILTIN_PRESETS {
        if !command_exists(preset.command) {
            continue;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let _ = sqlx::query(
            "INSERT OR IGNORE INTO agents (id, display_name, command, args, env, created_at, updated_at) \
             VALUES (?, ?, ?, ?, '[]', ?, ?)",
        )
        .bind(preset.id)
        .bind(preset.display_name)
        .bind(preset.command)
        .bind(preset.args_json)
        .bind(&now)
        .bind(&now)
        .execute(db)
        .await;
    }
}
