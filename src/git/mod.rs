pub mod repo;

use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
}

/// Check if the given path is inside a git work tree.
pub async fn is_git_repo(path: &str) -> bool {
    let Ok(output) =
        Command::new("git").args(["-C", path, "rev-parse", "--is-inside-work-tree"]).output().await
    else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout).trim() == "true"
}

/// Initialize a git repository at `path` and create an initial commit.
///
/// Needed when a project directory isn't a git repo yet but the user wants
/// to create worktrees. `git worktree add` technically works on an empty
/// repo (git infers `--orphan`), but the resulting worktree would contain
/// none of the project files — so we do the standard thing: `git init`,
/// stage everything, and commit. Uses a local (repo-scoped) identity if the
/// user has no global `user.name`/`user.email`, never touching the global
/// config. No-op when the path is already a git repo with commits.
pub async fn init_repo(path: &str) -> anyhow::Result<()> {
    // git init is idempotent on an existing repo.
    let init = Command::new("git").args(["-C", path, "init"]).output().await?;
    if !init.status.success() {
        let stderr = String::from_utf8_lossy(&init.stderr);
        anyhow::bail!("git init failed: {}", stderr.trim());
    }

    // If the repo already has a HEAD, there's nothing to initialize.
    let head =
        Command::new("git").args(["-C", path, "rev-parse", "--verify", "HEAD"]).output().await?;
    if head.status.success() {
        return Ok(());
    }

    // `git commit` aborts without an identity. Prefer the user's existing
    // (global or local) config; only fall back to a repo-scoped identity so
    // the initial commit succeeds without mutating the user's global config.
    for key in ["user.name", "user.email"] {
        let probe = Command::new("git").args(["-C", path, "config", key]).output().await?;
        let missing = !probe.status.success() || probe.stdout.is_empty();
        if missing {
            let fallback = if key == "user.name" { "omniterm" } else { "omniterm@localhost" };
            let set =
                Command::new("git").args(["-C", path, "config", key, fallback]).output().await?;
            if !set.status.success() {
                let stderr = String::from_utf8_lossy(&set.stderr);
                anyhow::bail!("git config {} failed: {}", key, stderr.trim());
            }
        }
    }

    let add = Command::new("git").args(["-C", path, "add", "-A"]).output().await?;
    if !add.status.success() {
        let stderr = String::from_utf8_lossy(&add.stderr);
        anyhow::bail!("git add failed: {}", stderr.trim());
    }

    // --allow-empty handles a directory with no trackable files (e.g. only
    // ignored files) so the repo still gets a usable HEAD for worktrees.
    let commit = Command::new("git")
        .args(["-C", path, "commit", "--allow-empty", "-m", "Initial commit"])
        .output()
        .await?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        anyhow::bail!("git commit failed: {}", stderr.trim());
    }

    Ok(())
}

/// Discover all git worktrees for the repository at the given path.
/// Runs `git worktree list --porcelain` and parses the output.
pub async fn discover_worktrees(path: &str) -> anyhow::Result<Vec<WorktreeInfo>> {
    let output =
        Command::new("git").args(["-C", path, "worktree", "list", "--porcelain"]).output().await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git worktree list failed: {}", stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_worktree_list(&stdout))
}

