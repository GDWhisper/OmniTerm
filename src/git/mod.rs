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
    let Ok(output) = Command::new("git")
        .args(["-C", path, "rev-parse", "--is-inside-work-tree"])
        .output()
        .await
    else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout).trim() == "true"
}

/// Discover all git worktrees for the repository at the given path.
/// Runs `git worktree list --porcelain` and parses the output.
pub async fn discover_worktrees(path: &str) -> anyhow::Result<Vec<WorktreeInfo>> {
    let output = Command::new("git")
        .args(["-C", path, "worktree", "list", "--porcelain"])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("git worktree list failed: {}", stderr);
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(parse_worktree_list(&stdout))
}

fn parse_worktree_list(raw: &str) -> Vec<WorktreeInfo> {
    raw.trim()
        .split("\n\n")
        .filter(|chunk| !chunk.is_empty())
        .filter_map(|chunk| {
            let mut info = WorktreeInfo {
                path: String::new(),
                branch: None,
                bare: false,
                detached: false,
            };
            for line in chunk.lines() {
                let mut parts = line.splitn(2, ' ');
                let key = parts.next().unwrap_or("");
                let value = parts.next().unwrap_or("").trim();
                match key {
                    "worktree" => info.path = value.to_string(),
                    "branch" => {
                        info.branch = Some(value.strip_prefix("refs/heads/").unwrap_or(value).to_string());
                    }
                    "bare" => info.bare = true,
                    "detached" => info.detached = true,
                    _ => {}
                }
            }
            if info.path.is_empty() {
                None
            } else {
                Some(info)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
