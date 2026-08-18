//! Backend-authoritative accumulation of an in-progress ACP assistant turn.
//!
//! The reliability problem this solves: assistant streaming content (thoughts,
//! tool cards, plans) used to live only in the browser's zustand store and was
//! persisted by the frontend after `prompt_done`. Refreshing mid-turn lost the
//! current turn entirely. The accumulator moves the source of truth to the backend:
//! it is fed from the `AcpClient` notification callback (which runs on the ACP
//! connection task, independent of any WebSocket), so a turn keeps being persisted
//! even with zero WS clients connected.
//!
//! Storage strategy — **raw single-turn frames, not re-classified blocks**. The
//! accumulator stores the raw `SessionUpdate` payloads of the active turn (bounded to
//! one turn) as a JSON wrapper `{"v":1,"frames":[...]}` in the streaming row's `blocks`
//! column. On refresh/reconnect the frontend re-runs its existing classifier over these
//! frames, guaranteeing identical rendering with zero duplication of the (large,
//! multi-implementation) classification logic in Rust.
//!
//! **Frame retention is bounded on two axes** — frame count ([`MAX_FRAMES`]) *and*
//! bytes ([`MAX_BLOCKS_BYTES`], plus a per-frame cap [`MAX_FRAME_BYTES`]). Long agent
//! turns emit a high rate of raw notifications (thought/tool chunks can exceed tens of
//! thousands per turn), and a frame count cap alone only bounds the column when frames
//! are small — which is not something we get to assume (see the byte-cap docs). The
//! accumulator keeps only the most recent window for mid-turn crash recovery —
//! `text` accumulates the agent message text under its own byte cap ([`MAX_TEXT_BYTES`],
//! head + tail with an explicit omission marker), and the frontend writes back
//! its complete structured blocks on `sync` — so memory, flush cost and the `blocks`
//! column stay bounded instead of growing quadratically over a long turn.
//!
//! Writes are debounced: the fold path only flags dirty and pings a dedicated writer
//! task, which coalesces bursts (trailing debounce + max-latency cap) so a high chunk
//! rate maps to a few SQLite writes per second.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1::{ContentBlock, SessionNotification, SessionUpdate};
use serde::Serialize;
use serde_json::value::RawValue;
use sqlx::SqlitePool;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::acp::chat_persistence;

/// Trailing debounce: flush after this idle gap since the last fold.
const DEBOUNCE: Duration = Duration::from_millis(250);
/// Max latency cap: never let a steady stream go unpersisted longer than this.
const MAX_LATENCY: Duration = Duration::from_millis(1000);
/// Writer command channel depth (folds only ever send the cheap `Flush` ping).
const WRITER_CHANNEL_CAPACITY: usize = 256;

/// blocks-column wrapper version for raw-frame turns (see module docs).
const RAW_FRAMES_VERSION: u64 = 1;

/// Bounded retention window for raw frames. Long turns can emit tens of thousands of
/// notifications; keeping all of them makes flush (full re-serialization) and the
/// `blocks` column grow quadratically. Only the most recent [`MAX_FRAMES`] frames are
/// kept for mid-turn recovery — the prose lives in `text` (bounded separately by
/// [`MAX_TEXT_BYTES`]), full structure comes back from the frontend's `sync` after the
/// turn ends.
///
/// This axis bounds *decode CPU* (the frontend re-classifies every retained frame on
/// hydrate), while [`MAX_BLOCKS_BYTES`] bounds I/O. Both are needed: 2000 tiny frames
/// and 28 fat ones cost the same bytes but very different classification work.
const MAX_FRAMES: usize = 2000;

/// Byte budget for the retained window — the axis that actually bounds the `blocks`
/// column. A frame-count cap only bounds bytes if frames are small, and frame size is
/// decided by the agent, not by us (AGENTS.md §8): codebuddy emits one
/// `tool_call_update` per streamed character yet re-sends the tool's **complete**
/// `rawInput` in every one of them — measured 4.5KB/frame median, so a 2000-frame
/// window became a 8.7MB single row (>97% of it duplicate copies of one `rawInput`),
/// which made `GET /messages` ship 15MB and stall ACP session switching for ~0.5s.
/// Budgeting bytes instead makes low-information frames earn fewer slots automatically,
/// so the column stays constant-order for any agent behaviour.
///
/// Trade-off: with fat frames the structural recovery window shrinks to a few dozen
/// frames. Acceptable because `text` keeps the prose (bounded, head + tail) — but only
/// because the frontend *uses* it: hydrate/`turn_snapshot` decode prepends the evicted
/// prose prefix recovered from the full `text` (exact-suffix guard), and a connection
/// that joined mid-turn skips its cooked write-back so these window remnants are never
/// persisted as cooked (see `useAcpChat` `prependEvictedProse` / `joinedMidTurn`, and
/// the 2026-08-10 plan errata 2026-08-19). Evicted *structure* (thought/tool cards) is
/// still unrecoverable mid-turn by design — the window is crash recovery, not archive.
const MAX_BLOCKS_BYTES: usize = 128 * 1024;

