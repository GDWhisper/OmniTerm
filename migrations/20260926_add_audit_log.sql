-- Security audit log (S5): who-did-what-when trail for sensitive actions.
-- Only low-frequency high-risk operations are recorded: file write/delete/upload,
-- git push, agent config create/update/delete, and first access to a proxy port.
-- Read operations are deliberately NOT audited (write amplification on hot paths,
-- and read trails add no value to a post-incident investigation).
--
-- actor  : caller identity. OmniTerm is a single-user tool (JWT `sub` is always
--          "admin"), so the discriminating information is the source IP plus the
--          session/workspace context; the writer persists all of them together.
--          Format "<actor>@<ip or ->", e.g. "admin@192.168.1.7".
-- action : stable action enum, never raw user input (see `AuditAction` in
--          src/api/audit.rs). The UI groups by it, so do not overload it with
--          free text.
-- target : the object acted upon (path / agent id / port), truncated to
--          MAX_AUDIT_TARGET_BYTES by the writer.
-- scope : which session/workspace/project the action was bound to
--          ("session:<id>" / "workspace:<id>" / "project:<id>").
--          Separated from `target` because the binding id is stable while the
--          target path can move (worktree moved, session cwd drifted), and
--          because "which workspace was touched" is the first question in an
--          incident. NULL = the request had no explicit binding.
-- detail_json : extra context (e.g. uploaded file names, allow_escape flag).
--          NULL when there is none. Truncated to MAX_AUDIT_DETAIL_BYTES with an
--          explicit omission marker (see the §P1 bounds in src/api/audit.rs).
-- created_at : RFC3339 UTC timestamp, consistent with every other *_at column.
--
-- Boundedness (P1): MAX_AUDIT_ROWS is enforced by the writer rolling off the
-- oldest row after each insert; both constants and their over-limit strategies
-- live in src/api/audit.rs (they are policy, not schema).
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    scope TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL
);

-- Read path is "most recent N" ordered by created_at DESC; the id tiebreaker
-- keeps same-timestamp rows deterministic (multiple actions can land in the
-- same second, and created_at alone is not a total order — same lesson as
-- chat_persistence' two-part MessageCursor).
CREATE INDEX idx_audit_log_created ON audit_log(created_at DESC, id DESC);
