//! Git repository operations for the GIT panel (ADR: docs/dev/plans/archive/2026-07-26-git-panel.md).
//! All operations shell out to the git CLI; read ops use `--no-optional-locks`
//! to avoid contending on `index.lock` with the user's terminal.

use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::atomic::{AtomicUsize, Ordering};
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
/// Upper bound on files returned by a branch comparison or a commit detail.
/// Either can touch an arbitrarily large tree; responses must stay bounded
/// (performance red line P1).
const MAX_CHANGED_FILES: usize = 1000;
/// Delays before retrying a write that lost the race for `index.lock`.
/// Two retries (3 attempts total) tolerate a user's terminal git command
/// without masking a genuinely stuck lock (ADR-D1: never delete the lock).
const LOCK_RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(250), Duration::from_millis(750)];
/// Context lines around each hunk in the normal diff view.
pub const DEFAULT_CONTEXT_LINES: u32 = 3;
/// Upper bound for the expand-context toggle. Every value in 1..=MAX is a
/// valid `git diff -U<n>`; 0 is rejected because `git apply` refuses
/// zero-context patches without `--unidiff-zero`.
pub const MAX_CONTEXT_LINES: u32 = 20;
/// A single hunk patch is a slice of a diff that is already capped at
/// `MAX_DIFF_BYTES`; anything larger cannot be a canonical hunk.
const MAX_HUNK_PATCH_BYTES: usize = MAX_DIFF_BYTES;

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
    /// Merge/rebase/cherry-pick/revert/am state, so the panel can offer
    /// abort/continue even when the operation was started in the terminal.
    pub in_progress: Option<InProgress>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InProgress {
    /// `merge` | `rebase` | `cherry_pick` | `revert` | `am`.
    pub kind: String,
    /// Number of unmerged entries in the index.
    pub conflicted: usize,
}

/// Git operation kinds that can pause with state on disk (plan D5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperationKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Am,
}

impl OperationKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Rebase => "rebase",
            Self::CherryPick => "cherry_pick",
            Self::Revert => "revert",
            Self::Am => "am",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "merge" => Some(Self::Merge),
            "rebase" => Some(Self::Rebase),
            "cherry_pick" => Some(Self::CherryPick),
            "revert" => Some(Self::Revert),
            "am" => Some(Self::Am),
            _ => None,
        }
    }

    /// Subcommand name used to build `git <name> --continue|--abort`.
    fn cli_name(self) -> &'static str {
        match self {
            Self::Merge => "merge",
            Self::Rebase => "rebase",
            Self::CherryPick => "cherry-pick",
            Self::Revert => "revert",
            Self::Am => "am",
        }
    }
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
    /// Files touched by the commit (`git show --name-status`).
    pub files: Vec<ChangedFile>,
    /// True when the file list hit the server-side cap.
    pub files_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    /// Short upstream ref (for example `origin/dev`) when the branch tracks one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
}

/// One changed file from `--name-status` output (branch comparison or commit).
#[derive(Debug, Clone, Serialize)]
pub struct ChangedFile {
    pub path: String,
    /// Rename/copy source when `status` is `R`/`C`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    /// Single status letter (A/M/D/R/C/T/U).
    pub status: String,
}

