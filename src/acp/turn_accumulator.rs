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
//! `text` still accumulates the full agent message text, and the frontend writes back
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
/// kept for mid-turn recovery — full text lives in `text`, full structure comes back
/// from the frontend's `sync` after the turn ends.
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
/// frames. Acceptable because `text` keeps the full agent text and the frontend's
/// classifier folds all updates of one `toolCallId` into a single card anyway, so the
/// rendered result is near-identical.
const MAX_BLOCKS_BYTES: usize = 128 * 1024;

/// Per-frame cap: a frame larger than this never enters the window (its text, if any,
/// is still accumulated into `text`). Without it a single oversized frame — an agent
/// inlining a whole file into one notification — would occupy the entire byte budget
/// and make [`MAX_BLOCKS_BYTES`] no bound at all.
const MAX_FRAME_BYTES: usize = 64 * 1024;

// A frame that passes the per-frame cap must fit the window budget, otherwise the
// eviction loop below could drain the window down to nothing on every fold.
const _: () = assert!(MAX_FRAME_BYTES <= MAX_BLOCKS_BYTES);

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
    text: String,
    /// Per-client monotonic sequence, incremented on every folded frame. Never
    /// reset across turns; consumed by the reconnect reconciliation in a later phase.
    seq: u64,
    /// Set on fold, cleared by the writer after a flush.
    dirty: bool,
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
            text: st.text.clone(),
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
            text: st.text.clone(),
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

        // text 全量累积：丢弃的只是 UI 恢复窗口，正文文本不受影响。
        assert!(snap.text.starts_with("chunk-0 "), "text 保留最早 chunk");
        assert!(snap.text.ends_with("chunk-4999 "), "text 保留最新 chunk");
        assert_eq!(snap.text.matches("chunk-").count(), FOLD_COUNT as usize);
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
