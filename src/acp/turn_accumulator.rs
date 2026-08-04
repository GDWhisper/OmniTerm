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
//! **Frame retention is bounded** ([`MAX_FRAMES`]): long agent turns emit a high rate
//! of raw notifications (thought/tool chunks can exceed tens of thousands per turn).
//! The accumulator keeps only the most recent window for mid-turn crash recovery —
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
use serde_json::{Value, json};
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
/// from the frontend's `sync` after the turn ends. ~1.5KB/frame observed → ~3MB worst
/// case per flush, a constant cost regardless of turn length.
const MAX_FRAMES: usize = 2000;

#[derive(Default)]
struct TurnState {
    /// True between `begin_turn` and `finalize_turn`. Gates folding so replay /
    /// idle notifications (which never call `begin_turn`) are ignored.
    active: bool,
    /// uuid of the in-progress `chat_messages` row. Created lazily on the first
    /// folded frame so a turn that emits nothing leaves no empty bubble.
    row_id: Option<String>,
    /// Raw `SessionUpdate` payloads for the active turn, in arrival order. Bounded to
    /// the most recent [`MAX_FRAMES`] frames (front pops on overflow), so a long turn
    /// cannot grow this unboundedly.
    frames: VecDeque<Value>,
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
            match serde_json::to_value(&notification.update) {
                Ok(v) => {
                    st.frames.push_back(v);
                    // Bounded window: drop the oldest frame once retention is exceeded.
                    // `text` accumulates full agent text separately, so a dropped
                    // thought/tool frame only narrows the mid-turn recovery window.
                    if st.frames.len() > MAX_FRAMES {
                        st.frames.pop_front();
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
        let blocks = json!({ "v": RAW_FRAMES_VERSION, "frames": st.frames }).to_string();
        Some(FlushSnapshot { row_id, text: st.text.clone(), blocks, last_seq: st.seq as i64 })
    }

    /// Snapshot the live turn state for a freshly-connected WS client (reconnect
    /// reconciliation). Always reports `active` and the current `seq` high-water mark;
    /// `row_id` is `None` until the first frame is folded. See the WS `turn_snapshot`
    /// frame and the frontend reconciliation in `useAcpChat`.
    pub fn turn_snapshot(&self) -> TurnSnapshot {
        let Ok(st) = self.inner.lock() else {
            return TurnSnapshot::default();
        };
        let blocks = json!({ "v": RAW_FRAMES_VERSION, "frames": st.frames }).to_string();
        TurnSnapshot {
            active: st.active,
            row_id: st.row_id.clone(),
            text: st.text.clone(),
            blocks,
            seq: st.seq,
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

    /// 长 turn 高频帧（thought/tool chunk）不能把 frames 撑成无界：窗口保留最近
    /// MAX_FRAMES 帧，text 仍全量累积。回归防护 2026-08-04 线上问题（单条 blocks
    /// 累积到 100MB、tokio worker 99% CPU、进程 RES 4.5GB）。
    #[test]
    fn frames_retention_is_bounded_over_long_turn() {
        const FOLD_COUNT: u32 = 5000;
        assert!(FOLD_COUNT as usize > MAX_FRAMES, "测试需超过窗口以触发淘汰");

        let acc = TurnAccumulator::new();
        acc.begin_turn();
        let sid = SessionId::new("s1");
        for i in 0..FOLD_COUNT {
            let notif = SessionNotification::new(
                sid.clone(),
                SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                    TextContent::new(format!("chunk-{i} ")),
                ))),
            );
            assert!(acc.fold(&notif).is_some(), "turn active 时应折叠出 seq");
        }

        let snap = acc.turn_snapshot();
        let wrapper: Value = serde_json::from_str(&snap.blocks).expect("blocks 应为合法 JSON");
        let frames = wrapper["frames"].as_array().expect("frames 应为数组");
        assert_eq!(frames.len(), MAX_FRAMES, "frames 只保留最近窗口，不随 turn 长度增长");

        // text 全量累积：丢弃的只是 UI 恢复窗口，正文文本不受影响。
        assert!(snap.text.starts_with("chunk-0 "), "text 保留最早 chunk");
        assert!(snap.text.ends_with("chunk-4999 "), "text 保留最新 chunk");
        assert_eq!(snap.text.matches("chunk-").count(), FOLD_COUNT as usize);
    }
}
