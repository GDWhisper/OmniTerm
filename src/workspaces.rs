use serde::Serialize;
use sha1::{Digest, Sha1};
use std::path::Path;

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

/// Generate a deterministic workspace ID from project_id and path.
fn workspace_id(project_id: &str, path: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{}:{}", project_id, path));
    let hash = format!("{:x}", hasher.finalize());
    hash[..12].to_string()
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