#[derive(Debug, Clone)]
pub struct RangeOverview {
    pub merge_base: String,
    pub files: Vec<ChangedFile>,
    pub files_truncated: bool,
    pub diff: String,
    pub truncated: bool,
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

/// One apply-able hunk: file header + a single `@@` section, verbatim.
#[derive(Debug, Clone, Serialize)]
pub struct HunkInfo {
    /// The `@@ ... @@` line without its trailing newline. The frontend matches
    /// this against its display parser before rendering action buttons.
    pub header: String,
    /// Opaque apply token echoed back by the client. Built from the same
    /// `git diff` output as `header`, so canonical validation is byte equality.
    pub patch: String,
}

#[derive(Debug, Clone)]
pub struct FileHunks {
    pub diff: String,
    pub truncated: bool,
    pub context_lines: u32,
    pub hunks: Vec<HunkInfo>,
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
    /// `stale_hunk`, `invalid_hunk`, `invalid_base`, `no_merge_base`,
    /// `invalid_branch`, `invalid_path`, `no_operation`, `operation_in_progress`,
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
    fn coded(code: &'static str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }

    fn generic(message: impl Into<String>) -> Self {
        Self::coded("generic", message)
    }

    pub fn invalid_hunk(message: impl Into<String>) -> Self {
        Self::coded("invalid_hunk", message)
    }

    pub fn stale_hunk(message: impl Into<String>) -> Self {
        Self::coded("stale_hunk", message)
    }

    fn invalid_base(message: impl Into<String>) -> Self {
        Self::coded("invalid_base", message)
    }

    fn no_merge_base(message: impl Into<String>) -> Self {
        Self::coded("no_merge_base", message)
    }

    fn invalid_branch(message: impl Into<String>) -> Self {
        Self::coded("invalid_branch", message)
    }

    fn invalid_path(message: impl Into<String>) -> Self {
        Self::coded("invalid_path", message)
    }

    fn no_operation() -> Self {
        Self::coded("no_operation", "no merge or rebase is in progress")
    }

    fn operation_in_progress(kind: &str) -> Self {
        Self::coded(
            "operation_in_progress",
            format!("{kind} is already in progress — continue or abort it first"),
        )
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::coded("conflict", message)
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
    } else if lower.contains("not concluded your merge")
        || lower.contains("in progress")
        || lower.contains("rebase-merge directory")
    {
        "operation_in_progress"
    } else if lower.contains("would be overwritten by")
        || lower.contains("cannot rebase")
        || lower.contains("uncommitted changes")
        || lower.contains("commit your changes or stash them")
    {
        "dirty_worktree"
    } else if lower.contains("not fully merged") {
        // `git branch -d` refusal: the UI offers an explicit force delete.
        "not_merged"
    } else if lower.contains("unmerged files")
        || lower.contains("resolve your current index")
        || lower.contains("conflict")
    {
        // stash apply/pop, cherry-pick, revert and rebase all report CONFLICT;
        // `--continue` with unresolved entries reports unmerged files instead.
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

/// Whether a path is safe to hand to git: relative to the repo root, not
/// option-like, and unable to escape the repository.
fn is_relative_repo_path(path: &str) -> bool {
    !(path.is_empty()
        || path.starts_with('-')
        || Path::new(path).is_absolute()
        || Path::new(path).components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        }))
}

/// Diff paths always come from `git status` and are relative to the repo root.
/// Reject anything that could escape the repo or be parsed as an option.
fn validate_repo_path(path: &str) -> GitResult<()> {
    if !is_relative_repo_path(path) {
        return Err(GitError::invalid_hunk(format!(
            "path must be relative to the repo root: {path:?}"
        )));
    }
    Ok(())
}

fn validate_range_path(path: &str) -> GitResult<()> {
    if !is_relative_repo_path(path) {
        return Err(GitError::invalid_path(format!(
            "path must be relative to the repo root: {path:?}"
        )));
    }
    Ok(())
}

pub fn normalize_context_lines(value: Option<u32>) -> u32 {
    value.unwrap_or(DEFAULT_CONTEXT_LINES).clamp(1, MAX_CONTEXT_LINES)
}

/// Diff flags shared by display, hunk extraction and branch comparison.
/// Prefixes and the full index id are forced so a patch can be fed back to
/// `git apply` regardless of the user's `diff.noprefix` / external-diff config.
fn diff_command(root: &str) -> Command {
    let mut cmd = git_command(root);
    cmd.args([
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--full-index",
    ]);
    cmd
}

fn tracked_diff_command(root: &str, path: &str, staged: bool, context_lines: u32) -> Command {
    let mut cmd = diff_command(root);
    cmd.arg(format!("-U{context_lines}"));
    if staged {
        cmd.arg("--cached");
    }
    cmd.args(["--", path]);
    cmd
}

fn untracked_diff_command(root: &str, path: &str, context_lines: u32) -> Command {
    let mut cmd = git_command(root);
    cmd.args(["diff", "--no-color", "--no-ext-diff", "--no-textconv"]);
    cmd.arg(format!("-U{context_lines}"));
    cmd.args(["--no-index", "--", "/dev/null", path]);
    cmd
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

/// Detect a merge/rebase/cherry-pick/revert/am that paused with state on disk.
///
/// One `rev-parse --git-path` call resolves all probe paths through git itself,
/// so linked worktrees (where `.git` is a file and the real git dir lives under
/// `.git/worktrees/<name>`) work without special cases. Relative results are
/// resolved against the repo root. Probe failures degrade to `None`: a status
/// poll must not fail because of this best-effort field.
async fn probe_operation(root: &str) -> Option<OperationKind> {
    let output = run(git_command(root).args([
        "rev-parse",
        "--git-path",
        "MERGE_HEAD",
        "--git-path",
        "CHERRY_PICK_HEAD",
        "--git-path",
        "REVERT_HEAD",
        "--git-path",
        "rebase-merge",
        "--git-path",
        "rebase-apply",
    ]))
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let paths: Vec<&str> = stdout.lines().collect();
    if paths.len() < 5 {
        return None;
    }
    let resolve = |raw: &str| {
        let path = Path::new(raw);
        if path.is_absolute() { path.to_path_buf() } else { Path::new(root).join(path) }
    };
    let merge = resolve(paths[0]);
    let cherry = resolve(paths[1]);
    let revert = resolve(paths[2]);
    let rebase_merge = resolve(paths[3]);
    let rebase_apply = resolve(paths[4]);

    if rebase_merge.exists() {
        return Some(OperationKind::Rebase);
    }
    if rebase_apply.exists() {
        // `rebase-apply` is shared by `git am` and rebase's apply backend;
        // only `am` creates the `applying` marker.
        if rebase_apply.join("applying").exists() {
            return Some(OperationKind::Am);
        }
        return Some(OperationKind::Rebase);
    }
    if merge.exists() {
        return Some(OperationKind::Merge);
    }
    if cherry.exists() {
        return Some(OperationKind::CherryPick);
    }
    if revert.exists() {
        return Some(OperationKind::Revert);
    }
    None
}

pub async fn status(root: &str) -> GitResult<RepoStatus> {
    let output =
        run(git_command(root).args(["status", "--porcelain=v2", "--branch", "-z"])).await?;
    ensure_success(&output)?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut st = parse_status_v2(root, &stdout);
    let conflicted = st.entries.iter().filter(|entry| entry.conflicted).count();
    st.in_progress = probe_operation(root)
        .await
        .map(|kind| InProgress { kind: kind.as_str().to_string(), conflicted });
    Ok(st)
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
        in_progress: None,
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
    context_lines: u32,
) -> GitResult<(String, bool)> {
    validate_repo_path(path)?;
    let output = if untracked {
        // Untracked files have no diff base; compare against /dev/null.
        // `--no-index` exits 1 when the files differ, which is the normal case.
        run(&mut untracked_diff_command(root, path, context_lines)).await?
    } else {
        run(&mut tracked_diff_command(root, path, staged, context_lines)).await?
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

/// Header markers that make hunk-level apply unsafe or meaningless. Such
/// diffs fall back to the file-level stage/unstage/discard buttons.
const UNSUPPORTED_DIFF_HEADER_PREFIXES: &[&str] = &[
    "new file mode ",
    "deleted file mode ",
    "rename from ",
    "rename to ",
    "copy from ",
    "copy to ",
    "similarity index ",
    "dissimilarity index ",
    "old mode ",
    "new mode ",
    "Binary files ",
    "GIT binary patch",
    "Subproject commit ",
];

fn header_is_unsupported(line: &str) -> bool {
    UNSUPPORTED_DIFF_HEADER_PREFIXES.iter().any(|prefix| line.starts_with(prefix))
        // Symlink (120000) and submodule (160000) entries are not regular
        // file content; applying a text hunk to them is undefined.
        || (line.starts_with("index ")
            && (line.trim_end().ends_with(" 120000") || line.trim_end().ends_with(" 160000")))
}

/// Split a single-file diff into apply-able hunk patches.
///
/// Returns `None` for anything hunk actions cannot handle safely: multiple
/// files, combined (conflict) diffs, binary/rename/copy/mode-only/new/deleted
/// files, symlinks/submodules, or a diff without any `@@` section. Callers
/// turn that into an empty list and the UI simply hides the buttons.
fn split_hunks(raw: &str) -> Option<Vec<HunkInfo>> {
    let lines: Vec<&str> = raw.split_inclusive('\n').collect();
    let git_headers = lines.iter().filter(|line| line.starts_with("diff --git ")).count();
    let combined = lines
        .iter()
        .any(|line| line.starts_with("diff --cc ") || line.starts_with("diff --combined "));
    if git_headers != 1 || combined {
        return None;
    }

    let first_hunk = lines.iter().position(|line| line.starts_with("@@ "))?;
    let file_header = &lines[..first_hunk];
    if file_header.iter().any(|line| header_is_unsupported(line))
        || !file_header.iter().any(|line| line.starts_with("--- "))
        || !file_header.iter().any(|line| line.starts_with("+++ "))
    {
        return None;
    }

    let mut hunks = Vec::new();
    let mut start = first_hunk;
    while start < lines.len() {
        if !lines[start].starts_with("@@ ") {
            return None;
        }
        let mut end = start + 1;
        while end < lines.len() && !lines[end].starts_with("@@ ") {
            end += 1;
        }
        let header = lines[start].trim_end_matches(['\r', '\n']).to_string();
        let mut patch = String::new();
        for line in file_header {
            patch.push_str(line);
        }
        for line in &lines[start..end] {
            patch.push_str(line);
        }
        hunks.push(HunkInfo { header, patch });
        start = end;
    }

    if hunks.is_empty() { None } else { Some(hunks) }
}

/// File diff plus the canonical hunk patches derived from it.
///
/// The diff text is still the display truth (ADR-3); `hunks` only exists to
/// drive hunk actions. Non-UTF-8 output is shown lossily but never offered as
/// an apply token — writing U+FFFD back into the index would corrupt the file.
pub async fn file_hunks(
    root: &str,
    path: &str,
    staged: bool,
    context_lines: u32,
) -> GitResult<FileHunks> {
    validate_repo_path(path)?;
    let context_lines = context_lines.clamp(1, MAX_CONTEXT_LINES);
    let output = run(&mut tracked_diff_command(root, path, staged, context_lines)).await?;
    let exit_ok = matches!(output.status.code(), Some(0) | Some(1));
    if !exit_ok {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(refine_error(stderr.trim()));
    }

    let valid_utf8 = std::str::from_utf8(&output.stdout).ok();
    let (diff, truncated) = match valid_utf8 {
        Some(text) => truncate_diff(text),
        None => truncate_diff(&String::from_utf8_lossy(&output.stdout)),
    };
    let hunks =
        if truncated { Vec::new() } else { valid_utf8.and_then(split_hunks).unwrap_or_default() };
    Ok(FileHunks { diff, truncated, context_lines, hunks })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HunkAction {
    Stage,
    Unstage,
    Revert,
}

impl HunkAction {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "stage" => Some(Self::Stage),
            "unstage" => Some(Self::Unstage),
            "revert" => Some(Self::Revert),
            _ => None,
        }
    }

    /// `stage` and `revert` operate on the working-tree diff; `unstage`
    /// operates on the staged (HEAD→index) diff.
    fn uses_staged_diff(self) -> bool {
        matches!(self, Self::Unstage)
    }
}

/// Temp patch file removed on every exit path. Kept in the system temp dir
/// per plan D2; `create_new` avoids clobbering an existing file.
struct TempPatch {
    path: PathBuf,
}

impl TempPatch {
    fn write(bytes: &[u8]) -> GitResult<Self> {
        static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);
        for _ in 0..16 {
            let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir()
                .join(format!("omniterm-hunk-{}-{n}.patch", std::process::id()));
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    use std::io::Write;
                    if let Err(e) = file.write_all(bytes) {
                        let _ = std::fs::remove_file(&path);
                        return Err(GitError::generic(format!("failed to write patch: {e}")));
                    }
                    return Ok(Self { path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => {
                    return Err(GitError::generic(format!("failed to create patch file: {e}")));
                }
            }
        }
        Err(GitError::generic("failed to create a unique patch file"))
    }
}

impl Drop for TempPatch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Apply one hunk after re-deriving the current diff and requiring the
/// submitted patch to match a current hunk verbatim (plan D2, `stale_hunk`).
pub async fn apply_hunk(
    root: &str,
    path: &str,
    action: HunkAction,
    patch: &str,
    context_lines: u32,
) -> GitResult<()> {
    validate_repo_path(path)?;
    if patch.is_empty() || patch.len() > MAX_HUNK_PATCH_BYTES {
        return Err(GitError::invalid_hunk("patch is empty or too large"));
    }
    let context_lines = context_lines.clamp(1, MAX_CONTEXT_LINES);
    let current = file_hunks(root, path, action.uses_staged_diff(), context_lines).await?;
    if current.truncated || !current.hunks.iter().any(|hunk| hunk.patch == patch) {
        return Err(GitError::stale_hunk("hunk no longer matches the current diff"));
    }

    let temp = TempPatch::write(patch.as_bytes())?;
    let apply_flags = |cmd: &mut Command| {
        cmd.arg("--whitespace=nowarn");
        match action {
            HunkAction::Stage => {
                cmd.arg("--cached");
            }
            HunkAction::Unstage => {
                cmd.args(["--cached", "--reverse"]);
            }
            HunkAction::Revert => {
                cmd.arg("--reverse");
            }
        }
        cmd.arg("--").arg(&temp.path);
    };

    let mut check = git_command(root);
    check.args(["apply", "--check"]);
    apply_flags(&mut check);
    let checked = run(&mut check).await?;
    if !checked.status.success() {
        return Err(GitError::stale_hunk(error_message(&checked)));
    }

    let mut apply = git_command(root);
    apply.arg("apply");
    apply_flags(&mut apply);
    let output = run_write(&mut apply).await?;
    if !output.status.success() {
        if is_lock_conflict(&output) {
            return Err(refine_error(&error_message(&output)));
        }
        return Err(GitError::stale_hunk(error_message(&output)));
    }
    Ok(())
}

/// Commit history, optionally scoped to one file and/or all branches.
///
/// `path` comes from the panel's file rows, so it is validated like other
/// repo-relative paths and passed after `--` with literal pathspec semantics.
pub async fn log(
    root: &str,
    skip: u32,
    limit: u32,
    path: Option<&str>,
    all: bool,
) -> GitResult<(Vec<LogEntry>, bool)> {
    if let Some(path) = path {
        validate_range_path(path)?;
    }
    let mut cmd = git_command(root);
    // Fetch one extra entry to detect whether more pages exist.
    cmd.args(["log", "--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s"]);
    if all {
        cmd.arg("--all");
    }
    cmd.arg(format!("--skip={skip}"));
    cmd.args(["-n", &format!("{}", limit + 1)]);
    if let Some(path) = path {
        cmd.env("GIT_LITERAL_PATHSPECS", "1");
        cmd.args(["--", path]);
    }
    let output = run(&mut cmd).await?;
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

    let names = run(git_command(root).args([
        "show",
        "--name-status",
        "-z",
        "-M",
        "--pretty=format:",
        &full,
    ]))
    .await?;
    ensure_success(&names)?;
    let raw_names = String::from_utf8_lossy(&names.stdout);
    let (files, files_truncated) = parse_name_status_z(&raw_names, MAX_CHANGED_FILES);

    Ok(CommitDetail {
        sha: full,
        short_sha: short,
        author,
        email,
        date,
        message,
        diff,
        truncated,
        files,
        files_truncated,
    })
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

/// Validate a base ref and resolve the merge-base it shares with HEAD.
async fn resolve_range_base(root: &str, base: &str) -> GitResult<String> {
    if base.is_empty() || base.starts_with('-') {
        return Err(GitError::invalid_base(format!("invalid base ref: {base:?}")));
    }
    let spec = format!("{base}^{{commit}}");
    let verified = run(git_command(root).args(["rev-parse", "--verify", "--quiet", &spec])).await?;
    if !verified.status.success() {
        return Err(GitError::invalid_base(format!("base ref not found: {base}")));
    }
    let sha = String::from_utf8_lossy(&verified.stdout).trim().to_string();
    if sha.is_empty() {
        return Err(GitError::invalid_base(format!("base ref not found: {base}")));
    }
    let merge_base = run(git_command(root).args(["merge-base", &sha, "HEAD"])).await?;
    let value = String::from_utf8_lossy(&merge_base.stdout).trim().to_string();
    if !merge_base.status.success() || value.is_empty() {
        return Err(GitError::no_merge_base(format!("{base} and HEAD have no common ancestor")));
    }
    Ok(value)
}

/// Parse `git diff --name-status -z` output. Rename/copy records carry the
/// source path as an extra NUL-separated field before the destination.
fn parse_name_status_z(raw: &str, cap: usize) -> (Vec<ChangedFile>, bool) {
    let mut fields = raw.split('\0');
    let mut files = Vec::new();
    let mut truncated = false;
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let letter = status.chars().next().unwrap_or('?').to_string();
        let (orig_path, path) = if status.starts_with('R') || status.starts_with('C') {
            let (Some(orig), Some(path)) = (fields.next(), fields.next()) else {
                break;
            };
            (Some(orig.to_string()), path.to_string())
        } else {
            let Some(path) = fields.next() else {
                break;
            };
            (None, path.to_string())
        };
        if path.is_empty() {
            continue;
        }
        if files.len() >= cap {
            truncated = true;
            break;
        }
        files.push(ChangedFile { path, orig_path, status: letter });
    }
    (files, truncated)
}

/// Branch comparison: merge-base, changed files and the full range diff.
/// `base` is any commit-ish; the diff is taken from the resolved merge-base to
/// HEAD (equivalent to `git diff base...HEAD`).
pub async fn range_overview(root: &str, base: &str) -> GitResult<RangeOverview> {
    let merge_base = resolve_range_base(root, base).await?;
    let range = format!("{merge_base}..HEAD");
    let names = run(git_command(root).args(["diff", "--name-status", "-z", "-M", &range])).await?;
    ensure_success(&names)?;
    let raw_names = String::from_utf8_lossy(&names.stdout);
    let (files, files_truncated) = parse_name_status_z(&raw_names, MAX_CHANGED_FILES);

    let diff_output = run(diff_command(root).args(["-M", &range])).await?;
    ensure_success(&diff_output)?;
    let raw_diff = String::from_utf8_lossy(&diff_output.stdout);
    let (diff, truncated) = truncate_diff(&raw_diff);

    Ok(RangeOverview { merge_base, files, files_truncated, diff, truncated })
}

/// Single-file diff within a branch comparison.
pub async fn range_file_diff(root: &str, base: &str, path: &str) -> GitResult<(String, bool)> {
    validate_range_path(path)?;
    let merge_base = resolve_range_base(root, base).await?;
    let range = format!("{merge_base}..HEAD");
    let output = run(diff_command(root)
        // Paths come from `--name-status`, but a filename may contain glob
        // characters; never let git treat it as a pathspec pattern.
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["-M", &range, "--", path]))
    .await?;
    ensure_success(&output)?;
    Ok(truncate_diff(&String::from_utf8_lossy(&output.stdout)))
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

async fn verify_branch(root: &str, branch: &str) -> GitResult<()> {
    if branch.is_empty() || branch.starts_with('-') {
        return Err(GitError::invalid_branch(format!("invalid branch: {branch:?}")));
    }
    let spec = format!("{branch}^{{commit}}");
    let output = run(git_command(root).args(["rev-parse", "--verify", "--quiet", &spec])).await?;
    if !output.status.success() {
        return Err(GitError::invalid_branch(format!("branch not found: {branch}")));
    }
    Ok(())
}

/// Merge `branch` into the current branch. `--no-edit` keeps the backend
/// non-interactive; a conflict leaves normal merge state for the banner.
pub async fn merge_branch(root: &str, branch: &str) -> GitResult<()> {
    verify_branch(root, branch).await?;
    if let Some(kind) = probe_operation(root).await {
        return Err(GitError::operation_in_progress(kind.as_str()));
    }
    let output =
        run_write(git_command(root).args(["merge", "--no-edit", "--no-autostash", "--", branch]))
            .await?;
    if output.status.success() {
        return Ok(());
    }
    Err(refine_error(&error_message(&output)))
}

/// Rebase the current branch onto `branch`. This rewrites history; the
/// frontend requires an explicit confirmation. No `--` separator: branch names
/// cannot start with `-` (checked by `verify_branch`) and older git versions
/// do not all accept it for rebase.
pub async fn rebase_branch(root: &str, branch: &str) -> GitResult<()> {
    verify_branch(root, branch).await?;
    if let Some(kind) = probe_operation(root).await {
        return Err(GitError::operation_in_progress(kind.as_str()));
    }
    let output = run_write(git_command(root).args(["rebase", "--no-autostash", branch])).await?;
    if output.status.success() {
        return Ok(());
    }
    Err(refine_error(&error_message(&output)))
}

async fn operation_state(root: &str) -> GitResult<(OperationKind, usize)> {
    let st = status(root).await?;
    let Some(in_progress) = st.in_progress else {
        return Err(GitError::no_operation());
    };
    let Some(kind) = OperationKind::from_str(&in_progress.kind) else {
        return Err(GitError::no_operation());
    };
    Ok((kind, in_progress.conflicted))
}

/// Continue the operation detected server-side. The client never names the
/// kind, so a stale banner cannot run the wrong command.
pub async fn operation_continue(root: &str) -> GitResult<()> {
    let (kind, conflicted) = operation_state(root).await?;
    if conflicted > 0 {
        return Err(GitError::conflict(format!(
            "{conflicted} conflicted file(s) must be resolved and staged first"
        )));
    }
    // The backend has no TTY: never let git spawn an interactive editor for
    // merge/rebase continuation commits. `true` accepts the prepared message.
    let output = run_write(
        git_command(root)
            .env("GIT_EDITOR", "true")
            .env("GIT_SEQUENCE_EDITOR", "true")
            .args([kind.cli_name(), "--continue"]),
    )
    .await?;
    if output.status.success() {
        return Ok(());
    }
    Err(refine_error(&error_message(&output)))
}

pub async fn operation_abort(root: &str) -> GitResult<()> {
    let (kind, _) = operation_state(root).await?;
    let output = run_write(git_command(root).args([kind.cli_name(), "--abort"])).await?;
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
        // Hunk patches must round-trip byte-for-byte; disable line-ending
        // conversion so CRLF fixtures behave the same on every machine.
        run_git(&root, &["config", "core.autocrlf", "false"]).await;
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
        assert_eq!(
            refine_error("error: Your local changes to the following files would be overwritten by merge:\n\ttracked.txt").code,
            "dirty_worktree"
        );
        assert_eq!(
            refine_error("error: cannot rebase: You have unstaged changes.").code,
            "dirty_worktree"
        );
        assert_eq!(
            refine_error("error: Committing is not possible because you have unmerged files.").code,
            "conflict"
        );
        assert_eq!(refine_error("error: Resolve your current index first").code, "conflict");
        assert_eq!(
            refine_error("fatal: You have not concluded your merge (MERGE_HEAD exists).").code,
            "operation_in_progress"
        );
        assert_eq!(
            refine_error("fatal: a cherry-pick or revert is in progress").code,
            "operation_in_progress"
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

    async fn read_index(root: &str, path: &str) -> String {
        let spec = format!(":{path}");
        let output = Command::new("git")
            .args(["-C", root, "show", &spec])
            .output()
            .await
            .expect("spawn git show");
        assert!(
            output.status.success(),
            "git show {spec} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    async fn commit_file(root: &str, dir: &Path, path: &str, content: &str) {
        std::fs::write(dir.join(path), content).unwrap();
        run_git(root, &["add", "--", path]).await;
        run_git(root, &["commit", "-q", "-m", "update"]).await;
    }

    fn numbered_lines(count: usize) -> String {
        (1..=count).map(|i| format!("line{i:02}\n")).collect()
    }

    #[tokio::test]
    async fn stage_hunk_only_stages_the_selected_hunk() {
        if !git_available() {
            eprintln!("SKIP stage_hunk_only_stages_the_selected_hunk: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = numbered_lines(30);
        commit_file(&root, &dir, "tracked.txt", &base).await;
        let changed = base.replace("line03", "CHANGED03").replace("line25", "CHANGED25");
        std::fs::write(dir.join("tracked.txt"), &changed).unwrap();

        let unstaged =
            file_hunks(&root, "tracked.txt", false, DEFAULT_CONTEXT_LINES).await.unwrap();
        assert_eq!(
            unstaged.hunks.len(),
            2,
            "expected two hunks, got {:?}",
            unstaged.hunks.iter().map(|h| &h.header).collect::<Vec<_>>()
        );
        apply_hunk(
            &root,
            "tracked.txt",
            HunkAction::Stage,
            &unstaged.hunks[0].patch,
            DEFAULT_CONTEXT_LINES,
        )
        .await
        .unwrap();

        let index = read_index(&root, "tracked.txt").await;
        assert!(index.contains("CHANGED03"));
        assert!(!index.contains("CHANGED25"), "second hunk must stay unstaged");
        assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), changed);

        // After staging the first hunk the remaining diff is the second hunk;
        // its header and patch must describe the partially staged state.
        let rest = file_hunks(&root, "tracked.txt", false, DEFAULT_CONTEXT_LINES).await.unwrap();
        assert_eq!(rest.hunks.len(), 1);
        assert!(rest.hunks[0].patch.contains("CHANGED25"));
        assert!(!rest.hunks[0].patch.contains("CHANGED03"));
        apply_hunk(
            &root,
            "tracked.txt",
            HunkAction::Stage,
            &rest.hunks[0].patch,
            DEFAULT_CONTEXT_LINES,
        )
        .await
        .unwrap();
        assert_eq!(read_index(&root, "tracked.txt").await, changed);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn unstage_hunk_reverts_only_that_hunk_in_the_index() {
        if !git_available() {
            eprintln!("SKIP unstage_hunk_reverts_only_that_hunk_in_the_index: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = numbered_lines(30);
        commit_file(&root, &dir, "tracked.txt", &base).await;
        let changed = base.replace("line03", "CHANGED03").replace("line25", "CHANGED25");
        std::fs::write(dir.join("tracked.txt"), &changed).unwrap();
        run_git(&root, &["add", "tracked.txt"]).await;

        let staged = file_hunks(&root, "tracked.txt", true, DEFAULT_CONTEXT_LINES).await.unwrap();
        assert_eq!(staged.hunks.len(), 2);
        apply_hunk(
            &root,
            "tracked.txt",
            HunkAction::Unstage,
            &staged.hunks[0].patch,
            DEFAULT_CONTEXT_LINES,
        )
        .await
        .unwrap();

        let index = read_index(&root, "tracked.txt").await;
        assert!(!index.contains("CHANGED03"), "first hunk should be unstaged");
        assert!(index.contains("CHANGED25"), "second hunk should stay staged");
        assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), changed);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn revert_hunk_only_touches_the_working_tree() {
        if !git_available() {
            eprintln!("SKIP revert_hunk_only_touches_the_working_tree: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = numbered_lines(30);
        commit_file(&root, &dir, "tracked.txt", &base).await;
        let changed = base.replace("line03", "CHANGED03").replace("line25", "CHANGED25");
        std::fs::write(dir.join("tracked.txt"), &changed).unwrap();

        let unstaged =
            file_hunks(&root, "tracked.txt", false, DEFAULT_CONTEXT_LINES).await.unwrap();
        assert_eq!(unstaged.hunks.len(), 2);
        apply_hunk(
            &root,
            "tracked.txt",
            HunkAction::Revert,
            &unstaged.hunks[0].patch,
            DEFAULT_CONTEXT_LINES,
        )
        .await
        .unwrap();

        let worktree = std::fs::read_to_string(dir.join("tracked.txt")).unwrap();
        assert!(!worktree.contains("CHANGED03"), "first hunk should be reverted");
        assert!(worktree.contains("CHANGED25"), "second hunk must stay");
        assert_eq!(read_index(&root, "tracked.txt").await, base, "index must not move");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn apply_hunk_rejects_a_stale_patch() {
        if !git_available() {
            eprintln!("SKIP apply_hunk_rejects_a_stale_patch: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = numbered_lines(30);
        commit_file(&root, &dir, "tracked.txt", &base).await;
        std::fs::write(
            dir.join("tracked.txt"),
            base.replace("line03", "CHANGED03").replace("line25", "CHANGED25"),
        )
        .unwrap();
        let hunks = file_hunks(&root, "tracked.txt", false, DEFAULT_CONTEXT_LINES).await.unwrap();
        let stale_patch = hunks.hunks[0].patch.clone();

        // Change the context the patch depends on.
        std::fs::write(
            dir.join("tracked.txt"),
            base.replace("line01", "EDITED01")
                .replace("line03", "CHANGED03")
                .replace("line25", "CHANGED25"),
        )
        .unwrap();

        let err = apply_hunk(
            &root,
            "tracked.txt",
            HunkAction::Stage,
            &stale_patch,
            DEFAULT_CONTEXT_LINES,
        )
        .await
        .expect_err("stale patch must be rejected");
        assert_eq!(err.code, "stale_hunk");
        assert!(read_index(&root, "tracked.txt").await.contains("line01"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn apply_hunk_rejects_empty_oversized_and_escaping_inputs() {
        if !git_available() {
            eprintln!("SKIP apply_hunk_rejects_empty_oversized_and_escaping_inputs: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let empty = apply_hunk(&root, "tracked.txt", HunkAction::Stage, "", 3).await.unwrap_err();
        assert_eq!(empty.code, "invalid_hunk");

        let oversized = "x".repeat(MAX_HUNK_PATCH_BYTES + 1);
        let err =
            apply_hunk(&root, "tracked.txt", HunkAction::Stage, &oversized, 3).await.unwrap_err();
        assert_eq!(err.code, "invalid_hunk");

        let escaping =
            apply_hunk(&root, "../outside.txt", HunkAction::Stage, "x", 3).await.unwrap_err();
        assert_eq!(escaping.code, "invalid_hunk");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn file_hunks_returns_no_hunks_for_untracked_and_binary_files() {
        if !git_available() {
            eprintln!(
                "SKIP file_hunks_returns_no_hunks_for_untracked_and_binary_files: git not found"
            );
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("new.txt"), "hello\n").unwrap();
        let untracked = file_hunks(&root, "new.txt", false, 3).await.unwrap();
        assert!(untracked.hunks.is_empty());

        std::fs::write(dir.join("tracked.txt"), b"a\0b\n").unwrap();
        let binary = file_hunks(&root, "tracked.txt", false, 3).await.unwrap();
        assert!(binary.hunks.is_empty(), "binary diffs must not expose hunks");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn file_hunks_returns_no_hunks_for_multi_file_paths() {
        if !git_available() {
            eprintln!("SKIP file_hunks_returns_no_hunks_for_multi_file_paths: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("tracked.txt"), "changed\n").unwrap();
        std::fs::write(dir.join("other.txt"), "initial\n").unwrap();
        run_git(&root, &["add", "other.txt"]).await;
        run_git(&root, &["commit", "-q", "-m", "other"]).await;
        std::fs::write(dir.join("other.txt"), "changed\n").unwrap();

        let data = file_hunks(&root, ".", false, 3).await.unwrap();
        assert!(data.hunks.is_empty(), "a directory path yields multiple files");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn split_hunks_rejects_unsupported_diff_shapes() {
        let body = "@@ -1 +1 @@\n-a\n+b\n";
        let normal =
            format!("diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n{body}");
        let hunks = split_hunks(&normal).expect("normal modifications must split");
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].header, "@@ -1 +1 @@");
        assert!(hunks[0].patch.ends_with(body));

        for marker in [
            "new file mode 100644\n",
            "deleted file mode 100644\n",
            "old mode 100644\n",
            "new mode 100755\n",
            "rename from f\nrename to g\n",
            "copy from f\ncopy to g\n",
        ] {
            let raw = format!(
                "diff --git a/f b/f\nindex 1111111..2222222 100644\n{marker}--- a/f\n+++ b/f\n{body}"
            );
            assert!(split_hunks(&raw).is_none(), "marker must be rejected: {marker:?}");
        }

        for mode in ["120000", "160000"] {
            let raw = format!(
                "diff --git a/f b/f\nindex 1111111..2222222 {mode}\n--- a/f\n+++ b/f\n{body}"
            );
            assert!(split_hunks(&raw).is_none(), "mode {mode} must be rejected");
        }

        let two = format!("{normal}{normal}");
        assert!(split_hunks(&two).is_none(), "multi-file diffs must be rejected");

        let combined = "diff --cc f\nindex 1,2..3\n--- a/f\n+++ b/f\n@@@ -1,2 -1,2 +1,2 @@@\n";
        assert!(split_hunks(combined).is_none());

        let binary =
            "diff --git a/f b/f\nindex 1111111..2222222 100644\nBinary files a/f and b/f differ\n";
        assert!(split_hunks(binary).is_none());

        let no_hunk = "diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n";
        assert!(split_hunks(no_hunk).is_none());
    }

    #[test]
    fn split_hunks_keeps_no_newline_marker_in_the_patch() {
        let raw = "diff --git a/f b/f\nindex 1111111..2222222 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n";
        let hunks = split_hunks(raw).expect("hunk with missing trailing newline must split");
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].patch.contains("\\ No newline at end of file"));
        assert_eq!(hunks[0].header, "@@ -1 +1 @@");
    }

    #[tokio::test]
    async fn hunk_patch_round_trips_crlf_and_missing_trailing_newline() {
        if !git_available() {
            eprintln!(
                "SKIP hunk_patch_round_trips_crlf_and_missing_trailing_newline: git not found"
            );
            return;
        }
        let (dir, root) = init_test_repo().await;
        commit_file(&root, &dir, "tracked.txt", "a\r\nb\r\nc\r\n").await;
        std::fs::write(dir.join("tracked.txt"), "a\r\nB\r\nc\r\n").unwrap();
        let crlf = file_hunks(&root, "tracked.txt", false, 3).await.unwrap();
        assert_eq!(crlf.hunks.len(), 1);
        assert!(crlf.hunks[0].patch.contains("\r\n"), "CRLF must be preserved");
        apply_hunk(&root, "tracked.txt", HunkAction::Stage, &crlf.hunks[0].patch, 3).await.unwrap();
        assert_eq!(read_index(&root, "tracked.txt").await, "a\r\nB\r\nc\r\n");
        run_git(&root, &["add", "tracked.txt"]).await;
        run_git(&root, &["commit", "-q", "-m", "crlf"]).await;

        commit_file(&root, &dir, "tail.txt", "x\ny").await;
        std::fs::write(dir.join("tail.txt"), "x\nY").unwrap();
        let tail = file_hunks(&root, "tail.txt", false, 3).await.unwrap();
        assert_eq!(tail.hunks.len(), 1);
        assert!(
            tail.hunks[0].patch.contains("\\ No newline at end of file"),
            "missing trailing newline marker must survive: {}",
            tail.hunks[0].patch
        );
        apply_hunk(&root, "tail.txt", HunkAction::Stage, &tail.hunks[0].patch, 3).await.unwrap();
        assert_eq!(read_index(&root, "tail.txt").await, "x\nY");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn hunk_actions_handle_paths_with_spaces_and_unicode() {
        if !git_available() {
            eprintln!("SKIP hunk_actions_handle_paths_with_spaces_and_unicode: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let path = "sp ace 文件.txt";
        let base = numbered_lines(10);
        commit_file(&root, &dir, path, &base).await;
        let changed = base.replace("line05", "CHANGED05");
        std::fs::write(dir.join(path), &changed).unwrap();

        let hunks = file_hunks(&root, path, false, 3).await.unwrap();
        assert_eq!(hunks.hunks.len(), 1);
        apply_hunk(&root, path, HunkAction::Stage, &hunks.hunks[0].patch, 3).await.unwrap();
        assert_eq!(read_index(&root, path).await, changed);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn apply_hunk_retries_when_index_lock_is_released() {
        if !git_available() {
            eprintln!("SKIP apply_hunk_retries_when_index_lock_is_released: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = numbered_lines(10);
        commit_file(&root, &dir, "tracked.txt", &base).await;
        std::fs::write(dir.join("tracked.txt"), base.replace("line05", "CHANGED05")).unwrap();
        let hunks = file_hunks(&root, "tracked.txt", false, 3).await.unwrap();
        let patch = hunks.hunks[0].patch.clone();

        let lock = dir.join(".git/index.lock");
        std::fs::write(&lock, b"").unwrap();
        let lock_clone = lock.clone();
        let remover = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            std::fs::remove_file(lock_clone).unwrap();
        });
        let result = apply_hunk(&root, "tracked.txt", HunkAction::Stage, &patch, 3).await;
        remover.join().unwrap();

        assert!(result.is_ok(), "apply should retry after the lock disappears: {result:?}");
        assert!(read_index(&root, "tracked.txt").await.contains("CHANGED05"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    async fn git_stdout(root: &str, args: &[&str]) -> String {
        let output =
            Command::new("git").args(["-C", root]).args(args).output().await.expect("spawn git");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Put the current branch and `other` on conflicting edits of tracked.txt.
    /// Returns (original branch name, other branch head sha).
    async fn make_conflicting_branches(dir: &Path, root: &str) -> (String, String) {
        let base = current_branch_name(root).await;
        run_git(root, &["checkout", "-q", "-b", "other"]).await;
        std::fs::write(dir.join("tracked.txt"), "other\n").unwrap();
        run_git(root, &["add", "."]).await;
        run_git(root, &["commit", "-q", "-m", "other edit"]).await;
        let other_sha = head_sha(root).await;
        run_git(root, &["checkout", "-q", &base]).await;
        std::fs::write(dir.join("tracked.txt"), "current\n").unwrap();
        run_git(root, &["add", "."]).await;
        run_git(root, &["commit", "-q", "-m", "current edit"]).await;
        (base, other_sha)
    }

    #[tokio::test]
    async fn status_reports_merge_conflict_and_abort_clears_it() {
        if !git_available() {
            eprintln!("SKIP status_reports_merge_conflict_and_abort_clears_it: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let _ = make_conflicting_branches(&dir, &root).await;

        let err = merge_branch(&root, "other").await.unwrap_err();
        assert_eq!(err.code, "conflict");
        let st = status(&root).await.unwrap();
        let in_progress = st.in_progress.expect("merge state must be reported");
        assert_eq!(in_progress.kind, "merge");
        assert_eq!(in_progress.conflicted, 1);

        // Starting another operation while one is paused is refused.
        let err = merge_branch(&root, "other").await.unwrap_err();
        assert_eq!(err.code, "operation_in_progress");

        operation_abort(&root).await.unwrap();
        assert!(status(&root).await.unwrap().in_progress.is_none());
        assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), "current\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn merge_continue_requires_resolution_and_creates_merge_commit() {
        if !git_available() {
            eprintln!(
                "SKIP merge_continue_requires_resolution_and_creates_merge_commit: git not found"
            );
            return;
        }
        let (dir, root) = init_test_repo().await;
        let _ = make_conflicting_branches(&dir, &root).await;
        merge_branch(&root, "other").await.unwrap_err();

        let err = operation_continue(&root).await.unwrap_err();
        assert_eq!(err.code, "conflict", "unresolved entries must block continue");

        std::fs::write(dir.join("tracked.txt"), "resolved\n").unwrap();
        run_git(&root, &["add", "tracked.txt"]).await;
        operation_continue(&root).await.unwrap();
        assert!(status(&root).await.unwrap().in_progress.is_none());
        assert!(head_subject(&root).await.starts_with("Merge branch"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn rebase_conflict_continue_produces_linear_history() {
        if !git_available() {
            eprintln!("SKIP rebase_conflict_continue_produces_linear_history: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let (base, _) = make_conflicting_branches(&dir, &root).await;
        run_git(&root, &["checkout", "-q", "other"]).await;

        let err = rebase_branch(&root, &base).await.unwrap_err();
        assert_eq!(err.code, "conflict");
        let st = status(&root).await.unwrap();
        assert_eq!(st.in_progress.expect("rebase state").kind, "rebase");

        std::fs::write(dir.join("tracked.txt"), "rebased\n").unwrap();
        run_git(&root, &["add", "tracked.txt"]).await;
        operation_continue(&root).await.unwrap();

        let st = status(&root).await.unwrap();
        assert!(st.in_progress.is_none());
        assert_eq!(st.branch.as_deref(), Some("other"));
        assert!(
            git_stdout(&root, &["log", "--merges", "--oneline"]).await.is_empty(),
            "rebase must not create merge commits"
        );
        assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), "rebased\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn rebase_abort_restores_the_branch() {
        if !git_available() {
            eprintln!("SKIP rebase_abort_restores_the_branch: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let (base, _) = make_conflicting_branches(&dir, &root).await;
        run_git(&root, &["checkout", "-q", "other"]).await;
        let before = head_sha(&root).await;

        rebase_branch(&root, &base).await.unwrap_err();
        operation_abort(&root).await.unwrap();

        assert_eq!(head_sha(&root).await, before);
        let st = status(&root).await.unwrap();
        assert!(st.in_progress.is_none());
        assert_eq!(st.branch.as_deref(), Some("other"));
        assert_eq!(std::fs::read_to_string(dir.join("tracked.txt")).unwrap(), "other\n");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn cherry_pick_conflict_reports_in_progress_and_abort_clears_it() {
        if !git_available() {
            eprintln!(
                "SKIP cherry_pick_conflict_reports_in_progress_and_abort_clears_it: git not found"
            );
            return;
        }
        let (dir, root) = init_test_repo().await;
        let (_, other_sha) = make_conflicting_branches(&dir, &root).await;

        let err = cherry_pick(&root, &other_sha).await.unwrap_err();
        assert_eq!(err.code, "conflict");
        let st = status(&root).await.unwrap();
        assert_eq!(st.in_progress.expect("cherry-pick state").kind, "cherry_pick");

        operation_abort(&root).await.unwrap();
        assert!(status(&root).await.unwrap().in_progress.is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn operation_continue_and_abort_require_an_operation() {
        if !git_available() {
            eprintln!("SKIP operation_continue_and_abort_require_an_operation: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        assert_eq!(operation_continue(&root).await.unwrap_err().code, "no_operation");
        assert_eq!(operation_abort(&root).await.unwrap_err().code, "no_operation");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn merge_and_rebase_reject_unknown_or_option_like_branches() {
        if !git_available() {
            eprintln!(
                "SKIP merge_and_rebase_reject_unknown_or_option_like_branches: git not found"
            );
            return;
        }
        let (dir, root) = init_test_repo().await;
        assert_eq!(merge_branch(&root, "missing").await.unwrap_err().code, "invalid_branch");
        assert_eq!(rebase_branch(&root, "--all").await.unwrap_err().code, "invalid_branch");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn probe_distinguishes_am_from_rebase_apply() {
        if !git_available() {
            eprintln!("SKIP probe_distinguishes_am_from_rebase_apply: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let state = dir.join(".git").join("rebase-apply");
        std::fs::create_dir_all(&state).unwrap();
        std::fs::write(state.join("applying"), b"").unwrap();
        assert_eq!(probe_operation(&root).await, Some(OperationKind::Am));

        std::fs::remove_file(state.join("applying")).unwrap();
        std::fs::write(state.join("rebasing"), b"").unwrap();
        assert_eq!(probe_operation(&root).await, Some(OperationKind::Rebase));

        std::fs::remove_dir_all(&state).unwrap();
        assert_eq!(probe_operation(&root).await, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn probe_operation_resolves_linked_worktree_git_dir() {
        if !git_available() {
            eprintln!("SKIP probe_operation_resolves_linked_worktree_git_dir: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let wt_parent = temp_dir();
        let wt_path = wt_parent.join("wt");
        let wt = wt_path.to_str().unwrap().to_string();
        run_git(&root, &["worktree", "add", "-q", "-b", "wt-branch", &wt]).await;

        assert!(status(&wt).await.unwrap().in_progress.is_none());
        let git_dir_raw = git_stdout(&wt, &["rev-parse", "--git-dir"]).await;
        let git_dir = {
            let path = Path::new(&git_dir_raw);
            if path.is_absolute() { path.to_path_buf() } else { wt_path.join(path) }
        };
        std::fs::write(git_dir.join("MERGE_HEAD"), b"deadbeef\n").unwrap();

        let st = status(&wt).await.unwrap();
        assert_eq!(st.in_progress.expect("merge state in worktree").kind, "merge");
        assert!(
            status(&root).await.unwrap().in_progress.is_none(),
            "the main worktree must not inherit the linked worktree's state"
        );

        std::fs::remove_dir_all(&wt_parent).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parse_name_status_z_handles_renames_and_caps() {
        let raw = "M\0a.txt\0R100\0old.txt\0new.txt\0A\0b.txt\0";
        let (files, truncated) = parse_name_status_z(raw, 10);
        assert!(!truncated);
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "M");
        assert_eq!(files[1].status, "R");
        assert_eq!(files[1].orig_path.as_deref(), Some("old.txt"));
        assert_eq!(files[1].path, "new.txt");
        assert_eq!(files[2].status, "A");

        let (files, truncated) = parse_name_status_z(raw, 2);
        assert!(truncated);
        assert_eq!(files.len(), 2);

        let (files, truncated) = parse_name_status_z(raw, 3);
        assert!(!truncated);
        assert_eq!(files.len(), 3);
    }

    #[tokio::test]
    async fn range_overview_reports_merge_base_files_and_diff() {
        if !git_available() {
            eprintln!("SKIP range_overview_reports_merge_base_files_and_diff: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let initial = head_sha(&root).await;
        let base_branch = current_branch_name(&root).await;
        run_git(&root, &["checkout", "-q", "-b", "feature"]).await;
        std::fs::write(dir.join("feature.txt"), "feature\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "feature commit"]).await;
        run_git(&root, &["checkout", "-q", &base_branch]).await;
        run_git(&root, &["mv", "tracked.txt", "renamed.txt"]).await;
        std::fs::write(dir.join("current.txt"), "current\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "current rename"]).await;

        let range = range_overview(&root, "feature").await.unwrap();
        assert_eq!(range.merge_base, initial);
        assert!(!range.files_truncated);
        let renamed = range.files.iter().find(|f| f.path == "renamed.txt").unwrap();
        assert_eq!(renamed.status, "R");
        assert_eq!(renamed.orig_path.as_deref(), Some("tracked.txt"));
        assert!(range.files.iter().any(|f| f.path == "current.txt" && f.status == "A"));
        assert!(
            !range.files.iter().any(|f| f.path == "feature.txt"),
            "changes on the base side of the fork must not appear"
        );
        assert!(range.diff.contains("renamed.txt"));
        assert!(!range.truncated);

        let empty = range_overview(&root, &base_branch).await.unwrap();
        assert!(empty.files.is_empty());
        assert!(empty.diff.is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn range_file_diff_scopes_to_one_path_and_rejects_escapes() {
        if !git_available() {
            eprintln!("SKIP range_file_diff_scopes_to_one_path_and_rejects_escapes: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base_branch = current_branch_name(&root).await;
        run_git(&root, &["checkout", "-q", "-b", "feature"]).await;
        run_git(&root, &["checkout", "-q", &base_branch]).await;
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "two files"]).await;

        let (diff, truncated) = range_file_diff(&root, "feature", "a.txt").await.unwrap();
        assert!(!truncated);
        assert!(diff.contains("a.txt"));
        assert!(!diff.contains("b.txt"));

        assert_eq!(
            range_file_diff(&root, "feature", "../outside.txt").await.unwrap_err().code,
            "invalid_path"
        );
        assert_eq!(
            range_file_diff(&root, "feature", "/etc/passwd").await.unwrap_err().code,
            "invalid_path"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn log_filters_by_path_and_all_branches() {
        if !git_available() {
            eprintln!("SKIP log_filters_by_path_and_all_branches: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        let base = current_branch_name(&root).await;
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "add a"]).await;
        std::fs::write(dir.join("b.txt"), "b\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "add b"]).await;
        run_git(&root, &["checkout", "-q", "-b", "feature"]).await;
        std::fs::write(dir.join("feature.txt"), "feature\n").unwrap();
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "feature only"]).await;
        run_git(&root, &["checkout", "-q", &base]).await;

        let (a_entries, has_more) = log(&root, 0, 50, Some("a.txt"), false).await.unwrap();
        assert!(!has_more);
        assert_eq!(a_entries.len(), 1);
        assert_eq!(a_entries[0].subject, "add a");

        let (base_entries, _) = log(&root, 0, 50, None, false).await.unwrap();
        assert!(
            !base_entries.iter().any(|e| e.subject == "feature only"),
            "a branch-less log must only walk HEAD"
        );

        let (all_entries, _) = log(&root, 0, 50, None, true).await.unwrap();
        assert!(all_entries.iter().any(|e| e.subject == "feature only"));

        // Path + --all: the file only exists on the feature branch.
        let (feature_entries, _) = log(&root, 0, 50, Some("feature.txt"), true).await.unwrap();
        assert_eq!(feature_entries.len(), 1);
        assert_eq!(feature_entries[0].subject, "feature only");

        assert_eq!(
            log(&root, 0, 50, Some("../outside.txt"), false).await.unwrap_err().code,
            "invalid_path"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn show_commit_lists_changed_files() {
        if !git_available() {
            eprintln!("SKIP show_commit_lists_changed_files: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        std::fs::write(dir.join("added.txt"), "new\n").unwrap();
        run_git(&root, &["mv", "tracked.txt", "renamed.txt"]).await;
        run_git(&root, &["add", "."]).await;
        run_git(&root, &["commit", "-q", "-m", "rename and add"]).await;
        let sha = head_sha(&root).await;

        let detail = show_commit(&root, &sha).await.unwrap();
        assert_eq!(detail.sha, sha);
        assert!(!detail.files_truncated);
        assert_eq!(detail.files.len(), 2);
        let added = detail.files.iter().find(|f| f.path == "added.txt").unwrap();
        assert_eq!(added.status, "A");
        let renamed = detail.files.iter().find(|f| f.path == "renamed.txt").unwrap();
        assert_eq!(renamed.status, "R");
        assert_eq!(renamed.orig_path.as_deref(), Some("tracked.txt"));
        assert!(detail.diff.contains("renamed.txt"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn range_rejects_unknown_base_and_unrelated_histories() {
        if !git_available() {
            eprintln!("SKIP range_rejects_unknown_base_and_unrelated_histories: git not found");
            return;
        }
        let (dir, root) = init_test_repo().await;
        assert_eq!(range_overview(&root, "missing").await.unwrap_err().code, "invalid_base");
        assert_eq!(range_overview(&root, "--all").await.unwrap_err().code, "invalid_base");

        let base_branch = current_branch_name(&root).await;
        run_git(&root, &["checkout", "-q", "--orphan", "orphan"]).await;
        run_git(&root, &["commit", "-q", "-m", "orphan root"]).await;
        run_git(&root, &["checkout", "-q", &base_branch]).await;
        assert_eq!(range_overview(&root, "orphan").await.unwrap_err().code, "no_merge_base");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