/// Per-frame cap: a frame larger than this never enters the window (its text, if any,
/// is still accumulated into `text`, subject to that column's own cap). Without it a
/// single oversized frame — an agent inlining a whole file into one notification —
/// would occupy the entire byte budget and make [`MAX_BLOCKS_BYTES`] no bound at all.
const MAX_FRAME_BYTES: usize = 64 * 1024;

// A frame that passes the per-frame cap must fit the window budget, otherwise the
// eviction loop below could drain the window down to nothing on every fold.
const _: () = assert!(MAX_FRAME_BYTES <= MAX_BLOCKS_BYTES);

/// Byte budget for the accumulated agent message text (the `text` column). The frame
/// window above is bounded on two axes, but `text` used to be the one structure that
/// grew without any cap at all — it was *deliberately* the unbounded fallback ("full
/// text lives in `text`"), which only holds as long as agents stay polite. They do not:
/// a measured dev-library row reached 9,150,950 characters in a 19-message session.
/// Every debounced flush re-writes the whole column, so an unbounded `text` turns one
/// long turn into O(n²) write amplification (performance-and-safety.md §P1).
///
/// Sized two orders of magnitude above the largest legitimate text observed so far
/// (36,834 characters), so folding stays a safety net rather than a routine event.
const MAX_TEXT_BYTES: usize = 1024 * 1024;

/// Head budget: the first bytes of the turn are frozen once the cap is hit, so the
/// reader keeps the *beginning* of the answer. A pure tail window (keep the last N
/// bytes) would make the prose start mid-sentence, which is the least readable option.
const TEXT_HEAD_BYTES: usize = 256 * 1024;

/// Reserved room for the omission marker, so head + marker + tail provably fits
/// [`MAX_TEXT_BYTES`] without the marker itself having to be budgeted at runtime.
const TEXT_MARKER_MAX_BYTES: usize = 96;

/// Tail budget: a sliding window over the most recent text, so the reader keeps the
/// *conclusion* of the answer.
const TEXT_TAIL_BYTES: usize = MAX_TEXT_BYTES - TEXT_HEAD_BYTES - TEXT_MARKER_MAX_BYTES;

/// Slack trimmed off in one go when the tail window overflows. Trimming exactly back to
/// the budget would memmove the whole tail on *every* subsequent chunk — the very O(n²)
/// this cap exists to prevent. Dropping a chunk of slack instead amortizes it to O(1)
/// per byte at the cost of the tail holding slightly less than its budget.
const TEXT_TAIL_TRIM_SLACK: usize = TEXT_TAIL_BYTES / 4;

/// Marker wrapped around the omitted-character count. Deliberately user-readable rather
/// than an internal sentinel: `text` doubles as the plain-text fallback when `blocks`
/// cannot be decoded (`ChatView.tsx` `toChatMessages`), so a reader must be able to tell
/// "content was dropped here" from the rendered bubble alone. Every reference
/// implementation states the omitted amount explicitly; none drop content silently.
const TEXT_OMISSION_PREFIX: &str = "\n…（已省略 ";
const TEXT_OMISSION_SUFFIX: &str = " 字符）…\n";

// The rendered text is head + marker + tail; the three budgets must fit the cap.
const _: () = assert!(TEXT_HEAD_BYTES + TEXT_MARKER_MAX_BYTES + TEXT_TAIL_BYTES <= MAX_TEXT_BYTES);
// A trim must leave a non-empty tail window, and must actually free slack — otherwise
// the tail either collapses to nothing or is memmoved on every chunk.
const _: () = assert!(TEXT_TAIL_TRIM_SLACK > 0 && TEXT_TAIL_TRIM_SLACK < TEXT_TAIL_BYTES);
// The marker's fixed part must leave room for the count (20 digits covers u64::MAX).
const _: () =
    assert!(TEXT_OMISSION_PREFIX.len() + TEXT_OMISSION_SUFFIX.len() + 20 <= TEXT_MARKER_MAX_BYTES);

#[derive(Default)]
struct TurnState {
    /// True between `begin_turn` and `finalize_turn`. Gates folding so replay /
    /// idle notifications (which never call `begin_turn`) are ignored.
    active: bool,
    /// uuid of the in-progress `chat_messages` row. Created lazily on the first
    /// folded frame so a turn that emits nothing leaves no empty bubble.
    row_id: Option<String>,
    /// Raw `SessionUpdate` payloads for the active turn, in arrival order. Kept as
    /// pre-serialized [`RawValue`] so the window's byte size is known without
    /// re-formatting and flush only has to copy bytes. Bounded on both axes — frame
    /// count ([`MAX_FRAMES`]) and bytes ([`MAX_BLOCKS_BYTES`]) — front pops on overflow.
    frames: VecDeque<Box<RawValue>>,
    /// Running byte size of `frames` (sum of each frame's serialized length). Kept in
    /// sync on every push/pop so eviction never has to walk the window.
    frames_bytes: usize,
    /// Accumulated agent message text (for the NOT NULL `text` column and as a
    /// plain-text fallback). Only `AgentMessageChunk` text is collected here.
    /// Bounded by [`MAX_TEXT_BYTES`] — see [`BoundedText`].
    text: BoundedText,
    /// Per-client monotonic sequence, incremented on every folded frame. Never
    /// reset across turns; consumed by the reconnect reconciliation in a later phase.
    seq: u64,
    /// Set on fold, cleared by the writer after a flush.
    dirty: bool,
}