/// Get the current branch name at `repo_path`.
pub async fn current_branch(repo_path: &str) -> anyhow::Result<String> {
    let output = Command::new("git")
        .args(["-C", repo_path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git rev-parse failed: {}", stderr.trim());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// List all local branches in the repository at `repo_path`.
/// Runs `git branch --format='%(refname:short)'`.
pub async fn list_branches(repo_path: &str) -> anyhow::Result<Vec<String>> {
    let output = Command::new("git")
        .args(["-C", repo_path, "branch", "--format=%(refname:short)"])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git branch failed: {}", stderr.trim());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

/// Remove a git worktree at `target_path`.
/// Uses `--force` to skip the uncommitted-changes check (the user has
/// already confirmed the irreversible action in the frontend).
pub async fn remove_worktree(repo_path: &str, target_path: &str) -> anyhow::Result<()> {
    let output = Command::new("git")
        .args(["-C", repo_path, "worktree", "remove", "--force", target_path])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git worktree remove failed: {}", stderr.trim());
    }

    Ok(())
}

/// Add a new git worktree to the repository at `repo_path`.
/// Runs `git worktree add -b <branch> <target_path> [base]`.
pub async fn add_worktree(
    repo_path: &str,
    branch: &str,
    target_path: &str,
    base: Option<&str>,
    detach: bool,
) -> anyhow::Result<()> {
    let mut args: Vec<&str> = vec!["-C", repo_path, "worktree", "add"];

    if detach {
        args.push("--detach");
    }

    args.push("-b");
    args.push(branch);
    args.push(target_path);

    if let Some(base_ref) = base {
        args.push(base_ref);
    }

    let output = Command::new("git").args(&args).output().await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git worktree add failed: {}", stderr.trim());
    }

    Ok(())
}

fn parse_worktree_list(raw: &str) -> Vec<WorktreeInfo> {
    raw.trim()
        .split("\n\n")
        .filter(|chunk| !chunk.is_empty())
        .filter_map(|chunk| {
            let mut info =
                WorktreeInfo { path: String::new(), branch: None, bare: false, detached: false };
            for line in chunk.lines() {
                let mut parts = line.splitn(2, ' ');
                let key = parts.next().unwrap_or("");
                let value = parts.next().unwrap_or("").trim();
                match key {
                    "worktree" => info.path = value.to_string(),
                    "branch" => {
                        info.branch =
                            Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string());
                    }
                    "bare" => info.bare = true,
                    "detached" => info.detached = true,
                    _ => {}
                }
            }
            if info.path.is_empty() { None } else { Some(info) }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TMP_COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Create a fresh empty directory under the system temp dir for tests
    /// that need to run real git commands.
    fn temp_dir() -> std::path::PathBuf {
        let n = TMP_COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("omniterm-git-test-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn test_init_repo_creates_head() {
        let dir = temp_dir();
        init_repo(dir.to_str().unwrap()).await.unwrap();
        assert!(is_git_repo(dir.to_str().unwrap()).await);
        let output = Command::new("git")
            .args(["-C", dir.to_str().unwrap(), "rev-parse", "--verify", "HEAD"])
            .output()
            .await
            .unwrap();
        assert!(output.status.success(), "HEAD should exist after init_repo");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn test_init_repo_stages_existing_files() {
        let dir = temp_dir();
        std::fs::write(dir.join("hello.txt"), "world").unwrap();
        init_repo(dir.to_str().unwrap()).await.unwrap();
        // The staged file should be committed, so it shows up in `git ls-files`.
        let output = Command::new("git")
            .args(["-C", dir.to_str().unwrap(), "ls-files"])
            .output()
            .await
            .unwrap();
        let files = String::from_utf8_lossy(&output.stdout);
        assert!(files.contains("hello.txt"), "existing file should be committed");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn test_init_repo_idempotent_on_existing_repo() {
        let dir = temp_dir();
        init_repo(dir.to_str().unwrap()).await.unwrap();
        let first_head = Command::new("git")
            .args(["-C", dir.to_str().unwrap(), "rev-parse", "HEAD"])
            .output()
            .await
            .unwrap();
        let first = String::from_utf8_lossy(&first_head.stdout).to_string();

        // Second call should be a no-op and keep the same HEAD.
        init_repo(dir.to_str().unwrap()).await.unwrap();
        let second_head = Command::new("git")
            .args(["-C", dir.to_str().unwrap(), "rev-parse", "HEAD"])
            .output()
            .await
            .unwrap();
        let second = String::from_utf8_lossy(&second_head.stdout).to_string();
        assert_eq!(first, second, "init_repo must not create a second commit");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn test_parse_worktree_list_single() {
        let input = "worktree /home/user/repo\nHEAD abc123\nbranch refs/heads/main\n";
        let result = parse_worktree_list(input);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].path, "/home/user/repo");
        assert_eq!(result[0].branch.as_deref(), Some("main"));
        assert!(!result[0].bare);
        assert!(!result[0].detached);
    }

    #[test]
    fn test_parse_worktree_list_multiple() {
        let input = "\
worktree /home/user/repo
HEAD abc123
branch refs/heads/main

worktree /home/user/repo-dev
HEAD def456
branch refs/heads/dev

worktree /home/user/repo-feature
HEAD ghi789
detached
";
        let result = parse_worktree_list(input);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].branch.as_deref(), Some("main"));
        assert_eq!(result[1].branch.as_deref(), Some("dev"));
        assert!(result[2].detached);
        assert_eq!(result[2].branch, None);
    }
}
