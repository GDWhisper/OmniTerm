-- Add a customizable username for the single account (default 'admin').
-- Existing databases (already set up) automatically get 'admin', so old API
-- callers that omit `username` keep working unchanged; login compares against
-- the stored value.
ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT 'admin';
