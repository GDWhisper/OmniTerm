-- Chat message history for ACP sessions.
-- Stores complete messages (not chunks): user messages on send, assistant
-- messages on prompt_done. System messages (tool activity, mode chips) are
-- ephemeral and not persisted.
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_chat_messages_session ON chat_messages(session_id, created_at);
