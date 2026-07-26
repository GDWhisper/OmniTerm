//! Git repository operations for the GIT panel (ADR: docs/dev/plans/2026-07-26-git-panel.md).
//! All operations shell out to the git CLI; read ops use `--no-optional-locks`
//! to avoid contending on `index.lock` with the user's terminal.

use std::process::Output;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// Max bytes of diff text returned to the frontend before truncation.
const MAX_DIFF_BYTES: usize = 256 * 1024;
/// Timeout for remote operations (push/pull/fetch).
const REMOTE_OP_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Serialize)]
pub struct StatusEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    /// Index (staged) status char from porcelain v2: `.` = unchanged, `?` = untracked.
    pub index_status: String,
    /// Working tree status char.
    pub worktree_status: String,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoStatus {
    pub is_repo: bool,
    pub repo_root: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub entries: Vec<StatusEntry>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitDetail {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub message: String,
    pub diff: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DiscardFile {
    pub path: String,
    #[serde(default)]
    pub untracked: bool,
}

/// User-facing git error with a machine-readable code for i18n on the frontend.
#[derive(Debug, Serialize)]
pub struct GitError {
    /// One of: `auth`, `non_fast_forward`, `no_upstream`, `dirty_worktree`,
    /// `timeout`, `generic`.
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for GitError {}

impl GitError {
    fn generic(message: impl Into<String>) -> Self {
        Self { code: "generic".into(), message: message.into() }
    }
}

type GitResult<T> = Result<T, GitError>;

fn git_command(root: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(["-C", root, "--no-optional-locks"]);
    // Never let git prompt interactively (HTTPS credentials or SSH host keys):
    // panel ops must fail fast with a readable error instead of hanging.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes");
    cmd
}

async fn run(cmd: &mut Command) -> GitResult<Output> {
    cmd.output().await.map_err(|e| GitError::generic(format!("failed to spawn git: {e}")))
}

fn ensure_success(output: &Output) -> GitResult<()> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(refine_error(stderr.trim()))
}

/// Map raw git stderr to a coded, readable error (openchamber `parseGitErrorText` 思路).
fn refine_error(stderr: &str) -> GitError {
    let lower = stderr.to_lowercase();
    let code = if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("permission denied")
        || lower.contains("terminal prompts disabled")
        || lower.contains("host key verification failed")
    {
        "auth"
    } else if lower.contains("non-fast-forward")
        || lower.contains("fetch first")
        || (lower.contains("rejected") && lower.contains("push"))
    {
        "non_fast_forward"
    } else if lower.contains("no upstream branch")
        || lower.contains("no tracking information")
        || lower.contains("--set-upstream")
    {
        "no_upstream"
    } else if lower.contains("would be overwritten by checkout")
        || lower.contains("commit your changes or stash them")
    {
        "dirty_worktree"
    } else {
        "generic"
    };
    GitError { code: code.into(), message: stderr.to_string() }
}

fn truncate_diff(raw: &str) -> (String, bool) {
    if raw.len() <= MAX_DIFF_BYTES {
        return (raw.to_string(), false);
    }
    // Cut on a line boundary so the renderer never sees a torn line.
    let cut = raw[..MAX_DIFF_BYTES].rfind('\n').unwrap_or(MAX_DIFF_BYTES);
    (raw[..cut].to_string(), true)
}

/// Refuse values that git would parse as options (paths go after `--`,
/// but branch/sha positions cannot always be separated).
fn reject_option_like(value: &str) -> GitResult<()> {
    if value.is_empty() || value.starts_with('-') {
        return Err(GitError::generic(format!("invalid argument: {value:?}")));
    }
    Ok(())
}

/// Resolve the repository toplevel for a directory, or `None` if not a git repo.
pub async fn resolve_repo_root(dir: &str) -> Option<String> {
    let output = Command::new("git")
        .args(["-C", dir, "rev-parse", "--show-toplevel"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() { None } else { Some(root) }
}

pub async fn status(root: &str) -> GitResult<RepoStatus> {
    let output =
        run(git_command(root).args(["status", "--porcelain=v2", "--branch", "-z"])).await?;
    ensure_success(&output)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_status_v2(root, &stdout))
}

fn parse_status_v2(root: &str, raw: &str) -> RepoStatus {
    let mut st = RepoStatus {
        is_repo: true,
        repo_root: root.to_string(),
        branch: None,
        detached: false,
        upstream: None,
        ahead: 0,
        behind: 0,
        entries: Vec::new(),
    };

    // `-z` terminates records with NUL; rename records embed a second
    // NUL-separated orig path, handled via the iterator below.
    let mut records = raw.split('\0');
    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }
        if let Some(header) = record.strip_prefix("# ") {
            let mut parts = header.splitn(2, ' ');
            let key = parts.next().unwrap_or("");
            let value = parts.next().unwrap_or("");
            match key {
                "branch.head" => {
                    if value == "(detached)" {
                        st.detached = true;
                    } else {
                        st.branch = Some(value.to_string());
                    }
                }
                "branch.upstream" => st.upstream = Some(value.to_string()),
                "branch.ab" => {
                    for tok in value.split(' ') {
                        if let Some(a) = tok.strip_prefix('+') {
                            st.ahead = a.parse().unwrap_or(0);
                        } else if let Some(b) = tok.strip_prefix('-') {
                            st.behind = b.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }

        let kind = record.chars().next().unwrap_or(' ');
        match kind {
            '1' => {
                // 1 XY sub mH mI mW hH hI path
                let mut fields = record.splitn(9, ' ');
                let xy = fields.nth(1).unwrap_or("..");
                let path = fields.nth(6).unwrap_or("");
                if !path.is_empty() {
                    st.entries.push(entry_from_xy(path, None, xy, false));
                }
            }
            '2' => {
                // 2 XY sub mH mI mW hH hI Xscore path (NUL) origPath
                let mut fields = record.splitn(10, ' ');
                let xy = fields.nth(1).unwrap_or("..");
                let path = fields.nth(7).unwrap_or("");
                let orig = records.next().map(|s| s.to_string()).filter(|s| !s.is_empty());
                if !path.is_empty() {
                    st.entries.push(entry_from_xy(path, orig, xy, false));
                }
            }
            'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let mut fields = record.splitn(11, ' ');
                let xy = fields.nth(1).unwrap_or("..");
                let path = fields.nth(8).unwrap_or("");
                if !path.is_empty() {
                    st.entries.push(entry_from_xy(path, None, xy, true));
                }
            }
            '?' => {
                let path = record.strip_prefix("? ").unwrap_or("");
                if !path.is_empty() {
                    st.entries.push(StatusEntry {
                        path: path.to_string(),
                        orig_path: None,
                        index_status: "?".into(),
                        worktree_status: "?".into(),
                        conflicted: false,
                    });
                }
            }
            _ => {}
        }
    }
    st
}

fn entry_from_xy(path: &str, orig_path: Option<String>, xy: &str, conflicted: bool) -> StatusEntry {
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.');
    let worktree = chars.next().unwrap_or('.');
    StatusEntry {
        path: path.to_string(),
        orig_path,
        index_status: index.to_string(),
        worktree_status: worktree.to_string(),
        conflicted,
    }
}

pub async fn diff_file(
    root: &str,
    path: &str,
    staged: bool,
    untracked: bool,
) -> GitResult<(String, bool)> {
    let output = if untracked {
        // Untracked files have no diff base; compare against /dev/null.
        // `--no-index` exits 1 when the files differ, which is the normal case.
        run(git_command(root).args(["diff", "--no-color", "--no-index", "--", "/dev/null", path]))
            .await?
    } else {
        let mut cmd = git_command(root);
        cmd.args(["diff", "--no-color"]);
        if staged {
            cmd.arg("--cached");
        }
        cmd.args(["--", path]);
        run(&mut cmd).await?
    };

    // `diff` exits 1 when differences exist (always with --no-index).
    let exit_ok = matches!(output.status.code(), Some(0) | Some(1));
    if !exit_ok {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(refine_error(stderr.trim()));
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    Ok(truncate_diff(&raw))
}

pub async fn log(root: &str, skip: u32, limit: u32) -> GitResult<(Vec<LogEntry>, bool)> {
    // Fetch one extra entry to detect whether more pages exist.
    let output = run(git_command(root).args([
        "log",
        "--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s",
        &format!("--skip={skip}"),
        "-n",
        &format!("{}", limit + 1),
    ]))
    .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let trimmed = stderr.trim();
        // Empty repository (no commits yet) is not an error for the panel.
        if trimmed.contains("does not have any commits yet") {
            return Ok((Vec::new(), false));
        }
        return Err(refine_error(trimmed));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut entries: Vec<LogEntry> = stdout
        .lines()
        .filter_map(|line| {
            let mut f = line.split('\0');
            Some(LogEntry {
                sha: f.next()?.to_string(),
                short_sha: f.next()?.to_string(),
                author: f.next()?.to_string(),
                date: f.next()?.to_string(),
                subject: f.next().unwrap_or("").to_string(),
            })
        })
        .collect();
    let has_more = entries.len() as u32 > limit;
    entries.truncate(limit as usize);
    Ok((entries, has_more))
}

pub async fn show_commit(root: &str, sha: &str) -> GitResult<CommitDetail> {
    reject_option_like(sha)?;
    if !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(GitError::generic("invalid commit sha"));
    }

    let meta = run(git_command(root).args([
        "show",
        "-s",
        "--pretty=format:%H%x00%h%x00%an%x00%ae%x00%aI%x00%B",
        sha,
    ]))
    .await?;
    ensure_success(&meta)?;
    let meta_out = String::from_utf8_lossy(&meta.stdout).to_string();
    let mut f = meta_out.split('\0');
    let (full, short, author, email, date) = (
        f.next().unwrap_or("").to_string(),
        f.next().unwrap_or("").to_string(),
        f.next().unwrap_or("").to_string(),
        f.next().unwrap_or("").to_string(),
        f.next().unwrap_or("").to_string(),
    );
    let message = f.next().unwrap_or("").trim_end().to_string();

    let patch =
        run(git_command(root).args(["show", "--no-color", "--pretty=format:", "--patch", sha]))
            .await?;
    ensure_success(&patch)?;
    let raw = String::from_utf8_lossy(&patch.stdout);
    let (diff, truncated) = truncate_diff(&raw);

    Ok(CommitDetail { sha: full, short_sha: short, author, email, date, message, diff, truncated })
}

pub async fn branches(root: &str) -> GitResult<Vec<BranchInfo>> {
    let output = run(git_command(root).args([
        "for-each-ref",
        "refs/heads",
        "--format=%(HEAD)%00%(refname:short)",
    ]))
    .await?;
    ensure_success(&output)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter_map(|line| {
            let (head, name) = line.split_once('\0')?;
            if name.is_empty() {
                return None;
            }
            Some(BranchInfo { name: name.to_string(), current: head == "*" })
        })
        .collect())
}

pub async fn stage(root: &str, paths: &[String]) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = git_command(root);
    cmd.args(["add", "--"]).args(paths);
    let output = run(&mut cmd).await?;
    ensure_success(&output)
}

pub async fn unstage(root: &str, paths: &[String]) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = git_command(root);
    cmd.args(["reset", "-q", "HEAD", "--"]).args(paths);
    let output = run(&mut cmd).await?;
    // `git reset` in a repo without commits fails on HEAD; fall back to
    // removing the paths from the index directly.
    if !output.status.success() {
        let mut cmd = git_command(root);
        cmd.args(["rm", "--cached", "-q", "--"]).args(paths);
        let fallback = run(&mut cmd).await?;
        return ensure_success(&fallback);
    }
    Ok(())
}

pub async fn commit(root: &str, message: &str) -> GitResult<()> {
    if message.trim().is_empty() {
        return Err(GitError::generic("commit message is empty"));
    }
    let output = run(git_command(root).args(["commit", "-m", message])).await?;
    if !output.status.success() {
        // git commit reports "nothing to commit" etc. on stdout, not stderr.
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let msg = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        return Err(refine_error(msg));
    }
    Ok(())
}

pub async fn discard(root: &str, files: &[DiscardFile]) -> GitResult<()> {
    let tracked: Vec<String> =
        files.iter().filter(|f| !f.untracked).map(|f| f.path.clone()).collect();
    let untracked: Vec<String> =
        files.iter().filter(|f| f.untracked).map(|f| f.path.clone()).collect();

    if !tracked.is_empty() {
        let mut cmd = git_command(root);
        cmd.args(["checkout", "-q", "--"]).args(&tracked);
        let output = run(&mut cmd).await?;
        ensure_success(&output)?;
    }
    if !untracked.is_empty() {
        let mut cmd = git_command(root);
        cmd.args(["clean", "-fdq", "--"]).args(&untracked);
        let output = run(&mut cmd).await?;
        ensure_success(&output)?;
    }
    Ok(())
}

pub async fn checkout_branch(root: &str, name: &str) -> GitResult<()> {
    reject_option_like(name)?;
    let output = run(git_command(root).args(["checkout", name])).await?;
    ensure_success(&output)
}

pub async fn create_branch(root: &str, name: &str) -> GitResult<()> {
    reject_option_like(name)?;
    let output = run(git_command(root).args(["checkout", "-b", name])).await?;
    ensure_success(&output)
}

async fn run_remote(cmd: &mut Command) -> GitResult<Output> {
    match tokio::time::timeout(REMOTE_OP_TIMEOUT, cmd.output()).await {
        Ok(result) => result.map_err(|e| GitError::generic(format!("failed to spawn git: {e}"))),
        Err(_) => Err(GitError {
            code: "timeout".into(),
            message: format!(
                "git remote operation timed out after {}s",
                REMOTE_OP_TIMEOUT.as_secs()
            ),
        }),
    }
}

pub async fn push(root: &str) -> GitResult<()> {
    let mut c = git_command(root);
    c.arg("push");
    let output = run_remote(&mut c).await?;
    if output.status.success() {
        return Ok(());
    }
    let err = refine_error(String::from_utf8_lossy(&output.stderr).trim());
    if err.code != "no_upstream" {
        return Err(err);
    }
    // First push of a new branch: retry with automatic upstream setup.
    let mut c = git_command(root);
    c.args(["push", "--set-upstream", "origin", "HEAD"]);
    let retry = run_remote(&mut c).await?;
    ensure_success(&retry)
}

pub async fn pull(root: &str) -> GitResult<()> {
    let mut c = git_command(root);
    c.args(["pull", "--ff-only"]);
    let output = run_remote(&mut c).await?;
    ensure_success(&output)
}

pub async fn fetch(root: &str) -> GitResult<()> {
    let mut c = git_command(root);
    c.args(["fetch", "--prune"]);
    let output = run_remote(&mut c).await?;
    ensure_success(&output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_v2_branch_headers() {
        let raw = "# branch.oid abc123\0# branch.head dev\0# branch.upstream origin/dev\0# branch.ab +2 -1\0";
        let st = parse_status_v2("/repo", raw);
        assert_eq!(st.branch.as_deref(), Some("dev"));
        assert_eq!(st.upstream.as_deref(), Some("origin/dev"));
        assert_eq!(st.ahead, 2);
        assert_eq!(st.behind, 1);
        assert!(!st.detached);
        assert!(st.entries.is_empty());
    }

    #[test]
    fn parse_status_v2_detached() {
        let raw = "# branch.oid abc123\0# branch.head (detached)\0";
        let st = parse_status_v2("/repo", raw);
        assert!(st.detached);
        assert_eq!(st.branch, None);
    }

    #[test]
    fn parse_status_v2_changed_entries() {
        let raw = concat!(
            "1 M. N... 100644 100644 100644 abc def src/main.rs\0",
            "1 .M N... 100644 100644 100644 abc def README.md\0",
            "1 MM N... 100644 100644 100644 abc def both.rs\0",
            "? new.txt\0",
        );
        let st = parse_status_v2("/repo", raw);
        assert_eq!(st.entries.len(), 4);
        assert_eq!(st.entries[0].path, "src/main.rs");
        assert_eq!(st.entries[0].index_status, "M");
        assert_eq!(st.entries[0].worktree_status, ".");
        assert_eq!(st.entries[1].index_status, ".");
        assert_eq!(st.entries[1].worktree_status, "M");
        assert_eq!(st.entries[2].index_status, "M");
        assert_eq!(st.entries[2].worktree_status, "M");
        assert_eq!(st.entries[3].index_status, "?");
        assert_eq!(st.entries[3].worktree_status, "?");
    }

    #[test]
    fn parse_status_v2_rename() {
        let raw = "2 R. N... 100644 100644 100644 abc def R100 new_name.rs\0old_name.rs\0";
        let st = parse_status_v2("/repo", raw);
        assert_eq!(st.entries.len(), 1);
        assert_eq!(st.entries[0].path, "new_name.rs");
        assert_eq!(st.entries[0].orig_path.as_deref(), Some("old_name.rs"));
        assert_eq!(st.entries[0].index_status, "R");
    }

    #[test]
    fn parse_status_v2_conflict() {
        let raw = "u UU N... 100644 100644 100644 100644 a b c conflicted.rs\0";
        let st = parse_status_v2("/repo", raw);
        assert_eq!(st.entries.len(), 1);
        assert!(st.entries[0].conflicted);
        assert_eq!(st.entries[0].path, "conflicted.rs");
        assert_eq!(st.entries[0].index_status, "U");
    }

    #[test]
    fn refine_error_codes() {
        assert_eq!(refine_error("fatal: Authentication failed for 'https://x'").code, "auth");
        assert_eq!(
            refine_error("fatal: could not read Username: terminal prompts disabled").code,
            "auth"
        );
        assert_eq!(refine_error("git@github.com: Permission denied (publickey).").code, "auth");
        assert_eq!(
            refine_error("! [rejected] dev -> dev (non-fast-forward)\nerror: failed to push").code,
            "non_fast_forward"
        );
        assert_eq!(
            refine_error("fatal: The current branch x has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n    git push --set-upstream origin x").code,
            "no_upstream"
        );
        assert_eq!(
            refine_error("error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/main.rs\nPlease commit your changes or stash them before you switch branches.").code,
            "dirty_worktree"
        );
        assert_eq!(refine_error("fatal: something else").code, "generic");
    }

    #[test]
    fn truncate_diff_cuts_on_line_boundary() {
        let (out, truncated) = truncate_diff("short diff\n");
        assert!(!truncated);
        assert_eq!(out, "short diff\n");

        let line = "a".repeat(1000) + "\n";
        let big = line.repeat(MAX_DIFF_BYTES / 1000 + 10);
        let (out, truncated) = truncate_diff(&big);
        assert!(truncated);
        assert!(out.len() <= MAX_DIFF_BYTES);
        assert!(out.ends_with('a'));
    }

    #[test]
    fn reject_option_like_values() {
        assert!(reject_option_like("--force").is_err());
        assert!(reject_option_like("").is_err());
        assert!(reject_option_like("feature/x").is_ok());
    }
}
