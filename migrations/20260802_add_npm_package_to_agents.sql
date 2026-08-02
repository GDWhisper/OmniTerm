-- Optional npm package name for agents distributed via npm.
-- When set, OmniTerm resolves the binary from PATH first, then falls back
-- to auto-installing into ~/.omniterm/agents/ on first use.
ALTER TABLE agents ADD COLUMN npm_package TEXT;
