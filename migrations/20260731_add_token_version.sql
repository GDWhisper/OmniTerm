-- Add token_version to users for session revocation.
-- Incremented on login/logout/password-change; JWT claims carry the version
-- so tokens issued before the revocation are rejected at verification.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;
