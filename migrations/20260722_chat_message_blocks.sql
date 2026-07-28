-- Persist structured content blocks (tool calls, thoughts, plans, text) alongside
-- the plain-text `text`, so a refreshed ACP session restores the same rich rendering
-- instead of flattening everything to plain text. Existing rows have NULL `blocks`
-- and fall back to `text` on hydrate.
ALTER TABLE chat_messages ADD COLUMN blocks TEXT;