/// Byte-bounded accumulator for the turn's plain text.
///
/// Keeps a frozen **head** and a sliding **tail**, and counts what fell in between, so
/// the rendered value is `head + "…（已省略 N 字符）…" + tail` — the reader keeps both
/// the opening and the conclusion of the answer, and is told explicitly how much is
/// missing. Appending is amortized O(1) per byte: the head stops growing entirely and
/// the tail is trimmed in slack-sized chunks rather than on every push.
#[derive(Default)]
struct BoundedText {
    /// The turn's opening bytes; frozen once [`BoundedText::head_sealed`] is set.
    head: String,
    /// Set the moment any content lands in `tail`. The head must then stay frozen even
    /// though a UTF-8 boundary may have left it a few bytes below its budget — topping
    /// it up later would splice newer text *in front of* older text.
    head_sealed: bool,
    /// Sliding window over the most recent bytes; front-trimmed on overflow.
    tail: String,
    /// Characters (not bytes) dropped between `head` and `tail`, reported to the user.
    omitted_chars: usize,
}

impl BoundedText {
    fn clear(&mut self) {
        self.head.clear();
        self.head_sealed = false;
        self.tail.clear();
        self.omitted_chars = 0;
    }

    fn push_str(&mut self, chunk: &str) {
        let mut rest = chunk;
        if !self.head_sealed {
            let room = TEXT_HEAD_BYTES - self.head.len();
            if rest.len() <= room {
                self.head.push_str(rest);
                return;
            }
            // Cut on a char boundary (`floor_char_boundary`): slicing mid-character
            // would panic and take down the whole ACP connection task.
            let cut = rest.floor_char_boundary(room);
            self.head.push_str(&rest[..cut]);
            self.head_sealed = true;
            rest = &rest[cut..];
        }
        // A single chunk bigger than the tail budget (an agent inlining a whole file in
        // one `AgentMessageChunk`) must be trimmed *before* it lands: pushing it whole
        // and trimming afterwards would spike the buffer to the chunk's size, making the
        // cap no cap at all.
        if rest.len() > TEXT_TAIL_BYTES {
            let cut = rest.ceil_char_boundary(rest.len() - TEXT_TAIL_BYTES);
            self.omitted_chars += rest[..cut].chars().count();
            rest = &rest[cut..];
        }
        self.tail.push_str(rest);
        if self.tail.len() > TEXT_TAIL_BYTES {
            // Trim down to budget *minus slack* so the next chunks are free — trimming
            // back to exactly the budget would memmove the tail on every single push.
            let target = TEXT_TAIL_BYTES - TEXT_TAIL_TRIM_SLACK;
            let cut = self.tail.ceil_char_boundary(self.tail.len() - target);
            self.omitted_chars += self.tail[..cut].chars().count();
            self.tail.drain(..cut);
        }
    }

    fn render(&self) -> String {
        if !self.head_sealed {
            return self.head.clone();
        }
        let mut out =
            String::with_capacity(self.head.len() + TEXT_MARKER_MAX_BYTES + self.tail.len());
        out.push_str(&self.head);
        // `omitted_chars == 0` means the text merely outgrew the head budget without
        // anything being dropped yet — head + tail is still the complete text, so
        // claiming an omission would be a lie.
        if self.omitted_chars > 0 {
            out.push_str(TEXT_OMISSION_PREFIX);
            out.push_str(&self.omitted_chars.to_string());
            out.push_str(TEXT_OMISSION_SUFFIX);
        }
        out.push_str(&self.tail);
        out
    }
}

/// DB destination for persistence. Absent until [`TurnAccumulator::attach_persistence`]
/// — capability-probe clients never attach, so their folds are in-memory no-ops.
struct Sink {
    cmd_tx: mpsc::Sender<WriterCmd>,
}

enum WriterCmd {
    Flush,
    Finalize,
}

pub struct TurnAccumulator {
    inner: Mutex<TurnState>,
    sink: Mutex<Option<Sink>>,
}

/// Snapshot of the row to persist, taken under the lock and handed to the writer.
struct FlushSnapshot {
    row_id: String,
    text: String,
    blocks: String,
    last_seq: i64,
}

impl TurnAccumulator {
    pub fn new() -> Self {
        Self { inner: Mutex::new(TurnState::default()), sink: Mutex::new(None) }
    }

    /// Wire up persistence and spawn the debounce writer. Called once at real session
    /// registration (create-session / load_session restore). Idempotent-ish: a second
    /// call replaces the sink and spawns a new writer (not expected in practice).
    pub fn attach_persistence(self: &Arc<Self>, db: SqlitePool, db_session_id: String) {
        let (cmd_tx, cmd_rx) = mpsc::channel(WRITER_CHANNEL_CAPACITY);
        if let Ok(mut guard) = self.sink.lock() {
            *guard = Some(Sink { cmd_tx });
        }
        let acc = self.clone();
        tokio::spawn(writer_loop(acc, db, db_session_id, cmd_rx));
    }

