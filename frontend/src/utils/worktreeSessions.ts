import type { Session, Workspace } from '../api/client'

// Filter sessions for a specific worktree.
// "Orphan" sessions (whose workspace_path doesn't match any worktree)
// are shown under the main worktree (or first worktree) so that
// adopted external sessions remain visible even when their CWD
// doesn't correspond to a known worktree path.
export function sessionsForWorktree(allSessions: Session[], worktreeList: Workspace[], wtPath: string): Session[] {
  // Sessions that exactly match this worktree
  const exactMatches = allSessions.filter(s => s.workspace_path === wtPath)

  // For the primary worktree, also include sessions that don't match
  // any worktree (e.g. adopted external sessions whose tmux CWD is
  // outside the project's worktree paths).
  const primaryWt = worktreeList.find(w => w.is_main) || worktreeList[0]
  if (primaryWt && wtPath === primaryWt.path) {
    const matchedPaths = new Set(worktreeList.map(w => w.path))
    const orphans = allSessions.filter(s => !matchedPaths.has(s.workspace_path))
    return [...exactMatches, ...orphans]
  }

  return exactMatches
}
