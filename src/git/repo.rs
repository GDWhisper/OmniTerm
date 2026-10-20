//! Git repository operations for the GIT panel (ADR: docs/dev/plans/archive/2026-07-26-git-panel.md).
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
/// Max staged files sent to the AI commit-message provider.
pub const AI_COMMIT_MAX_FILES: usize = 30;
/// Max staged diff characters sent to the provider (UTF-8 char boundary).
pub const AI_COMMIT_MAX_DIFF_CHARS: usize = 120_000;
/// Number of recent commit subjects used as style samples.
pub const AI_COMMIT_STYLE_SUBJECTS: usize = 10;
/// Upper bound on stash entries returned to the panel. Stash stacks can grow
/// without limit (`git stash` never prunes); the panel only needs the recent
/// window and the response must stay bounded (performance red line P1).
const MAX_STASH_ENTRIES: usize = 100;
/// Delays before retrying a write that lost the race for `index.lock`.
/// Two retries (3 attempts total) tolerate a user's terminal git command
/// without masking a genuinely stuck lock (ADR-D1: never delete the lock).
const LOCK_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_millis(750)];

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
    /// Short upstream ref (for example `origin/dev`) when the branch tracks one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StashEntry {
    /// Position in the stash stack (`stash@{index}`).
    pub index: u32,
    /// Human-readable age, e.g. `2 hours ago`.
    pub date: String,
    /// Stash description (`git stash list` `%gs`).
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct AiCommitContext {
    pub diff: String,
    pub subjects: Vec<String>,
    pub file_count: usize,
    pub omitted_files: usize,
    pub omitted_chars: usize,
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
    /// `timeout`, `not_merged`, `conflict`, `nothing_to_stash`, `nothing_staged`,
    /// `generic`.
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

/// git reports some failures (conflicts, "nothing to commit") on stdout while
/// stderr is empty — pick whichever stream carries the message.
fn error_message(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.trim().is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        stderr.trim().to_string()
    }
}

fn ensure_success(output: &Output) -> GitResult<()> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(refine_error(stderr.trim()))
}

