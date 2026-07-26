-- Seed built-in agent presets for first-run experience.
-- Uses INSERT OR IGNORE so re-running is idempotent.
INSERT OR IGNORE INTO agents (id, display_name, command, args, env, created_at, updated_at)
VALUES
  ('preset-claude', 'Claude Code', 'claude-agent-acp', '[]', '[]', datetime('now'), datetime('now')),
  ('preset-codex', 'Codex', 'codex-acp', '[]', '[]', datetime('now'), datetime('now')),
  ('preset-gemini', 'Gemini CLI', 'gemini', '["--experimental-acp"]', '[]', datetime('now'), datetime('now')),
  ('preset-opencode', 'OpenCode', 'opencode', '["acp"]', '[]', datetime('now'), datetime('now')),
  ('preset-qwen', 'Qwen Code', 'qwen', '["--experimental-acp"]', '[]', datetime('now'), datetime('now')),
  ('preset-kiro', 'Kiro', 'kiro-cli', '["acp"]', '[]', datetime('now'), datetime('now'));
