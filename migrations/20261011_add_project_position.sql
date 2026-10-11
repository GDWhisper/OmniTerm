-- Migration: explicit ordering column for projects (sidebar drag-to-reorder).
-- Display order moves from `created_at DESC` to `position ASC`. Backfill keeps
-- the existing order: position 0 = newest project. created_at has second
-- granularity (bulk creates collide), so rowid breaks ties deterministically —
-- without it the backfill itself would be nondeterministic.
ALTER TABLE projects ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

UPDATE projects SET position = (
    SELECT COUNT(*) FROM projects p2
    WHERE p2.created_at > projects.created_at
       OR (p2.created_at = projects.created_at AND p2.rowid < projects.rowid)
);