/// Whether a failed git invocation is an `index.lock` contention. The panel
/// shares the repo with the user's terminal, so a lock collision is expected
/// and worth a short retry; we never delete the lock (D1).
fn is_lock_conflict(output: &Output) -> bool {
    if output.status.success() {
        return false;
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_lowercase();
    stderr.contains("index.lock")
        || stderr.contains("unable to create")
        || stderr.contains("another git process")
}

/// Run a mutating git command, retrying on transient `index.lock` contention.
///
/// Re-running the same `Command` is safe: each `output()` spawns a fresh
/// process, and every caller's command is idempotent enough to retry only
/// when git refused to start its work (lock creation happens first).
async fn run_write(cmd: &mut Command) -> GitResult<Output> {
    let mut attempt = 0;
    loop {
        let output = run(cmd).await?;
        if !is_lock_conflict(&output) || attempt >= LOCK_RETRY_DELAYS.len() {
            return Ok(output);
        }
        tokio::time::sleep(LOCK_RETRY_DELAYS[attempt]).await;
        attempt += 1;
    }
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
    } else if lower.contains("not fully merged") {
        // `git branch -d` refusal: the UI offers an explicit force delete.
        "not_merged"
    } else if lower.contains("conflict") {
        // stash apply/pop, cherry-pick, revert and rebase all report CONFLICT.
        "conflict"
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

fn validate_commit_sha(sha: &str) -> GitResult<()> {
    reject_option_like(sha)?;
    if !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(GitError::generic("invalid commit sha"));
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

fn truncate_chars_cap(text: &str, max_chars: usize) -> (String, usize) {
    let mut out = String::new();
    for (kept, ch) in text.chars().enumerate() {
        if kept == max_chars {
            return (out, text.chars().count() - max_chars);
        }
        out.push(ch);
    }
    (out, 0)
}

/// Collect the staged diff and recent commit subjects for AI commit-message
/// generation. Only the index is sampled (never unstaged/untracked content).
///
/// Bounds (adversarial repos can stage arbitrarily many files / bytes): at most
/// [`AI_COMMIT_MAX_FILES`] files and [`AI_COMMIT_MAX_DIFF_CHARS`] characters;
/// both overflow amounts are reported so the caller can warn explicitly.
pub async fn ai_commit_context(root: &str) -> GitResult<AiCommitContext> {
    let names = run(git_command(root).args(["diff", "--cached", "--name-only", "-z"])).await?;
    ensure_success(&names)?;
    let stdout = String::from_utf8_lossy(&names.stdout);
    let all: Vec<&str> = stdout.split('\0').filter(|p| !p.is_empty()).collect();
    if all.is_empty() {
        return Err(GitError {
            code: "nothing_staged".into(),
            message: "no staged changes".into(),
        });
    }

    let paths: Vec<&str> = all.iter().take(AI_COMMIT_MAX_FILES).copied().collect();
    let mut cmd = git_command(root);
    cmd.args(["diff", "--cached", "--no-color", "--"]).args(&paths);
    let output = run(&mut cmd).await?;
    ensure_success(&output)?;
    let raw = String::from_utf8_lossy(&output.stdout);
    let (diff, omitted_chars) = truncate_chars_cap(&raw, AI_COMMIT_MAX_DIFF_CHARS);

    let subjects = match run(git_command(root).args([
        "log",
        &format!("-n{AI_COMMIT_STYLE_SUBJECTS}"),
        "--pretty=format:%s",
    ]))
    .await
    {
        Ok(output) if output.status.success() => String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter(|line| !line.trim().is_empty())
            .take(AI_COMMIT_STYLE_SUBJECTS)
            .map(str::to_string)
            .collect(),
        // Empty repos have no HEAD; style sampling is optional.
        _ => Vec::new(),
    };

    Ok(AiCommitContext {
        diff,
        subjects,
        file_count: all.len(),
        omitted_files: all.len().saturating_sub(AI_COMMIT_MAX_FILES),
        omitted_chars,
    })
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
    validate_commit_sha(sha)?;

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
        "--format=%(HEAD)%00%(refname:short)%00%(upstream:short)",
    ]))
    .await?;
    ensure_success(&output)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            let head = fields.next()?;
            let name = fields.next()?;
            if name.is_empty() {
                return None;
            }
            let upstream = fields.next().unwrap_or("").trim();
            Some(BranchInfo {
                name: name.to_string(),
                current: head == "*",
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            })
        })
        .collect())
}

pub async fn delete_branch(root: &str, name: &str, force: bool) -> GitResult<()> {
    reject_option_like(name)?;
    let flag = if force { "-D" } else { "-d" };
    let output = run_write(git_command(root).args(["branch", flag, "--", name])).await?;
    ensure_success(&output)
}

pub async fn rename_branch(root: &str, old: &str, new: &str) -> GitResult<()> {
    reject_option_like(old)?;
    reject_option_like(new)?;
    let output = run_write(git_command(root).args(["branch", "-m", "--", old, new])).await?;
    ensure_success(&output)
}

pub async fn delete_remote_branch(root: &str, remote: &str, name: &str) -> GitResult<()> {
    reject_option_like(remote)?;
    reject_option_like(name)?;
    let mut cmd = git_command(root);
    cmd.args(["push", remote, "--delete", "--", name]);
    let output = run_remote(&mut cmd).await?;
    ensure_success(&output)
}

pub async fn stage(root: &str, paths: &[String]) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = git_command(root);
    cmd.args(["add", "--"]).args(paths);
    let output = run_write(&mut cmd).await?;
    ensure_success(&output)
}

