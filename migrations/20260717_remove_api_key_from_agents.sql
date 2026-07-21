-- Drop the Phase-3 api_key fields from agents. OmniTerm only spawns the
-- agent process and speaks ACP over its stdio; credential management is
-- the agent's own responsibility. Users who still want to inject env vars
-- can do so via the generic `env` JSON column.
ALTER TABLE agents DROP COLUMN api_key_env_var;
ALTER TABLE agents DROP COLUMN api_key_value;
