-- Backend-authoritative streaming persistence for ACP assistant turns.
-- `status` distinguishes an in-progress turn ('streaming', debounce-upserted live
-- by the backend turn accumulator) from a finalized turn ('complete'). `last_seq`
-- records the monotonic per-client notification sequence folded into the row at the
-- last write, so a reconnecting client can drop already-persisted frames and stitch
-- subsequent live frames onto the same turn without gaps or duplication.
-- Existing rows default to 'complete' with NULL last_seq (they are already finalized).
ALTER TABLE chat_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE chat_messages ADD COLUMN last_seq INTEGER;