pub async fn unstage(root: &str, paths: &[String]) -> GitResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = git_command(root);
    cmd.args(["reset", "-q", "HEAD", "--"]).args(paths);
    let output = run_write(&mut cmd).await?;
    // `git reset` in a repo without commits fails on HEAD; fall back to
    // removing the paths from the index directly.
    if !output.status.success() {
        let mut cmd = git_command(root);
        cmd.args(["rm", "--cached", "-q", "--"]).args(paths);
        let fallback = run_write(&mut cmd).await?;
        return ensure_success(&fallback);
    }
    Ok(())
}

pub async fn commit(root: &str, message: &str, amend: bool) -> GitResult<()> {
    let empty = message.trim().is_empty();
    if !amend && empty {
        return Err(GitError::generic("commit message is empty"));
    }
    let mut cmd = git_command(root);
    cmd.arg("commit");
    if amend {
        cmd.arg("--amend");
        // Empty message + amend = keep the previous message (git --no-edit).
        if empty {
            cmd.arg("--no-edit");
        } else {
            cmd.args(["-m", message]);
        }
    } else {
        cmd.args(["-m", message]);
    }
    let output = run_write(&mut cmd).await?;
    if !output.status.success() {
        return Err(refine_error(&error_message(&output)));
    }
    Ok(())
}

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

fn parse_stash_line(line: &str) -> Option<StashEntry> {
    let mut fields = line.split('\0');
    let reference = fields.next()?;
    let date = fields.next()?.to_string();
    let message = fields.next().unwrap_or("").to_string();
    let index = reference.strip_prefix("stash@{")?.strip_suffix('}')?.parse().ok()?;
    Some(StashEntry { index, date, message })
}

/// Reset modes exposed by the panel. `--hard` is deliberately absent: it
/// discards working-tree changes in addition to moving HEAD (plan D4).
#[derive(Debug, Clone, Copy)]
pub enum ResetMode {
    Soft,
    Mixed,
}

pub async fn cherry_pick(root: &str, sha: &str) -> GitResult<()> {
    validate_commit_sha(sha)?;
    let output = run_write(git_command(root).args(["cherry-pick", "--no-edit", sha])).await?;
    if output.status.success() {
        return Ok(());
    }
    Err(refine_error(&error_message(&output)))
}

pub async fn revert_commit(root: &str, sha: &str) -> GitResult<()> {
    validate_commit_sha(sha)?;
    let output = run_write(git_command(root).args(["revert", "--no-edit", sha])).await?;
    if output.status.success() {
        return Ok(());
    }
    Err(refine_error(&error_message(&output)))
}

pub async fn reset_to(root: &str, sha: &str, mode: ResetMode) -> GitResult<()> {
    validate_commit_sha(sha)?;
    let flag = match mode {
        ResetMode::Soft => "--soft",
        ResetMode::Mixed => "--mixed",
    };
    let output = run_write(git_command(root).args(["reset", flag, sha])).await?;
    ensure_success(&output)
}

fn cap_stashes(mut entries: Vec<StashEntry>) -> (Vec<StashEntry>, bool) {
    let truncated = entries.len() > MAX_STASH_ENTRIES;
    entries.truncate(MAX_STASH_ENTRIES);
    (entries, truncated)
}

pub async fn stash_list(root: &str) -> GitResult<(Vec<StashEntry>, bool)> {
    let output =
        run(git_command(root).args(["stash", "list", "--format=%gd%x00%cr%x00%gs"])).await?;
    ensure_success(&output)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(cap_stashes(stdout.lines().filter_map(parse_stash_line).collect()))
}

pub async fn stash_push(
    root: &str,
    message: Option<&str>,
    include_untracked: bool,
) -> GitResult<()> {
    let mut cmd = git_command(root);
    cmd.args(["stash", "push"]);
    if include_untracked {
        cmd.arg("--include-untracked");
    }
    if let Some(message) = message.filter(|m| !m.trim().is_empty()) {
        cmd.args(["-m", message]);
    }
    let output = run_write(&mut cmd).await?;
    if output.status.success() {
        // `git stash push` exits 0 when there is nothing to save; report it
        // honestly instead of claiming a stash was created.
        if String::from_utf8_lossy(&output.stdout).contains("No local changes to save") {
            return Err(GitError {
                code: "nothing_to_stash".into(),
                message: "no local changes to stash".into(),
            });
        }
        return Ok(());
    }
    ensure_success(&output)
}

