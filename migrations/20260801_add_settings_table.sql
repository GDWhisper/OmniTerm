-- Global key-value settings table.
-- auth_enabled: password verification master switch.
--   '1' = all API routes require a valid JWT (default for existing installs)
--   '0' = no auth (fresh installs start unprotected; user opts in via Settings)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('auth_enabled', '0')
    ON CONFLICT(key) DO NOTHING;

-- Upgrade protection: installs that already have a password (users row)
-- keep auth enabled. A silent downgrade to no-auth would expose the host.
UPDATE settings SET value = '1'
    WHERE key = 'auth_enabled' AND value = '0'
      AND EXISTS (SELECT 1 FROM users);
