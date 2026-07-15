-- Agents registry for ACP runtime.
-- Each row describes how to spawn an ACP-compatible agent process
-- (Claude Code, Gemini CLI, Codex CLI, custom). The API key is stored
-- plaintext in Phase 3; Phase 5 will migrate it to a system keychain.
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '[]',
    env TEXT NOT NULL DEFAULT '[]',
    api_key_env_var TEXT,
    api_key_value TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Link sessions to the agent that spawned them (ACP sessions only).
-- Application layer enforces: runtime_kind='acp' implies agent_id IS NOT NULL.
ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agents(id);
