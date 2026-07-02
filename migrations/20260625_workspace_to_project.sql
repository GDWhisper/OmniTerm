-- Migration: workspaces → projects, sessions schema update
-- SQLite doesn't support RENAME COLUMN in older versions, so we rebuild tables.

-- Step 1: Create new projects table (renamed from workspaces)
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    target_id TEXT,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(target_id) REFERENCES targets(id) ON DELETE SET NULL
);

-- Step 2: Copy data from workspaces to projects
INSERT INTO projects (id, target_id, name, path, created_at)
SELECT id, target_id, name, root_path, created_at FROM workspaces;

-- Step 3: Create new sessions table with updated schema
CREATE TABLE IF NOT EXISTS sessions_new (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL DEFAULT '',
    name TEXT,
    tmux_session_name TEXT,
    hook_enabled BOOLEAN DEFAULT 0,
    hook_status TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Step 4: Copy data from sessions to sessions_new
-- workspace_path defaults to the project's path for existing sessions
INSERT INTO sessions_new (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, hook_status, created_at)
SELECT s.id, s.workspace_id, COALESCE(w.root_path, ''), s.name, s.tmux_session_name, s.hook_enabled, s.hook_status, s.created_at
FROM sessions s
LEFT JOIN workspaces w ON w.id = s.workspace_id;

-- Step 5: Drop old tables
DROP TABLE sessions;
DROP TABLE workspaces;

-- Step 6: Rename sessions_new to sessions
ALTER TABLE sessions_new RENAME TO sessions;