async fn run_stash_action(root: &str, action: &str, index: u32) -> GitResult<()> {
    let reference = stash_ref(index);
    let output = run_write(git_command(root).args(["stash", action, &reference])).await?;
    if output.status.success() {
        return Ok(());
    }
    let mut err = refine_error(&error_message(&output));
    if err.code == "conflict" {
        // pop keeps the stash on conflict, apply never drops it; the UI must
        // say so rather than implying the user's changes were restored.
        err.code = "stash_conflict".into();
    }
    Err(err)
}

pub async fn stash_apply(root: &str, index: u32) -> GitResult<()> {
    run_stash_action(root, "apply", index).await
}

pub async fn stash_pop(root: &str, index: u32) -> GitResult<()> {
    run_stash_action(root, "pop", index).await
}

pub async fn stash_drop(root: &str, index: u32) -> GitResult<()> {
    run_stash_action(root, "drop", index).await
}

pub async fn discard(root: &str, files: &[DiscardFile]) -> GitResult<()> {
    let tracked: Vec<String> =
        files.iter().filter(|f| !f.untracked).map(|f| f.path.clone()).collect();
    let untracked: Vec<String> =
        files.iter().filter(|f| f.untracked).map(|f| f.path.clone()).collect();

    if !tracked.is_empty() {
        let mut cmd = git_command(root);
        cmd.args(["checkout", "-q", "--"]).args(&tracked);
        let output = run_write(&mut cmd).await?;
        ensure_success(&output)?;
    }
    if !untracked.is_empty() {
        let mut cmd = git_command(root);
        cmd.args(["clean", "-fdq", "--"]).args(&untracked);
        let output = run_write(&mut cmd).await?;
        ensure_success(&output)?;
    }
    Ok(())
}

pub async fn checkout_branch(root: &str, name: &str) -> GitResult<()> {
    reject_option_like(name)?;
    let output = run_write(git_command(root).args(["checkout", name])).await?;
    ensure_success(&output)
}