    /// Open a new turn. Resets per-turn state; `seq` stays monotonic.
    pub fn begin_turn(&self) {
        if let Ok(mut st) = self.inner.lock() {
            st.active = true;
            st.row_id = None;
            st.frames.clear();
            st.frames_bytes = 0;
            st.text.clear();
            st.dirty = false;
        }
    }

    /// Fold one agent notification into the active turn. No-op when no turn is active
    /// (e.g. `load_session` replay frames), keeping replay out of live persistence.
    ///
    /// Returns the monotonic `seq` assigned to this frame when a turn is active, or
    /// `None` otherwise. The caller stamps this seq onto the broadcast payload so
    /// reconnecting clients can reconcile live frames against a `turn_snapshot`.
    pub fn fold(&self, notification: &SessionNotification) -> Option<u64> {
        let seq = {
            let Ok(mut st) = self.inner.lock() else { return None };
            if !st.active {
                return None;
            }
            st.seq += 1;
            if st.row_id.is_none() {
                st.row_id = Some(Uuid::new_v4().to_string());
            }
            if let Some(text) = agent_message_text(&notification.update) {
                st.text.push_str(text);
            }
            match serde_json::value::to_raw_value(&notification.update) {
                Ok(frame) => {
                    let bytes = frame.get().len();
                    if bytes > MAX_FRAME_BYTES {
                        // Oversized single frame: never enters the window (see
                        // MAX_FRAME_BYTES). Its text is already in `st.text`.
                        tracing::debug!(
                            bytes,
                            "dropping oversized session update frame from turn window"
                        );
                    } else {
                        st.frames.push_back(frame);
                        st.frames_bytes += bytes;
                        // Bounded window on both axes: drop oldest frames until the
                        // frame-count and byte budgets both hold. `text` accumulates
                        // full agent text separately, so evicting a thought/tool frame
                        // only narrows the mid-turn recovery window.
                        while st.frames.len() > MAX_FRAMES || st.frames_bytes > MAX_BLOCKS_BYTES {
                            match st.frames.pop_front() {
                                Some(old) => st.frames_bytes -= old.get().len(),
                                None => break,
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("failed to serialize session update for persistence: {}", e)
                }
            }
            st.dirty = true;
            st.seq
        };
        self.send_cmd(WriterCmd::Flush);
        Some(seq)
    }

    /// Close the active turn and finalize its row. Idempotent: a no-op if no turn is
    /// active, so racing callers (send_prompt completion / cancel / crash watcher) are safe.
    pub fn finalize_turn(&self) {
        let should_finalize = {
            let Ok(mut st) = self.inner.lock() else { return };
            if !st.active {
                return;
            }
            st.active = false;
            st.row_id.is_some()
        };
        if should_finalize {
            self.send_cmd(WriterCmd::Finalize);
        }
    }

    fn send_cmd(&self, cmd: WriterCmd) {
        if let Ok(guard) = self.sink.lock()
            && let Some(sink) = guard.as_ref()
        {
            // try_send: the writer only needs to know work is pending; a full queue
            // already has a pending signal, and a closed queue means no sink.
            let _ = sink.cmd_tx.try_send(cmd);
        }
    }

    /// Take a snapshot of the current row for persistence, or None if nothing was folded.
    fn snapshot(&self) -> Option<FlushSnapshot> {
        let st = self.inner.lock().ok()?;
        let row_id = st.row_id.clone()?;
        Some(FlushSnapshot {
            row_id,
            text: st.text.render(),
            blocks: wrap_frames(&st.frames),
            last_seq: st.seq as i64,
        })
    }

    /// The DB row id of the current (or just-finished) turn; `None` until the first frame
    /// is folded. Deliberately separate from [`Self::turn_snapshot`], which clones the
    /// whole `text` and re-serializes the frame window (up to `MAX_BLOCKS_BYTES`) — far
    /// too much work when a caller only needs the id. Survives `finalize_turn` (only
    /// `begin_turn` clears it), so a turn-end event can still report it.
    pub fn turn_row_id(&self) -> Option<String> {
        self.inner.lock().ok()?.row_id.clone()
    }

    /// Snapshot the live turn state for a freshly-connected WS client (reconnect
    /// reconciliation). Always reports `active` and the current `seq` high-water mark;
    /// `row_id` is `None` until the first frame is folded. See the WS `turn_snapshot`
    /// frame and the frontend reconciliation in `useAcpChat`.
    pub fn turn_snapshot(&self) -> TurnSnapshot {
        let Ok(st) = self.inner.lock() else {
            return TurnSnapshot::default();
        };
        TurnSnapshot {
            active: st.active,
            row_id: st.row_id.clone(),
            text: st.text.render(),
            blocks: wrap_frames(&st.frames),
            seq: st.seq,
        }
    }
}

/// Wrap the retained frames into the `blocks` column payload
/// (`{"v":1,"frames":[...]}`, see module docs). Frames are already serialized
/// ([`RawValue`]) so this only concatenates bytes — no re-formatting per flush.
fn wrap_frames(frames: &VecDeque<Box<RawValue>>) -> String {
    #[derive(Serialize)]
    struct Wrapper<'a> {
        v: u64,
        frames: &'a VecDeque<Box<RawValue>>,
    }
    match serde_json::to_string(&Wrapper { v: RAW_FRAMES_VERSION, frames }) {
        Ok(s) => s,
        Err(e) => {
            // Concatenating valid RawValues cannot realistically fail; if it ever does,
            // persist an empty (but well-formed) window rather than a corrupt column.
            tracing::warn!("failed to serialize turn frames wrapper: {}", e);
            format!("{{\"v\":{RAW_FRAMES_VERSION},\"frames\":[]}}")
        }
    }
}

/// Live turn state handed to a connecting WS client so it can resume an in-progress
/// assistant turn without gaps or duplicates.
#[derive(Default)]
pub struct TurnSnapshot {
    pub active: bool,
    pub row_id: Option<String>,
    pub text: String,
    pub blocks: String,
    pub seq: u64,
}

impl Default for TurnAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

/// Extract plain text from an `AgentMessageChunk`'s text content block; None otherwise.
fn agent_message_text(update: &SessionUpdate) -> Option<&str> {
    if let SessionUpdate::AgentMessageChunk(chunk) = update
        && let ContentBlock::Text(t) = &chunk.content
    {
        return Some(&t.text);
    }
    None
}

/// Debounce writer: coalesces `Flush` pings into a bounded number of SQLite writes,
/// and performs the final flush + status finalize on `Finalize`.
async fn writer_loop(
    acc: Arc<TurnAccumulator>,
    db: SqlitePool,
    session_id: String,
    mut cmd_rx: mpsc::Receiver<WriterCmd>,
) {
    // Instant of the first un-flushed fold in the current pending window.
    let mut pending_since: Option<Instant> = None;

    loop {
        let cmd = if let Some(since) = pending_since {
            // A flush is pending: wait up to the debounce gap, but never exceed the
            // max-latency cap measured from the first pending fold.
            let elapsed = since.elapsed();
            let wait = if elapsed >= MAX_LATENCY {
                Duration::ZERO
            } else {
                DEBOUNCE.min(MAX_LATENCY - elapsed)
            };
            match tokio::time::timeout(wait, cmd_rx.recv()).await {
                Err(_elapsed) => {
                    // Debounce window elapsed with pending work → write once.
                    flush_once(&acc, &db, &session_id).await;
                    pending_since = None;
                    continue;
                }
                Ok(None) => break, // all senders dropped
                Ok(Some(c)) => c,
            }
        } else {
            match cmd_rx.recv().await {
                Some(c) => c,
                None => break,
            }
        };

        match cmd {
            WriterCmd::Flush => {
                if pending_since.is_none() {
                    pending_since = Some(Instant::now());
                }
            }
            WriterCmd::Finalize => {
                flush_once(&acc, &db, &session_id).await;
                pending_since = None;
                if let Some(snap) = acc.snapshot()
                    && let Err(e) = chat_persistence::finalize_message(&db, &snap.row_id).await
                {
                    tracing::warn!("failed to finalize streaming chat message: {}", e);
                }
            }
        }
    }
}

async fn flush_once(acc: &Arc<TurnAccumulator>, db: &SqlitePool, session_id: &str) {
    let Some(snap) = acc.snapshot() else { return };
    if let Err(e) = chat_persistence::upsert_streaming_message(
        db,
        &snap.row_id,
        session_id,
        &snap.text,
        Some(&snap.blocks),
        snap.last_seq,
    )
    .await
    {
        tracing::warn!("failed to upsert streaming chat message: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{ContentChunk, SessionId, TextContent};
    use serde_json::Value;

    /// Wrapper overhead of `{"v":1,"frames":[]}` plus the `,` separators between frames.
    /// The byte budget applies to the frames themselves, so assertions allow this slack.
    const WRAPPER_SLACK: usize = 4096;

    fn text_chunk(sid: &SessionId, text: impl Into<String>) -> SessionNotification {
        SessionNotification::new(
            sid.clone(),
            SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new(text.into()),
            ))),
        )
    }

    fn retained_frames(acc: &TurnAccumulator) -> (usize, usize) {
        let st = acc.inner.lock().expect("lock");
        (st.frames.len(), st.frames_bytes)
    }

    /// Internal text buffers: `(head bytes, tail bytes, omitted chars)`. Asserted
    /// directly because bounding only the *rendered* value would still leave the
    /// in-memory accumulation — and therefore every debounced re-write — unbounded.
    fn text_buffers(acc: &TurnAccumulator) -> (usize, usize, usize) {
        let st = acc.inner.lock().expect("lock");
        (st.text.head.len(), st.text.tail.len(), st.text.omitted_chars)
    }

    /// Split a rendered text into `(head, omitted_chars, tail)`; `None` when unfolded.
    fn split_folded(text: &str) -> Option<(&str, usize, &str)> {
        let (head, rest) = text.split_once(TEXT_OMISSION_PREFIX)?;
        let (count, tail) = rest.split_once(TEXT_OMISSION_SUFFIX)?;
        Some((head, count.parse().expect("折叠标记应包含可解析的省略字符数"), tail))
    }

    /// Fold `unit` repeatedly until at least `total_bytes` of text has been fed in.
    /// Returns the full text that was fed, for conservation assertions.
    fn fold_until(
        acc: &TurnAccumulator,
        sid: &SessionId,
        unit: &str,
        total_bytes: usize,
    ) -> String {
        let mut fed = String::new();
        while fed.len() < total_bytes {
            acc.fold(&text_chunk(sid, unit));
            fed.push_str(unit);
        }
        fed
    }

    fn parse_frames(blocks: &str) -> Vec<Value> {
        let wrapper: Value = serde_json::from_str(blocks).expect("blocks 应为合法 JSON");
        wrapper["frames"].as_array().expect("frames 应为数组").clone()
    }

    /// `turn_row_id` must survive `finalize_turn`: the WS layer reads it *after* the turn
    /// is finalized in order to hand it to the frontend in `prompt_done`, which is what
    /// lets the frontend write cooked blocks back to that exact row. Only `begin_turn`
    /// may clear it — otherwise every turn would end with "no row to write to".
    #[test]
    fn row_id_is_readable_after_finalize_and_reset_by_next_turn() {
        let acc = TurnAccumulator::new();
        let sid = SessionId::new("s1");

        assert_eq!(acc.turn_row_id(), None, "未开始 turn 时无行 id");
        acc.begin_turn();
        assert_eq!(acc.turn_row_id(), None, "首帧折叠前仍无行 id（行是惰创建的）");

        acc.fold(&text_chunk(&sid, "hello"));
        let row_id = acc.turn_row_id().expect("首帧折叠后应有行 id");
        assert_eq!(acc.turn_snapshot().row_id.as_deref(), Some(row_id.as_str()), "与快照同源");

        acc.finalize_turn();
        assert_eq!(acc.turn_row_id().as_deref(), Some(row_id.as_str()), "定稿后仍可读到");

        acc.begin_turn();
        assert_eq!(acc.turn_row_id(), None, "下一 turn 开始才清除");
    }

    /// 长 turn 高频帧（thought/tool chunk）不能把 frames 撑成无界：窗口在帧数与字节
    /// 两个维度上都有上限，text 仍全量累积。回归防护 2026-08-04 线上问题（单条 blocks
    /// 累积到 100MB、tokio worker 99% CPU、进程 RES 4.5GB）。
    #[test]
    fn window_is_bounded_on_both_axes_over_long_turn() {
        const FOLD_COUNT: u32 = 5000;
        assert!(FOLD_COUNT as usize > MAX_FRAMES, "测试需超过窗口以触发淘汰");

        let acc = TurnAccumulator::new();
        acc.begin_turn();
        let sid = SessionId::new("s1");
        for i in 0..FOLD_COUNT {
            assert!(
                acc.fold(&text_chunk(&sid, format!("chunk-{i} "))).is_some(),
                "turn active 时应折叠出 seq"
            );
        }

        let (len, bytes) = retained_frames(&acc);
        assert!(len <= MAX_FRAMES, "frames 不得超帧数上限，得到 {len}");
        assert!(bytes <= MAX_BLOCKS_BYTES, "frames 不得超字节上限，得到 {bytes}");

        let snap = acc.turn_snapshot();
        assert!(
            snap.blocks.len() <= MAX_BLOCKS_BYTES + WRAPPER_SLACK,
            "blocks 列不随 turn 长度增长，得到 {} 字节",
            snap.blocks.len()
        );
        assert_eq!(parse_frames(&snap.blocks).len(), len, "包裹后的帧数应等于窗口帧数");

        // text 在未触及 [`MAX_TEXT_BYTES`] 前全量累积：丢弃的只是 UI 恢复窗口，正文不受影响。
        assert!(
            snap.text.len() < MAX_TEXT_BYTES,
            "本例输入量应远低于正文上限，否则下方全量断言不成立"
        );
        assert!(snap.text.starts_with("chunk-0 "), "text 保留最早 chunk");
        assert!(snap.text.ends_with("chunk-4999 "), "text 保留最新 chunk");
        assert_eq!(snap.text.matches("chunk-").count(), FOLD_COUNT as usize);
    }

    /// 正文超过 [`MAX_TEXT_BYTES`] 时必须收敛，且**头尾都保留**、省略量显式可读。
    /// 每次 debounce flush 都会重写整个 `text` 列，无界正文即 O(n²) 写放大
    /// （performance-and-safety.md §P1）。
    #[test]
    fn long_text_folds_to_head_and_tail_within_cap() {
        let acc = TurnAccumulator::new();
        acc.begin_turn();
        let sid = SessionId::new("s1");

        // 每条 chunk 带序号，以便区分“保留了开头”与“保留了结尾”。
        let mut fed = String::new();
        let mut i = 0usize;
        while fed.len() < MAX_TEXT_BYTES * 2 {
            let chunk = format!("line-{i:08}-{}\n", "f".repeat(48));
            acc.fold(&text_chunk(&sid, chunk.clone()));
            fed.push_str(&chunk);
            i += 1;
        }

        let text = acc.turn_snapshot().text;
        assert!(text.len() <= MAX_TEXT_BYTES, "正文不得超字节上限，得到 {} 字节", text.len());

        let (head, omitted, tail) = split_folded(&text).expect("超限后应出现可读的折叠标记");
        assert!(omitted > 0, "折叠标记必须报出实际省略量");
        assert!(head.starts_with("line-00000000-"), "头部必须是正文开头（约 {head:.20}）");
        assert!(
            tail.ends_with(&format!("line-{:08}-{}\n", i - 1, "f".repeat(48))),
            "尾部必须是正文结尾"
        );

        // 守恒：保留的 + 声称省略的 == 全部输入。静默丢弃无人采用（D3）。
        assert_eq!(
            head.chars().count() + omitted + tail.chars().count(),
            fed.chars().count(),
            "保留量与省略量之和必须等于输入量（不得静默丢弃）"
        );

        // 内存侧也必须有界：仅限界渲染值会让累积缓冲与每次重写仍然无界。
        let (head_bytes, tail_bytes, _) = text_buffers(&acc);
        assert!(head_bytes <= TEXT_HEAD_BYTES, "头部缓冲超预算：{head_bytes}");
        assert!(tail_bytes <= TEXT_TAIL_BYTES, "尾窗缓冲超预算：{tail_bytes}");
    }

    /// 未达上限时正文必须逐字节原样 —— 折叠是安全网，不得污染常规路径。
    #[test]
    fn text_under_cap_is_verbatim() {
        let acc = TurnAccumulator::new();
        acc.begin_turn();
        let sid = SessionId::new("s1");
        acc.fold(&text_chunk(&sid, "你好，"));
        acc.fold(&text_chunk(&sid, "world \u{1F642}"));

        let text = acc.turn_snapshot().text;
        assert_eq!(text, "你好，world \u{1F642}");
        assert!(!text.contains(TEXT_OMISSION_PREFIX), "未超限不得出现折叠标记");
    }

    /// 头部封口与尾窗修剪都会落在任意位置，必须按 UTF-8 字符边界切 —— 切在多字节
    /// 字符中间在 Rust 里直接 panic（`String` 无法持有非法 UTF-8），在生产里就是折断
    /// 整个 ACP 连接任务。单元长 16 字节且与各预算不整除，确保边界落在字符内部。
    #[test]
    fn folding_never_splits_multibyte_chars() {
        const UNIT: &str = "中文测试\u{1F642}"; // 3*4 + 4 = 16 字节
        let acc = TurnAccumulator::new();
        acc.begin_turn();
        let sid = SessionId::new("s1");
        let fed = fold_until(&acc, &sid, UNIT, MAX_TEXT_BYTES * 2);

        let text = acc.turn_snapshot().text;
        assert!(text.len() <= MAX_TEXT_BYTES, "多字节正文仍须守住上限：{}", text.len());

        let (head, omitted, tail) = split_folded(&text).expect("超限后应折叠");
        let unit_chars: Vec<char> = UNIT.chars().collect();
        for (label, part) in [("头部", head), ("尾部", tail)] {
            assert!(
                part.chars().all(|c| unit_chars.contains(&c)),
                "{label}出现不属于输入字符集的字符（说明字符被切坏）"
            );
            assert!(!part.contains('\u{FFFD}'), "{label}不得出现替换字符");
        }
        assert_eq!(
            head.chars().count() + omitted + tail.chars().count(),
            fed.chars().count(),
            "字符级守恒在多字节下同样成立"
        );
    }

    /// 单个 chunk 本身就超过上限（agent 把整份文件塞进一个 AgentMessageChunk）时，不得先把
    /// 它整段推进缓冲再修剪 —— 那会让内存峰值等于 chunk 大小，上限形同虚设。
    #[test]
    fn single_oversized_chunk_is_bounded_on_arrival() {
        let acc = TurnAccumulator::new();
        acc.begin_turn();
        let sid = SessionId::new("s1");
        let huge = "x".repeat(MAX_TEXT_BYTES * 3);
        acc.fold(&text_chunk(&sid, huge.clone()));

        let (head_bytes, tail_bytes, _) = text_buffers(&acc);
        assert!(head_bytes <= TEXT_HEAD_BYTES, "头部缓冲超预算：{head_bytes}");
        assert!(tail_bytes <= TEXT_TAIL_BYTES, "尾窗缓冲超预算：{tail_bytes}");

        let text = acc.turn_snapshot().text;
        assert!(text.len() <= MAX_TEXT_BYTES, "超大单帧正文仍须守住上限：{}", text.len());
        let (head, omitted, tail) = split_folded(&text).expect("超限后应折叠");
        assert_eq!(head.chars().count() + omitted + tail.chars().count(), huge.chars().count());
    }

    /// 新 turn 必须重置折叠状态：否则上一个长 turn 的封口标志与省略计数会泄漏到下一
    /// 个 turn，让一句短回答迷不丁地带上“已省略 N 字符”。
    #[test]
    fn begin_turn_resets_text_folding_state() {
        const UNIT: &str = "旧 turn 的冗长正文 ";
        let acc = TurnAccumulator::new();
        let sid = SessionId::new("s1");
        acc.begin_turn();
        fold_until(&acc, &sid, UNIT, MAX_TEXT_BYTES + TEXT_TAIL_BYTES);
        assert!(text_buffers(&acc).2 > 0, "前一个 turn 应已发生折叠");

        acc.begin_turn();
        acc.fold(&text_chunk(&sid, "新 turn"));
        assert_eq!(text_buffers(&acc), ("新 turn".len(), 0, 0), "新 turn 应从空缓冲开始");
        assert_eq!(acc.turn_snapshot().text, "新 turn");
    }

    /// 折叠标记必须装得进为它预留的预算，否则 head + marker + tail 会溢出总上限；
    /// 预算里的 20 位数字余量由 const 断言保证，这里取最坏情况实测。
    #[test]
    fn omission_marker_fits_reserved_budget() {
        let widest = format!("{TEXT_OMISSION_PREFIX}{}{TEXT_OMISSION_SUFFIX}", usize::MAX);
        assert!(
            widest.len() <= TEXT_MARKER_MAX_BYTES,
            "标记最坏情况 {} 字节超出预算 {TEXT_MARKER_MAX_BYTES}",
            widest.len()
        );
    }

    /// 回归防护 2026-08-10：codebuddy 每个 tool_call_update 只带 1 字符增量，却重复携带
    /// 完整 rawInput（4.5KB/帧）——帧数上限在这种帧下完全拦不住体积（2000 帧 = 8.7MB
    /// 单行，使 GET /messages 下发 15MB、切会话卡顿 0.5s）。字节预算必须先生效。
    #[test]
    fn fat_repeated_frames_stay_within_byte_budget() {
        const FRAME_TEXT_BYTES: usize = 4500;
        const FOLD_COUNT: usize = 500;

        let acc = TurnAccumulator::new();
        acc.begin_turn();
        let sid = SessionId::new("s1");
        let fat = "x".repeat(FRAME_TEXT_BYTES);
        for _ in 0..FOLD_COUNT {
            acc.fold(&text_chunk(&sid, fat.clone()));
        }

        let (len, bytes) = retained_frames(&acc);
        assert!(bytes <= MAX_BLOCKS_BYTES, "肥帧下字节预算仍须守住，得到 {bytes}");
        assert!(
            len < FOLD_COUNT,
            "字节维度应已触发淘汰（帧数上限 {MAX_FRAMES} 在 {FOLD_COUNT} 肥帧下根本拦不住），得到 {len} 帧"
        );
        assert!(len > 0, "单帧未超限时窗口不得被清空");

        let snap = acc.turn_snapshot();
        assert!(
            snap.blocks.len() <= MAX_BLOCKS_BYTES + WRAPPER_SLACK,
            "blocks 列应被字节预算钉住，得到 {} 字节",
            snap.blocks.len()
        );
    }

    /// 单帧自身超过 [`MAX_FRAME_BYTES`]（agent 把整份文件塞进一帧）时不得入窗，否则它
    /// 会独占整个字节预算使上限形同虚设；text 仍兼底正文。
    #[test]
    fn oversized_frame_never_enters_window() {
        let acc = TurnAccumulator::new();
        acc.begin_turn();
        let sid = SessionId::new("s1");
        let huge = "y".repeat(MAX_FRAME_BYTES + 1);
        assert!(acc.fold(&text_chunk(&sid, huge.clone())).is_some(), "帧被丢弃也应分配 seq");

        let (len, bytes) = retained_frames(&acc);
        assert_eq!(len, 0, "超大单帧不得入窗");
        assert_eq!(bytes, 0, "丢弃的帧不得计入字节账");

        let snap = acc.turn_snapshot();
        assert_eq!(snap.text, huge, "正文文本仍全量累积");
        assert!(parse_frames(&snap.blocks).is_empty(), "blocks 应为合法的空窗口");
    }

    /// 新 turn 必须重置字节账，否则跨 turn 累积会让窗口逐渐营养不良（预算被已丢弃
    /// 的旧帧占满，新 turn 一 fold 就被淘汰到只剩一帧）。
    #[test]
    fn begin_turn_resets_byte_accounting() {
        let acc = TurnAccumulator::new();
        let sid = SessionId::new("s1");
        acc.begin_turn();
        for _ in 0..50 {
            acc.fold(&text_chunk(&sid, "z".repeat(4096)));
        }
        assert!(retained_frames(&acc).1 > 0, "前一个 turn 应有累积");

        acc.begin_turn();
        assert_eq!(retained_frames(&acc), (0, 0), "新 turn 应清空帧与字节账");
    }
}
