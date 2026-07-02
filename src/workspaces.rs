use serde::Serialize;
use sha1::{Digest, Sha1};
use std::path::{Path, PathBuf};

use crate::git;
use crate::models::project::Project;

#[derive(Debug, Clone, Serialize)]
pub struct Workspace {
    pub id: String,
    pub project_id: String,
    pub path: String,
    pub label: String,
    pub branch: Option<String>,
    pub is_main: bool,
    pub is_git_repo: bool,
    pub is_git_worktree: bool,
}

/// Why a candidate path is considered already covered by an existing project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum CoverKind {
    /// new_path's canonical form is byte-identical to an existing project's path
    ExactPath,
    /// new_path is a git worktree of an existing project (or vice versa: the
    /// existing project is a worktree of new_path's toplevel). Discovered by
    /// `git worktree list` on the existing project's path.
    WorktreeChild,
}

/// Generate a deterministic workspace ID from project_id and path.
fn workspace_id(project_id: &str, path: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{}:{}", project_id, path));
    let hash = format!("{:x}", hasher.finalize());
    hash[..12].to_string()
}

/// Canonicalize a path for comparison. Returns `None` if the path does not exist.
fn canonical(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// Find an existing project that already covers `new_path`.
///
/// "Covers" means either:
/// - the canonical form of `new_path` matches the canonical form of an existing
///   project's path (`ExactPath`), or
/// - `new_path` is part of an existing project's git worktree set
///   (`WorktreeChild`). This is symmetric: a worktree's `git worktree list`
///   output includes the main repo, so it works in both directions.
///
/// Returns the first matching project. None if no project covers the path.
pub async fn find_covering_project(
    new_path: &Path,
    projects: &[Project],
) -> anyhow::Result<Option<(Project, CoverKind)>> {
    let new_canon = match canonical(new_path) {
        Some(p) => p,
        None => return Ok(None), // path doesn't exist yet — can't be covered
    };

    for project in projects {
        let proj_canon = match canonical(Path::new(&project.path)) {
            Some(p) => p,
            None => continue, // existing project path is broken — skip
        };

        if proj_canon == new_canon {
            return Ok(Some((project.clone(), CoverKind::ExactPath)));
        }

        // If the existing project is a git repo, check its worktree set.
        // Skip the call if we know the project isn't a git repo.
        if !git::is_git_repo(&project.path).await {
            continue;
        }

        match git::discover_worktrees(&project.path).await {
            Ok(worktrees) => {
                for wt in worktrees {
                    if let Some(wt_canon) = canonical(Path::new(&wt.path)) {
                        if wt_canon == new_canon {
                            return Ok(Some((project.clone(), CoverKind::WorktreeChild)));
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    "failed to list worktrees for project {} ({}); skipping coverage check for it",
                    project.path,
                    e
                );
            }
        }
    }

    Ok(None)
}

/// List all workspaces for a project.
/// If the project path is a git repo, discovers worktrees.
/// Otherwise, returns a single workspace (the project path itself).
pub async fn list_workspaces(project: &Project) -> Vec<Workspace> {
    let is_git = git::is_git_repo(&project.path).await;
    if !is_git {
        return vec![single_workspace(project, false)];
    }

    let worktrees = match git::discover_worktrees(&project.path).await {
        Ok(wt) => wt,
        Err(e) => {
            tracing::warn!("failed to discover worktrees for {}: {}", project.path, e);
            return vec![single_workspace(project, true)];
        }
    };

    if worktrees.is_empty() {
        return vec![single_workspace(project, true)];
    }

    worktrees
        .into_iter()
        .map(|w| {
            let leaf_name = Path::new(&w.path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| w.path.clone());

            let label = w
                .branch
                .clone()
                .unwrap_or_else(|| {
                    if w.detached {
                        "detached".to_string()
                    } else {
                        leaf_name
                    }
                });

            Workspace {
                id: workspace_id(&project.id, &w.path),
                project_id: project.id.clone(),
                path: w.path.clone(),
                label,
                branch: w.branch,
                is_main: w.path == project.path,
                is_git_repo: true,
                is_git_worktree: true,
            }
        })
        .collect()
}

fn single_workspace(project: &Project, is_git: bool) -> Workspace {
    Workspace {
        id: workspace_id(&project.id, &project.path),
        project_id: project.id.clone(),
        path: project.path.clone(),
        label: project.name.clone(),
        branch: None,
        is_main: true,
        is_git_repo: is_git,
        is_git_worktree: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// Create a unique temporary directory for a test, with a git repo
    /// initialized and a baseline commit on `main`. Returns the toplevel path.
    async fn make_git_repo(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omniterm-test-{}-{}-{}",
            label,
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");

        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(&dir)
                .env("GIT_AUTHOR_NAME", "test")
                .env("GIT_AUTHOR_EMAIL", "test@test")
                .env("GIT_COMMITTER_NAME", "test")
                .env("GIT_COMMITTER_EMAIL", "test@test")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .output()
                .expect("git command")
        };

        run(&["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("README.md"), "init").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);

        dir
    }

    /// Add a worktree to an existing repo on a new branch.
    async fn add_worktree(repo: &Path, branch: &str, target: &Path) {
        let status = Command::new("git")
            .args([
                "-C",
                repo.to_str().unwrap(),
                "worktree",
                "add",
                "-b",
                branch,
                target.to_str().unwrap(),
            ])
            .env("GIT_AUTHOR_NAME", "test")
            .env("GIT_AUTHOR_EMAIL", "test@test")
            .env("GIT_COMMITTER_NAME", "test")
            .env("GIT_COMMITTER_EMAIL", "test@test")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .status()
            .expect("git worktree add");
        assert!(status.success(), "git worktree add failed");
    }

    /// Best-effort cleanup; failures here are tolerable because /tmp is ephemeral.
    fn cleanup(path: &Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    fn dummy_project(id: &str, path: &str) -> Project {
        Project {
            id: id.to_string(),
            target_id: None,
            name: id.to_string(),
            path: path.to_string(),
            created_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn empty_projects_returns_none() {
        let dir = std::env::temp_dir().join("omniterm-empty-projects");
        std::fs::create_dir_all(&dir).unwrap();
        let result = find_covering_project(&dir, &[]).await.unwrap();
        assert!(result.is_none());
        cleanup(&dir);
    }

    #[tokio::test]
    async fn nonexistent_new_path_returns_none() {
        let projects = vec![dummy_project("p1", "/tmp/some-real-path")];
        let result = find_covering_project(Path::new("/tmp/does-not-exist-xyz-123"), &projects)
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn exact_path_match_detected() {
        let repo = make_git_repo("exact").await;
        let repo_str = repo.to_str().unwrap().to_string();
        let projects = vec![dummy_project("p1", &repo_str)];

        let result = find_covering_project(&repo, &projects).await.unwrap();
        assert!(matches!(
            result,
            Some((_, CoverKind::ExactPath))
        ));
        cleanup(&repo);
    }

    #[tokio::test]
    async fn worktree_of_existing_toplevel_detected() {
        let repo = make_git_repo("wt-child").await;
        let wt = repo.join("worktree-feat");
        std::fs::create_dir_all(&wt).unwrap();
        let wt = std::fs::canonicalize(&wt).unwrap();
        add_worktree(&repo, "feat", &wt).await;

        let projects = vec![dummy_project("p1", repo.to_str().unwrap())];
        let result = find_covering_project(&wt, &projects).await.unwrap();
        assert!(
            matches!(result, Some((_, CoverKind::WorktreeChild))),
            "expected WorktreeChild, got {:?}",
            result
        );
        cleanup(&repo);
        cleanup(&wt);
    }

    #[tokio::test]
    async fn toplevel_of_existing_worktree_detected() {
        // Symmetric case: existing project is a worktree, candidate is the
        // toplevel. `git worktree list` from the worktree returns the
        // toplevel, so the function should still detect the cover.
        let repo = make_git_repo("wt-parent").await;
        let wt = repo.join("worktree-feat");
        std::fs::create_dir_all(&wt).unwrap();
        let wt = std::fs::canonicalize(&wt).unwrap();
        add_worktree(&repo, "feat", &wt).await;

        let projects = vec![dummy_project("p1", wt.to_str().unwrap())];
        let result = find_covering_project(&repo, &projects).await.unwrap();
        assert!(
            matches!(result, Some((_, CoverKind::WorktreeChild))),
            "expected WorktreeChild, got {:?}",
            result
        );
        cleanup(&repo);
        cleanup(&wt);
    }

    #[tokio::test]
    async fn unrelated_git_repos_returns_none() {
        let repo_a = make_git_repo("unrel-a").await;
        let repo_b = make_git_repo("unrel-b").await;
        let projects = vec![dummy_project("p_a", repo_a.to_str().unwrap())];
        let result = find_covering_project(&repo_b, &projects).await.unwrap();
        assert!(result.is_none(), "got {:?}", result);
        cleanup(&repo_a);
        cleanup(&repo_b);
    }

    #[tokio::test]
    async fn non_git_project_skips_worktree_check() {
        // Non-git project path; function should still work (no worktree call)
        // and return None for an unrelated new path.
        let dir = std::env::temp_dir().join("omniterm-non-git-proj");
        std::fs::create_dir_all(&dir).unwrap();

        let other = std::env::temp_dir().join("omniterm-non-git-other");
        std::fs::create_dir_all(&other).unwrap();

        let projects = vec![dummy_project("p1", dir.to_str().unwrap())];
        let result = find_covering_project(&other, &projects).await.unwrap();
        assert!(result.is_none());

        cleanup(&dir);
        cleanup(&other);
    }

    #[tokio::test]
    async fn symlink_path_canonicalized_to_match() {
        let repo = make_git_repo("symlink").await;
        // Use a stable sibling dir for the symlink so canonicalize resolves it
        let link_dir = std::env::temp_dir().join(format!(
            "omniterm-symlink-link-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&link_dir).unwrap();
        let link = link_dir.join("link-to-repo");
        std::os::unix::fs::symlink(&repo, &link).unwrap();

        let projects = vec![dummy_project("p1", repo.to_str().unwrap())];
        let result = find_covering_project(&link, &projects).await.unwrap();
        assert!(
            matches!(result, Some((_, CoverKind::ExactPath))),
            "expected ExactPath via symlink, got {:?}",
            result
        );

        cleanup(&repo);
        cleanup(&link_dir);
    }

    #[tokio::test]
    async fn broken_existing_project_path_is_skipped() {
        // Existing project with a non-existent path should not crash the loop.
        let dir = std::env::temp_dir().join("omniterm-broken-proj-target");
        std::fs::create_dir_all(&dir).unwrap();
        let projects = vec![dummy_project("broken", "/tmp/omniterm-truly-missing-xyz")];
        let result = find_covering_project(&dir, &projects).await.unwrap();
        assert!(result.is_none());
        cleanup(&dir);
    }
}