pub async fn create_branch(root: &str, name: &str) -> GitResult<()> {
    reject_option_like(name)?;
    let output = run_write(git_command(root).args(["checkout", "-b", name])).await?;
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
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    static TMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir() -> PathBuf {
        let n = TMP_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "omniterm-git-repo-test-{}-{}",
            std::process::id(),
            n
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    async fn run_git(root: &str, args: &[&str]) {
        let output =
            Command::new("git").args(["-C", root]).args(args).output().await.expect("spawn git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Fresh repo with one commit and a configured identity (no reliance on
    /// the developer's global git config).
    async fn init_test_repo() -> (PathBuf, String) {
        let dir = temp_dir();
        let root = dir.to_str().unwrap().to_string();
        run_git(&root, &["init", "-q"]).await;
        run_git(&root, &["config", "user.name", "OmniTerm Test"]).await;
        run_git(&root, &["config", "user.email", "test@omniterm.local"]).await;
        std::fs::write(dir.join("tracked.txt"), "initial\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "initial"]).await;
        (dir, root)
    }

    #[tokio::test]
    async fn write_retries_when_index_lock_is_released() {
        if !git_available() {
            eprintln!("SKIP write_retries_when_index_lock_is_released: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("new.txt"), "x\n").unwrap();
        let lock = dir.join(".git/index.lock");
        std::fs::write(&lock, b"").unwrap();

        let lock_clone = lock.clone();
        // A real OS thread, not a spawned future: `#[tokio::test]` runs on a
        // current-thread runtime, and the release must not depend on the
        // runtime scheduling the remover while `stage` awaits git.
        let remover = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            std::fs::remove_file(lock_clone).unwrap();
        });
        let result = stage(&root, &["new.txt".to_string()]).await;
        remover.join().unwrap();

        assert!(result.is_ok(), "stage must retry after the lock disappears: {result:?}");
        let st = status(&root).await.unwrap();
        assert!(
            st.entries.iter().any(|e| e.path == "new.txt" && e.index_status != "."),
            "new.txt should be staged after the retry"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn write_reports_original_error_when_lock_never_released() {
        if !git_available() {
            eprintln!("SKIP write_reports_original_error_when_lock_never_released: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("new.txt"), "x\n").unwrap();
        let lock = dir.join(".git/index.lock");
        std::fs::write(&lock, b"").unwrap();

        let result = stage(&root, &["new.txt".to_string()]).await;
        let err = result.expect_err("a held lock must surface an error after retries");
        assert!(
            err.message.to_lowercase().contains("index.lock"),
            "error should preserve git's lock message, got: {}",
            err.message
        );
        std::fs::remove_file(&lock).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    async fn current_branch_name(root: &str) -> String {
        branches(root)
            .await
            .unwrap()
            .into_iter()
            .find(|b| b.current)
            .expect("repo must have a current branch")
            .name
    }

    #[tokio::test]
    async fn delete_branch_rejects_unmerged_then_force_succeeds() {
        if !git_available() {
            eprintln!("SKIP delete_branch_rejects_unmerged_then_force_succeeds: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = current_branch_name(&root).await;
        run_git(&root, &["checkout", "-q", "-b", "feature"]).await;
        std::fs::write(dir.join("feature.txt"), "feature\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "feature work"]).await;
        run_git(&root, &["checkout", "-q", &base]).await;

        let err = delete_branch(&root, "feature", false)
            .await
            .expect_err("unmerged branch deletion must be refused by -d");
        assert_eq!(err.code, "not_merged");
        assert!(branches(&root).await.unwrap().iter().any(|b| b.name == "feature"));

        delete_branch(&root, "feature", true).await.unwrap();
        assert!(!branches(&root).await.unwrap().iter().any(|b| b.name == "feature"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn rename_branch_updates_list() {
        if !git_available() {
            eprintln!("SKIP rename_branch_updates_list: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        run_git(&root, &["branch", "old-name"]).await;
        rename_branch(&root, "old-name", "new-name").await.unwrap();
        let names: Vec<String> =
            branches(&root).await.unwrap().into_iter().map(|b| b.name).collect();
        assert!(names.contains(&"new-name".to_string()));
        assert!(!names.contains(&"old-name".to_string()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn branch_list_exposes_upstream_and_remote_delete_works() {
        if !git_available() {
            eprintln!("SKIP branch_list_exposes_upstream_and_remote_delete_works: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let remote_dir = temp_dir();
        let remote_path = remote_dir.join("remote.git").to_str().unwrap().to_string();
        let out = Command::new("git")
            .args(["init", "-q", "--bare"])
            .arg(&remote_path)
            .output()
            .await
            .unwrap();
        assert!(out.status.success());
        run_git(&root, &["remote", "add", "origin", &remote_path]).await;
        run_git(&root, &["checkout", "-q", "-b", "remote-feature"]).await;
        run_git(&root, &["push", "-q", "-u", "origin", "remote-feature"]).await;

        let branch = branches(&root)
            .await
            .unwrap()
            .into_iter()
            .find(|b| b.name == "remote-feature")
            .expect("branch present");
        assert_eq!(branch.upstream.as_deref(), Some("origin/remote-feature"));

        delete_remote_branch(&root, "origin", "remote-feature").await.unwrap();
        let remote_branches = Command::new("git")
            .args(["-C", &remote_path, "branch", "--list"])
            .output()
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&remote_branches.stdout).trim().is_empty());

        std::fs::remove_dir_all(&remote_dir).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn stash_push_list_pop_round_trip() {
        if !git_available() {
            eprintln!("SKIP stash_push_list_pop_round_trip: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("tracked.txt"), "changed\n").unwrap();

        stash_push(&root, Some("wip"), false).await.unwrap();
        let (stashes, truncated) = stash_list(&root).await.unwrap();
        assert!(!truncated);
        assert_eq!(stashes.len(), 1);
        assert_eq!(stashes[0].index, 0);
        assert!(stashes[0].message.contains("wip"), "got {}", stashes[0].message);
        assert!(status(&root).await.unwrap().entries.is_empty(), "worktree should be clean");

        stash_pop(&root, 0).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), "changed\n");
        assert!(stash_list(&root).await.unwrap().0.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn stash_push_can_include_untracked_files() {
        if !git_available() {
            eprintln!("SKIP stash_push_can_include_untracked_files: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("untracked.txt"), "new\n").unwrap();

        stash_push(&root, None, true).await.unwrap();
        assert!(!dir.join("untracked.txt").exists(), "untracked file should be stashed");
        assert!(status(&root).await.unwrap().entries.is_empty());

        stash_pop(&root, 0).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("untracked.txt")).unwrap(), "new\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn stash_push_reports_nothing_to_save() {
        if !git_available() {
            eprintln!("SKIP stash_push_reports_nothing_to_save: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let err = stash_push(&root, None, false).await.unwrap_err();
        assert_eq!(err.code, "nothing_to_stash");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn stash_pop_conflict_keeps_stash_and_returns_coded_error() {
        if !git_available() {
            eprintln!("SKIP stash_pop_conflict_keeps_stash_and_returns_coded_error: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("tracked.txt"), "stashed\n").unwrap();
        stash_push(&root, None, false).await.unwrap();
        std::fs::write(dir.join("tracked.txt"), "committed\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "conflicting change"]).await;

        let err = stash_pop(&root, 0).await.unwrap_err();
        assert_eq!(err.code, "stash_conflict");
        assert_eq!(
            stash_list(&root).await.unwrap().0.len(),
            1,
            "pop must keep the stash on conflict"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    async fn head_sha(root: &str) -> String {
        let out =
            Command::new("git").args(["-C", root, "rev-parse", "HEAD"]).output().await.unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn cherry_pick_applies_commit_from_other_branch() {
        if !git_available() {
            eprintln!("SKIP cherry_pick_applies_commit_from_other_branch: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = current_branch_name(&root).await;
        run_git(&root, &["checkout", "-q", "-b", "feature"]).await;
        std::fs::write(dir.join("feature.txt"), "feature\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "feature commit"]).await;
        let feature_sha = head_sha(&root).await;
        run_git(&root, &["checkout", "-q", &base]).await;

        cherry_pick(&root, &feature_sha).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("feature.txt")).unwrap(), "feature\n");
        let subject = Command::new("git")
            .args(["-C", &root, "log", "-1", "--pretty=%s"])
            .output()
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&subject.stdout).trim(), "feature commit");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn cherry_pick_conflict_returns_conflict_code() {
        if !git_available() {
            eprintln!("SKIP cherry_pick_conflict_returns_conflict_code: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = current_branch_name(&root).await;
        run_git(&root, &["checkout", "-q", "-b", "feature"]).await;
        std::fs::write(dir.join("tracked.txt"), "feature\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "feature line"]).await;
        let feature_sha = head_sha(&root).await;
        run_git(&root, &["checkout", "-q", &base]).await;
        std::fs::write(dir.join("tracked.txt"), "base\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "base line"]).await;

        let err = cherry_pick(&root, &feature_sha).await.unwrap_err();
        assert_eq!(err.code, "conflict");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn revert_commit_undoes_change() {
        if !git_available() {
            eprintln!("SKIP revert_commit_undoes_change: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("tracked.txt"), "changed\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "change"]).await;
        let change_sha = head_sha(&root).await;

        revert_commit(&root, &change_sha).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), "initial\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn reset_mixed_moves_head_and_keeps_worktree_changes() {
        if !git_available() {
            eprintln!("SKIP reset_mixed_moves_head_and_keeps_worktree_changes: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = head_sha(&root).await;
        std::fs::write(dir.join("tracked.txt"), "second\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "second"]).await;

        reset_to(&root, &base, ResetMode::Mixed).await.unwrap();
        assert_eq!(head_sha(&root).await, base);
        assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), "second\n");
        let st = status(&root).await.unwrap();
        let entry = st.entries.iter().find(|e| e.path == "tracked.txt").expect("changed file");
        assert_eq!(entry.index_status, ".", "mixed reset must leave the index at HEAD");
        assert_eq!(entry.worktree_status, "M");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn reset_soft_keeps_changes_staged() {
        if !git_available() {
            eprintln!("SKIP reset_soft_keeps_changes_staged: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = head_sha(&root).await;
        std::fs::write(dir.join("tracked.txt"), "second\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "second"]).await;

        reset_to(&root, &base, ResetMode::Soft).await.unwrap();
        assert_eq!(head_sha(&root).await, base);
        let st = status(&root).await.unwrap();
        let entry = st.entries.iter().find(|e| e.path == "tracked.txt").expect("changed file");
        assert_eq!(entry.index_status, "M");
        assert_eq!(entry.worktree_status, ".");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    async fn head_subject(root: &str) -> String {
        let out = Command::new("git")
            .args(["-C", root, "log", "-1", "--pretty=%s"])
            .output()
            .await
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    async fn parent_sha(root: &str) -> String {
        let out =
            Command::new("git").args(["-C", root, "rev-parse", "HEAD^"]).output().await.unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn commit_amend_rewrites_head_and_keeps_parent() {
        if !git_available() {
            eprintln!("SKIP commit_amend_rewrites_head_and_keeps_parent: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let initial = head_sha(&root).await;
        std::fs::write(dir.join("tracked.txt"), "second\n").unwrap();
        run_git(&root, &["add", "."]).await;
        commit(&root, "second", false).await.unwrap();
        let before = head_sha(&root).await;

        commit(&root, "second amended", true).await.unwrap();
        assert_ne!(head_sha(&root).await, before, "amend must create a new sha");
        assert_eq!(parent_sha(&root).await, initial, "amend must keep the parent");
        assert_eq!(head_subject(&root).await, "second amended");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn commit_amend_with_empty_message_keeps_previous_message() {
        if !git_available() {
            eprintln!("SKIP commit_amend_with_empty_message_keeps_previous_message: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("tracked.txt"), "second\n").unwrap();
        run_git(&root, &["add", "."]).await;
        commit(&root, "original message", false).await.unwrap();

        commit(&root, "   ", true).await.unwrap();
        assert_eq!(head_subject(&root).await, "original message");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn commit_requires_message_unless_amending() {
        let err = commit("/nonexistent", "  ", false).await.unwrap_err();
        assert!(err.message.contains("commit message is empty"));
    }

    #[tokio::test]
    async fn ai_commit_context_only_samples_staged_content() {
        if !git_available() {
            eprintln!("SKIP ai_commit_context_only_samples_staged_content: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("staged.txt"), "staged\n").unwrap();
        run_git(&root, &["add", "staged.txt"]).await;
        std::fs::write(dir.join("tracked.txt"), "unstaged\n").unwrap();

        let ctx = ai_commit_context(&root).await.unwrap();
        assert_eq!(ctx.file_count, 1);
        assert_eq!(ctx.omitted_files, 0);
        assert_eq!(ctx.omitted_chars, 0);
        assert!(ctx.diff.contains("staged.txt"));
        assert!(!ctx.diff.contains("tracked.txt"), "unstaged changes must not be sent");
        assert_eq!(ctx.subjects, ["initial"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn ai_commit_context_caps_file_count_and_reports_omissions() {
        if !git_available() {
            eprintln!(
                "SKIP ai_commit_context_caps_file_count_and_reports_omissions: git not found"
            );
            return;
        }
        let (dir, root) = init_test_repo().await;
        for i in 0..AI_COMMIT_MAX_FILES + 2 {
            std::fs::write(dir.join(format!("f{i:03}.txt")), format!("file {i}\n")).unwrap();
        }
        run_git(&root, &["add", "."]).await;

        let ctx = ai_commit_context(&root).await.unwrap();
        assert_eq!(ctx.file_count, AI_COMMIT_MAX_FILES + 2);
        assert_eq!(ctx.omitted_files, 2);
        assert_eq!(ctx.diff.matches("diff --git ").count(), AI_COMMIT_MAX_FILES);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn ai_commit_context_truncates_large_diff_on_char_boundary() {
        if !git_available() {
            eprintln!(
                "SKIP ai_commit_context_truncates_large_diff_on_char_boundary: git not found"
            );
            return;
        }
        let (dir, root) = init_test_repo().await;
        // CJK chars are 3 UTF-8 bytes; truncation must not split one.
        let big = "改".repeat(AI_COMMIT_MAX_DIFF_CHARS + 1000);
        std::fs::write(dir.join("big.txt"), big).unwrap();
        run_git(&root, &["add", "."]).await;

        let ctx = ai_commit_context(&root).await.unwrap();
        assert!(ctx.omitted_chars > 0);
        assert_eq!(ctx.diff.chars().count(), AI_COMMIT_MAX_DIFF_CHARS);
        assert!(ctx.diff.ends_with('改'), "must cut between characters, not inside one");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn ai_commit_context_rejects_clean_index() {
        if !git_available() {
            eprintln!("SKIP ai_commit_context_rejects_clean_index: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let err = ai_commit_context(&root).await.unwrap_err();
        assert_eq!(err.code, "nothing_staged");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn truncate_chars_cap_is_char_safe_and_reports_omissions() {
        assert_eq!(truncate_chars_cap("abc", 3), ("abc".to_string(), 0));
        assert_eq!(truncate_chars_cap("abcd", 3), ("abc".to_string(), 1));
        let (out, omitted) = truncate_chars_cap("改变世界", 2);
        assert_eq!(out, "改变");
        assert_eq!(omitted, 2);
    }

    #[test]
    fn validate_commit_sha_rejects_options_and_non_hex() {
        assert!(validate_commit_sha("-x").is_err());
        assert!(validate_commit_sha("HEAD~1").is_err());
        assert!(validate_commit_sha("").is_err());
        assert!(validate_commit_sha("abc1234def").is_ok());
    }

    #[test]
    fn stash_list_is_capped_with_explicit_truncation_flag() {
        let entries: Vec<StashEntry> = (0..MAX_STASH_ENTRIES + 3)
            .map(|n| StashEntry {
                index: n as u32,
                date: "now".into(),
                message: format!("stash {n}"),
            })
            .collect();
        let (capped, truncated) = cap_stashes(entries);
        assert!(truncated);
        assert_eq!(capped.len(), MAX_STASH_ENTRIES);
        assert_eq!(capped[0].index, 0);
        assert_eq!(capped[MAX_STASH_ENTRIES - 1].index, MAX_STASH_ENTRIES as u32 - 1);

        let (exact, truncated) = cap_stashes(capped);
        assert!(!truncated);
        assert_eq!(exact.len(), MAX_STASH_ENTRIES);
    }

    #[test]
    fn parse_stash_line_extracts_index() {
        let entry = parse_stash_line("stash@{3}\0 2 hours ago\0On dev: wip").unwrap();
        assert_eq!(entry.index, 3);
        assert_eq!(entry.date, " 2 hours ago");
        assert_eq!(entry.message, "On dev: wip");
        assert!(parse_stash_line("garbage").is_none());
    }

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
        assert_eq!(
            refine_error("error: The branch 'x' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D x'.").code,
            "not_merged"
        );
        assert_eq!(
            refine_error("CONFLICT (content): Merge conflict in src/main.rs").code,
            "conflict"
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
