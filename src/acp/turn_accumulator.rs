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
//! rate maps to a few SQLite writes per second. The one command that must never be
//! coalesced away — [`WriterCmd::EndTurn`], the non-idempotent finalize transition —
//! travels a separate unbounded channel ([`Sink::end_tx`]) so a saturated signal queue
//! can never silently drop it.
//!
//! The accumulator is also the **single accounting point for turn work time**: turn
//! duration (`work_ms`) and permission-wait time (`wait_ms`) are measured here, on the
//! same `active → false` transition that finalizes the row, so each turn is counted
//! exactly once. The measurement basis (wall time minus human-approval wait) and the
//! decision to keep it here rather than in a separate timer live in
//! `docs/dev/plans/archive/2026-08-30-acp-work-time.md` (D1/D2).

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1::{
    ContentBlock, SessionNotification, SessionUpdate, ToolCallStatus,
};
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

// ── 输出速率（tps）与工具耗时记账 ─────────────────────────────────────────
// 口径整体移植自前端 `utils/turnClock.ts`（E13–E20 的算法与测试向量），2026-10-15
// 翻盘后计算迁到后端作为唯一真相源、前端只显示（详见 work-time 计划 E23）。数值
// 语义必须与原前端实现逐条对齐：回归向量见本文件 `mod tests` 的「速率与工具记账」区。

/// 字符→token 的换算比：ACP 无输出 token 字段（`usage_update` 只是上下文配额），
/// 按「输出字符数 ÷ 4」估算（E13）。
const CHARS_PER_TOKEN: u64 = 4;

/// 相邻输出 chunk 间隔超过该值即视为一次「停顿」：模型停止吐字（工具执行 /
/// 审批等待 / 思考间隙 / agent 循环空档），停顿段不计入速度分母（E20 白名单）。
/// 实测 pi-acp 正常流式的 chunk 间隔在数百毫秒内（真实流量最大 ~400ms），
/// 1s 留有余量。
const OUTPUT_GAP_MS: u64 = 1_000;

/// 工具并集的活跃跟踪上限：只保留活跃 ID、完成即释放；同时限制单条 ID 的
/// UTF-16 单元数（与旧前端 `.length` 同口径），避免只限条数不限体积。任一条
/// 越界都令**工具**估算整体失效（丢弃一条后并集不再完整，宁缺毋滥）；tps 走
/// 白名单、不读工具状态，不受影响（E20）。
const MAX_ACTIVE_TURN_TOOLS: usize = 256;
const MAX_TURN_TOOL_ID_UTF16: usize = 1024;

#[derive(Default)]
struct TurnState {
    /// True between `begin_turn` and `finalize_turn`. Gates folding so replay /
    /// idle notifications (which never call `begin_turn`) are ignored.
    active: bool,
    /// 本 turn 的起点（单调时钟）。只在 `active` 期间被读，`begin_turn` 覆盖写。
    started: Option<Instant>,
    /// 本 turn 内**已结束**的审批等待段之和（ms）。`begin_turn` 归零。
    wait_ms: u64,
    /// 当前审批等待段的起算时刻；不变式：`is_some() == wait_depth > 0`。
    wait_since: Option<Instant>,
    /// 未决权限请求数。用计数而非布尔：agent 可并发发出多个 `session/request_permission`，
    /// 布尔会被第一个应答提前清零、把后续等待算成工作（计划 D4）。计数由 0 变正时起算
    /// 一段等待，回到 0 时累加该段。不用 id 集合是因为审批 id 取不出来 ——
    /// `on_receive_request` 回调的返回类型受 `IntoHandled` 约束，`handle_request` 无法把
    /// 它生成的 id 交给调用方，改成集合就得动 `PermissionManager` 的 API。
    wait_depth: u32,
    /// uuid of the in-progress `chat_messages` row. Created lazily on the first
    /// folded frame so a turn that emits nothing leaves no empty bubble.
    ///
    /// 「第一条帧」不等于「第一行可见内容」：`usage_update` / `session_info_update`
    /// 这类记账帧同样开一行，用户看到的却是一个空气泡。判定「本轮到底有没有产出
    /// 东西」要用 [`Self::output_seen`]。
    row_id: Option<String>,
    /// 本 turn 是否折叠过至少一帧**可见产出**（正文 / 思考 / 工具卡 / 计划），
    /// 见 [`update_is_visible_output`]。`begin_turn` 归零，与 `row_id` 同样活到
    /// 下一次 `begin_turn` —— turn 结束路径要在 `finalize_turn` 之后仍读得到它。
    /// 用途：agent 可能把失败收敛成合法的 `stopReason=end_turn`（实测 pi-acp 把
    /// provider 403 折成 end_turn，见 `docs/reference/acp-protocol-reference.md` §6.8），
    /// 宿主只能靠「协议说正常但一个可见帧都没有」识别这种静默失败。
    output_seen: bool,
    /// 上一次 `finalize_turn` 结算出的时长。与 `row_id` 同生命周期：定稿后仍可读，
    /// 下一次 `begin_turn` 才清 —— WS 层在 `mark_prompt_idle` 之后要拿它拼 `prompt_done`。
    /// `None` = 本 client 还没定稿过任何 turn。
    last_timing: Option<TurnTiming>,
    /// 当前输出 burst（连续流式段，tps 白名单分母）；`None` = 尚无或已归入合计。
    burst: Option<OutputBurst>,
    /// 已闭合 burst 的字符合计（tps 分子存量）。
    stream_chars: u64,
    /// 已闭合 burst 的时长合计（ms；tps 分母存量）。
    stream_ms: u64,
    /// 显式 `in_progress` 且尚未结束的工具 id 集合（执行并集的成员）。
    active_tools: HashSet<String>,
    /// 开放并集起点（**工作坐标** ms；`None` = 无开放并集）。在工作坐标上度量，
    /// 审批等待与工具执行重叠时不会重复扣除（E15）。
    tool_union_since_ms: Option<u64>,
    /// 开放并集的首段：并集起点 → 并集内首次输出（`tool_has_head` 时有效）。
    tool_head_ms: u64,
    tool_has_head: bool,
    /// 已闭合工具并集的「非生成段」累计（首段 + 尾段）：工具耗时的存量部分。
    pure_tool_ms: u64,
    /// 本 turn 最近一次输出的工作坐标：开放并集尾段的起点（E19）。
    last_output_work_ms: Option<u64>,
    /// 工具跟踪越界后整体失效（读数消失，不虚报）；`begin_turn` 重置。
    tool_estimates_valid: bool,
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

/// 当前输出 burst：首 / 末 chunk 时刻与字符数（tps 白名单分母的开放段）。
struct OutputBurst {
    first: Instant,
    last: Instant,
    chars: u64,
}

/// tps 与工具耗时的计算全部落在这些方法上（口径见模块头与常量注释）。所有方法
/// 显式接收 `now`：生产路径传 `Instant::now()`，测试注入合成时间线——与旧前端
/// `at` 注入同构，回归向量才能逐毫秒对齐。
impl TurnState {
    /// 工作时长（ms）= 墙钟 − 已闭合等待 − 当前开放等待；各段夹到零。
    fn work_elapsed_ms(&self, now: Instant) -> u64 {
        let Some(started) = self.started else {
            return 0;
        };
        let wall = ms_between(started, now);
        let waiting = self.wait_since.map_or(0, |since| ms_between(since, now));
        wall.saturating_sub(self.wait_ms).saturating_sub(waiting)
    }

    /// 开放工具并集的完整跨度（首段 / 快照的计算源）。
    fn open_tool_ms(&self, now: Instant) -> u64 {
        self.tool_union_since_ms.map_or(0, |since| self.work_elapsed_ms(now).saturating_sub(since))
    }

    /// 开放并集的尾段 = 末次输出（或并集起点）→ now。末次输出之后没有新的输出
    /// 证据，该段是模型在等工具：实时即按工具计，读数不随工具执行下跌；新输出
    /// 到达后末次输出前移，该段被认领为生成（中途修正，E19）。
    fn open_tail_ms(&self, now: Instant) -> u64 {
        let Some(since) = self.tool_union_since_ms else {
            return 0;
        };
        let anchor = match self.last_output_work_ms {
            Some(o) if o > since => o,
            _ => since,
        };
        self.work_elapsed_ms(now).saturating_sub(anchor)
    }

    /// 开放并集当前应归工具的段 = 首段 + 尾段。无输出时首段为 0、尾段即全跨度。
    fn open_tool_deduct_ms(&self, now: Instant) -> u64 {
        self.tool_head_ms + self.open_tail_ms(now)
    }

    /// 输出活跃时长与字符（tps 分子/分母）= 已闭合 burst 合计 + 当前 burst 至今；
    /// 停顿超过 [`OUTPUT_GAP_MS`] 则当前 burst 闭合在末 chunk（其测得时长已入
    /// 合计，读数冻结不随等待下跌）。零长度 burst（整段只有一个 chunk）既不带
    /// 时长也不带字符——没有可测窗口就不虚构（E17 同款取舍）。
    fn stream_totals(&self, now: Instant) -> (u64, u64) {
        let mut chars = self.stream_chars;
        let mut ms = self.stream_ms;
        if let Some(b) = &self.burst {
            let end = if ms_between(b.last, now) > OUTPUT_GAP_MS { b.last } else { now };
            if end > b.first {
                chars += b.chars;
                ms += ms_between(b.first, end);
            }
        }
        (chars, ms)
    }

    /// 实时速率估算（tokens/s）；无可测窗口 / 无输出 → `None`。
    fn tps(&self, now: Instant) -> Option<f64> {
        let (chars, ms) = self.stream_totals(now);
        compute_tps(chars, ms)
    }

    /// 可归因于工具的时长（ms，已扣审批与生成窗口）。`None` = 跟踪越界失效；
    /// `Some(0)` = 有效观测下没记到工具（无工具事件，或状态从未显式 in_progress）
    /// —— 与旧前端 `turnToolElapsedMs` 的三态完全对齐（失效 → null，观测零 → 0，
    /// 渲染端 `formatToolDuration` 对 0 与 null 同样不渲染）。
    fn tool_elapsed_ms(&self, now: Instant) -> Option<u64> {
        if !self.tool_estimates_valid {
            return None;
        }
        Some(self.pure_tool_ms + self.open_tool_deduct_ms(now))
    }

    /// 某一时刻的完整读数快照（实时推送与定稿结算共用）。
    fn stats_at(&self, now: Instant) -> TurnStats {
        TurnStats {
            work_ms: self.work_elapsed_ms(now),
            tool_ms: self.tool_elapsed_ms(now),
            tps: self.tps(now),
        }
    }

    /// 输出字符到达：tps 白名单记账 + 推进工具展示的「末次输出」锚点（E18/E19）。
    /// 间隔 ≤ [`OUTPUT_GAP_MS`] 归入当前 burst；超阈值先闭合旧 burst（零长度不带
    /// 字符）再新起一段——中间的静默（工具执行 / 审批 / agent 循环）不进任何
    /// 一边的分母。tps 不依赖工具状态，故工具跟踪失效不影响本记账。
    fn stats_on_output(&mut self, chars: u64, now: Instant) {
        let gap_closed =
            self.burst.as_ref().is_none_or(|b| ms_between(b.last, now) > OUTPUT_GAP_MS);
        if gap_closed {
            if let Some(b) = self.burst.take()
                && b.last > b.first
            {
                self.stream_chars += b.chars;
                self.stream_ms += ms_between(b.first, b.last);
            }
            self.burst = Some(OutputBurst { first: now, last: now, chars: 0 });
        }
        if let Some(b) = self.burst.as_mut() {
            b.chars += chars;
            b.last = now;
        }
        self.last_output_work_ms = Some(self.work_elapsed_ms(now));
        if !self.active_tools.is_empty() && !self.tool_has_head {
            // 并集内首次输出：封存首段；此后首段不再增长（工具展示口径）。
            self.tool_head_ms = self.open_tool_ms(now);
            self.tool_has_head = true;
        }
    }

    /// 工具执行状态变化：只有显式 `in_progress` 才**起表**；任何其他状态
    /// （`completed` / `failed` / `pending` / 未知变体）都**释放**该 id——「不证明
    /// 正在执行」即从并集移除，与旧前端对任意非 start 状态的 delete 语义逐条对齐；
    /// 状态缺省（partial update）在 [`tool_status_update`] 处就已滤掉，保持既有状态。
    /// 越界（空 id / 超长 id / 活跃数超限）令**工具**估算整体失效并释放全部 ID，
    /// 不能丢一条活跃工具后继续假装并集完整。失效后本 turn 不再跟踪。
    fn stats_on_tool(&mut self, id: &str, status: &ToolCallStatus, now: Instant) {
        if !self.tool_estimates_valid {
            return;
        }
        match status {
            ToolCallStatus::InProgress => {
                if self.active_tools.contains(id) {
                    return;
                }
                if id.is_empty()
                    || id.encode_utf16().count() > MAX_TURN_TOOL_ID_UTF16
                    || self.active_tools.len() >= MAX_ACTIVE_TURN_TOOLS
                {
                    // 丢弃一条活跃工具后并集不再完整，工具估算整体作废（E14）；
                    // 读数会静默消失，留一条 WARN 便于定位是哪条边界被踩到。
                    tracing::warn!(
                        active_tools = self.active_tools.len(),
                        id_utf16 = id.encode_utf16().count(),
                        "tool tracking overflow; invalidating tool estimate for this turn"
                    );
                    self.tool_estimates_valid = false;
                    self.active_tools.clear();
                    self.tool_union_since_ms = None;
                    self.tool_head_ms = 0;
                    self.tool_has_head = false;
                    return;
                }
                if self.active_tools.is_empty() {
                    self.tool_union_since_ms = Some(self.work_elapsed_ms(now));
                    self.tool_head_ms = 0;
                    self.tool_has_head = false;
                }
                self.active_tools.insert(id.to_string());
            }
            _ => {
                if self.active_tools.remove(id) && self.active_tools.is_empty() {
                    // 固化本并集的非生成段（首段 + 尾段）：此后任何读数都不再
                    // 依赖它是否仍开放。
                    let tail = self.open_tail_ms(now);
                    self.pure_tool_ms += self.tool_head_ms + tail;
                    self.tool_union_since_ms = None;
                    self.tool_head_ms = 0;
                    self.tool_has_head = false;
                }
            }
        }
    }

    /// `begin_turn` 的速率与工具记账重置。
    fn reset_stats(&mut self) {
        self.burst = None;
        self.stream_chars = 0;
        self.stream_ms = 0;
        self.active_tools.clear();
        self.tool_union_since_ms = None;
        self.tool_head_ms = 0;
        self.tool_has_head = false;
        self.pure_tool_ms = 0;
        self.last_output_work_ms = None;
        self.tool_estimates_valid = true;
    }
}

/// 无输出 / 无有效时长不渲染，非有限输入或溢出绝不返回 Infinity/NaN。
fn compute_tps(output_chars: u64, elapsed_ms: u64) -> Option<f64> {
    if output_chars == 0 || elapsed_ms == 0 {
        return None;
    }
    let tps = output_chars as f64 / CHARS_PER_TOKEN as f64 / (elapsed_ms as f64 / 1000.0);
    if tps.is_finite() { Some(tps) } else { None }
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
    /// `Flush` 信号通道（有界、可丢）：writer 只需知道"有活没干"，满队列本身就是
    /// 待办信号，丢一个 ping 无损——防抖语义本来就会合并。
    cmd_tx: mpsc::Sender<WriterCmd>,
    /// `EndTurn` 专用通道（无界、可靠）。定稿跃迁**不是**可合并信号：丢了就同时丢
    /// 会话级记账（`turn_count`/`work_ms`/`wait_ms`）与消息行定稿（行永久停在
    /// `streaming`），且无日志——UI 侧仍显示耗时（`turn_timing` 读发送前就写好的
    /// `last_timing`），DB 与界面静默分叉。故不共享 `cmd_tx` 的余量：高帧率折叠能在
    /// writer 一次 DB 写内塞满 `WRITER_CHANNEL_CAPACITY`，`try_send` 届时静默失败
    /// （2026-09-21 审查发现的缺口，回归测试钉住）。
    ///
    /// 无界在此是安全的（§P1）：条目速率 = turn 速率（人工发起），writer 存活时积压量
    /// ≈ 停滞时长 ÷ turn 间隔 × 定稿载荷（百字节级）；writer 死亡则通道关闭，`send`
    /// 返回 Err 并记 WARN——不会无限增长，也不会静默。
    end_tx: mpsc::UnboundedSender<WriterCmd>,
}

enum WriterCmd {
    /// 防抖信号：只表达"该写了"。满队列时可丢——队列里已有待办信号，防抖语义
    /// 本来就会合并（`send_cmd` 的 try_send 注释）。
    Flush,
    /// turn 已定稿：落该 turn 的时长。经 [`Sink::end_tx`] **可靠投递**（可丢的
    /// `Flush` 信号通道不承载它），不要求 `row_id` —— 一帧未发的空 turn 同样消耗了
    /// 时间，会话级累计不能因为它缺一格 `turn_count`；`row_id` 只决定消息行那半边
    /// 写不写。
    EndTurn(TurnTiming),
}

/// turn 定稿时刻算好的时长。两个消费者：writer 循环据此落库，WS 层把它随
/// `prompt_done` 下发（耗时在定稿那一刻就显示，不必等刷新读 DB）。
///
/// 跨通道只传**已结算**的 `work_ms`/`wait_ms`（而非墙钟原值）：`wait_ms ≤ wall_ms` 的
/// clamp 在 `finalize_turn` 锁内做完，接收方就无需再减一次、也就不存在下溢路径。
#[derive(Debug, Clone, Serialize)]
pub struct TurnTiming {
    /// agent 实际工作时长 = `wall_ms - wait_ms`。
    pub work_ms: u64,
    /// 其中等真人审批的时长。
    pub wait_ms: u64,
    /// 可归因于工具执行的时长（ms，已扣审批与生成窗口）。`None` = 跟踪越界
    /// 失效（宁缺毋滥）；`Some(0)` = 有效观测下没记到工具。随 `prompt_done`
    /// 下发给前端当场显示，并落 `chat_messages.tool_ms` 供刷新后常驻。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_ms: Option<u64>,
    /// 输出速率估算（tokens/s，白名单口径见常量注释）。`None` = 无可测流式
    /// 窗口（宁缺毋滥）。随 `prompt_done` 下发并落 `chat_messages.tps`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tps: Option<f64>,
    /// turn 定稿时刻（RFC3339，UTC，墙钟）。在 `finalize_turn` 生成一次，writer 落
    /// `chat_messages.finished_at` 与 WS 下发共用同一值——前端底部读数主段
    /// 「结束于 14:32」据此渲染，刷新前后不变。
    pub finished_at: String,
    /// 本 turn 的 `chat_messages` 行 id，`None` = 未折叠任何帧的空 turn。
    /// 不下发：`prompt_done` 帧另有顶层 `row_id` 承载同一个值。
    #[serde(skip)]
    pub row_id: Option<String>,
}

/// 进行中 turn 的实时读数快照（WS `turn_stats` 帧的载荷）。与定稿结算同一套
/// 计算、同一把锁，只是采样时刻不同——前端只显示、不计算。
#[derive(Debug, Clone, Copy, Serialize)]
pub struct TurnStats {
    /// 工作时长（ms）= 墙钟 − 审批等待（与定稿 `work_ms` 同口径）。
    pub work_ms: u64,
    /// 工具耗时估算（ms），语义同 [`TurnTiming::tool_ms`]。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_ms: Option<u64>,
    /// 输出速率估算（tokens/s），语义同 [`TurnTiming::tps`]。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tps: Option<f64>,
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

/// 把一帧加入 turn 的帧窗口（帧数 / 字节双轴有界，从头部驱逐）。
///
/// `fold` 的 agent 帧与 [`TurnAccumulator::append_host_update`] 的宿主告知帧共用；
/// 单帧超预算时不入窗口（`text` 已另行累积，被驱逐的只是结构化恢复窗口）。
fn push_frame(st: &mut TurnState, frame: Box<serde_json::value::RawValue>) {
    let bytes = frame.get().len();
    if bytes > MAX_FRAME_BYTES {
        tracing::debug!(bytes, "dropping oversized session update frame from turn window");
        return;
    }
    st.frames.push_back(frame);
    st.frames_bytes += bytes;
    while st.frames.len() > MAX_FRAMES || st.frames_bytes > MAX_BLOCKS_BYTES {
        match st.frames.pop_front() {
            Some(old) => st.frames_bytes -= old.get().len(),
            None => break,
        }
    }
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
        let (end_tx, end_rx) = mpsc::unbounded_channel();
        if let Ok(mut guard) = self.sink.lock() {
            *guard = Some(Sink { cmd_tx, end_tx });
        }
        let acc = self.clone();
        tokio::spawn(writer_loop(acc, db, db_session_id, cmd_rx, end_rx));
    }

    /// Open a new turn. Resets per-turn state; `seq` stays monotonic.
    pub fn begin_turn(&self) {
        if let Ok(mut st) = self.inner.lock() {
            st.active = true;
            st.started = Some(Instant::now());
            st.wait_ms = 0;
            st.wait_since = None;
            st.wait_depth = 0;
            st.row_id = None;
            st.output_seen = false;
            st.last_timing = None;
            st.frames.clear();
            st.frames_bytes = 0;
            st.text.clear();
            st.dirty = false;
            st.reset_stats();
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
            // 记账只在第一次命中时做一次匹配；一旦置真就永久为真（本 turn 内不再判定）。
            if !st.output_seen {
                st.output_seen = update_is_visible_output(&notification.update);
            }
            if let Some(text) = agent_message_text(&notification.update) {
                st.text.push_str(text);
            }
            // 输出速率与工具耗时记账（口径见常量注释）：只认正文/思考的文本增量
            // 与显式执行状态。一帧至多属一类，采样时刻取实际到达时刻。
            if let Some(chars) = output_chars(&notification.update) {
                st.stats_on_output(chars, Instant::now());
            } else if let Some((id, status)) = tool_status_update(&notification.update) {
                st.stats_on_tool(id, status, Instant::now());
            }
            match serde_json::value::to_raw_value(&notification.update) {
                Ok(frame) => push_frame(&mut st, frame),
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

    /// 把宿主生成的更新帧（mid-turn SYSTEM 告知）追加到**当前 turn 的帧窗口**。
    ///
    /// 与 `fold` 的区别：不累计 `text`、不判定 `output_seen`、不喂 tps/工具记账——
    /// 系统告知不是 agent 产出。帧进入同一个有序窗口，hydrate / turn_snapshot
    /// 解码时与前后 agent 帧保持同一位置（修「system 行整行置底」）。无活跃 turn
    /// 时返回 `None`，调用方降级为独立的 system 行。
    ///
    /// 返回 `(seq, row_id)`：`seq` 供广播帧去重；`row_id` 供调用方定位本 turn 的
    /// assistant 行（当前实现用于日志/测试，线上 WS 帧不依赖它）。
    pub fn append_host_update(&self, update: &serde_json::Value) -> Option<(u64, String)> {
        let (seq, row_id) = {
            let Ok(mut st) = self.inner.lock() else { return None };
            if !st.active {
                return None;
            }
            st.seq += 1;
            if st.row_id.is_none() {
                st.row_id = Some(Uuid::new_v4().to_string());
            }
            let row_id = st.row_id.clone()?;
            match serde_json::value::to_raw_value(update) {
                Ok(frame) => push_frame(&mut st, frame),
                Err(e) => {
                    tracing::warn!("failed to serialize host update for persistence: {}", e);
                    return None;
                }
            }
            st.dirty = true;
            (st.seq, row_id)
        };
        self.send_cmd(WriterCmd::Flush);
        Some((seq, row_id))
    }

    /// 一段「等真人审批」开始：权限请求进入未决态。计数 +1，由 0 变正时起算计时。
    ///
    /// 无活跃 turn 时 no-op —— 审批可能落在 prompt 区间之外（上一 turn 已定稿），那时它
    /// 不属于任何 turn 的墙钟，计进去会把等待泄漏到下一个 turn。
    pub fn begin_wait(&self) {
        if let Ok(mut st) = self.inner.lock() {
            if !st.active {
                return;
            }
            st.wait_depth += 1;
            if st.wait_since.is_none() {
                st.wait_since = Some(Instant::now());
            }
        }
    }

    /// 一段等待里**有一个**审批得到应答：计数 -1，回到 0 才累加该段等待。
    ///
    /// 调用方须只在审批确实被消费时才调用（`PermissionManager::resolve` 返回 `false`
    /// 表示该 id 早已不在未决表中），否则计数会向下漂移。这里 saturating 而非断言，是
    /// 宁可少扣一段也不让计数变负 —— 负数会让之后整段等待都不被扣除。
    pub fn end_wait(&self) {
        let Ok(mut st) = self.inner.lock() else { return };
        if !st.active {
            return;
        }
        st.wait_depth = st.wait_depth.saturating_sub(1);
        if st.wait_depth == 0
            && let Some(since) = st.wait_since.take()
        {
            st.wait_ms += elapsed_ms(since);
        }
    }

    /// 未决审批被一次性清空：`session/cancel` 规范要求以 `Cancelled` 应答所有 pending 的
    /// `session/request_permission`。此刻等待结束，之后 agent 若在收尾则是工作不是等待。
    pub fn end_all_waits(&self) {
        let Ok(mut st) = self.inner.lock() else { return };
        if !st.active {
            return;
        }
        st.wait_depth = 0;
        if let Some(since) = st.wait_since.take() {
            st.wait_ms += elapsed_ms(since);
        }
    }

    /// Close the active turn and finalize its row. Idempotent: a no-op if no turn is
    /// active, so racing callers (send_prompt completion / cancel / crash watcher) are safe.
    ///
    /// 时长记账挂在同一个 `active → false` 跃迁上：赢得 CAS 的调用者才发 `EndTurn`，
    /// 于是每个 turn 恰好被累计一次（多调用方并发定稿不会重复计数）。
    ///
    /// 返回 `Some(timing)` = 本次调用赢得跃迁（确有进行中的 turn 被定稿，`timing.row_id`
    /// 即被定稿行的 id）；`None` = 早已定稿（无事可做）。supersede（新 prompt 顶掉未
    /// 终结 turn）与世代守卫靠这个返回值区分「我收的尾」与「轮不到我」。
    pub fn finalize_turn(&self) -> Option<TurnTiming> {
        self.finalize_turn_at(Instant::now())
    }

    /// [`Self::finalize_turn`] 的显式采样时刻版本；测试注入合成时间线，生产恒传
    /// `Instant::now()`。同一 `now` 采样读数与墙钟，保证 `work_ms + wait_ms` 与
    /// 统计口径落在同一时刻上。
    fn finalize_turn_at(&self, now: Instant) -> Option<TurnTiming> {
        let timing = {
            let Ok(mut st) = self.inner.lock() else { return None };
            if !st.active {
                return None;
            }
            st.active = false;
            // 读数快照必须先于等待段闭合采样：开放等待仍在 `wait_since` 上，
            // 工具尾段的冻结语义依赖它（与旧前端 `endTurn` 的顺序一致）。
            let stats = st.stats_at(now);
            let wall_ms = st.started.map_or(0, |s| ms_between(s, now));
            // 定稿时审批可能仍挂着（用户点取消 / reaper 卡死兜底），那一段若不结算就会被
            // 算成工作 —— 正是扣除等待想消除的失真。截到定稿时刻（计划 D5）。
            let mut wait_ms = st.wait_ms;
            if let Some(since) = st.wait_since.take() {
                wait_ms += ms_between(since, now);
            }
            // 各段等待都落在 turn 内，理论上不会超过墙钟；clamp 兜住舍入误差，让唯一
            // 一处减法（下一行）恒不下溢。
            let wait_ms = wait_ms.min(wall_ms);
            st.wait_depth = 0;
            st.wait_ms = 0;
            let timing = TurnTiming {
                work_ms: wall_ms - wait_ms,
                wait_ms,
                tool_ms: stats.tool_ms,
                tps: stats.tps,
                // 墙钟时刻取真实时钟（`now: Instant` 是单调时钟，仅供时长测量；
                // 测试注入合成时间线只影响时长数值，不影响本字段语义）。
                finished_at: chrono::Utc::now().to_rfc3339(),
                row_id: st.row_id.clone(),
            };
            st.last_timing = Some(timing.clone());
            timing
        };
        self.send_end_turn(timing.clone());
        Some(timing)
    }

    /// `Flush` 信号：best-effort。writer 只需知道有活没干，满队列本身就是待办信号
    /// （防抖语义合并），通道关闭（sink 被替换 / client 已释放）则无需再写。
    fn send_cmd(&self, cmd: WriterCmd) {
        if let Ok(guard) = self.sink.lock()
            && let Some(sink) = guard.as_ref()
        {
            // try_send: the writer only needs to know work is pending; a full queue
            // already has a pending signal, and a closed queue means no sink.
            let _ = sink.cmd_tx.try_send(cmd);
        }
    }

    /// `EndTurn` 定稿跃迁：可靠投递。无界通道的 `send` 只在 writer 已消失时失败，
    /// 此时必须留痕——定稿命令被静默丢弃会同时丢掉会话级记账与消息行定稿，而 UI 仍
    /// 显示耗时（`turn_timing` 读发送前就写好的 `last_timing`），形成 DB 与界面静默
    /// 分叉。曾经它与 `Flush` 共用一条 `try_send` 通道，信号通道被高帧率折叠塞满时
    /// 被静默丢弃（2026-09-21 审查发现，回归测试钉住）。
    fn send_end_turn(&self, timing: TurnTiming) {
        if let Ok(guard) = self.sink.lock()
            && let Some(sink) = guard.as_ref()
            && let Err(e) = sink.end_tx.send(WriterCmd::EndTurn(timing))
        {
            tracing::warn!("turn EndTurn 无法送达（writer 已退出）: {}", e);
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

    /// 本 turn（或刚定稿的那一轮）是否出现过**可见产出**帧。
    ///
    /// 与 [`Self::turn_row_id`] 同生命周期：`finalize_turn` 不清、`begin_turn` 才清，
    /// 故 turn 结束路径（`mark_prompt_idle` 之后）仍能读到本轮的值。
    ///
    /// 锁中毒时按 `true`（视为有产出）处理：这个值唯一的用途是让宿主把「协议说成功、
    /// 实际什么都没给」的静默失败显式化。中毒说明别处已经 panic，此时宁可少一条提示，
    /// 也不要给一个正常 turn 挂上错误语义（判定过宽 = 噪音，见计划 2026-09-19 风险表）。
    pub fn turn_has_visible_output(&self) -> bool {
        match self.inner.lock() {
            Ok(st) => st.output_seen,
            Err(poisoned) => poisoned.into_inner().output_seen,
        }
    }

    /// 上一次定稿结算出的时长；`None` = 当前 turn 尚未定稿过（`begin_turn` 已清）或本
    /// client 从未跑完过一个 turn。与 [`Self::turn_row_id`] 同样活到下一次 `begin_turn`，
    /// 故 `mark_prompt_idle` 之后立刻读仍能拿到本 turn 的值。
    pub fn turn_timing(&self) -> Option<TurnTiming> {
        self.inner.lock().ok()?.last_timing.clone()
    }

    /// 进行中 turn 的实时读数（WS 层按秒推送，前端只显示）。`None` = 无活跃 turn。
    /// 与定稿结算同一套计算、同一把锁，只是采样时刻不同——不存在两套口径。
    pub fn live_stats(&self) -> Option<TurnStats> {
        let st = self.inner.lock().ok()?;
        if !st.active {
            return None;
        }
        Some(st.stats_at(Instant::now()))
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

/// 距 `since` 已过的毫秒数（单调时钟）。落库的恒为**差值**，`Instant` 本身绝不入库
/// —— 它跨进程无意义（计划「风险与缓解」）。
fn elapsed_ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

/// `from → to` 的毫秒差值。饱和（`to < from` 取 0）而非 panic：合成时间线不该
/// 出现倒序，真出现时也宁可记 0 不炸连接任务。
fn ms_between(from: Instant, to: Instant) -> u64 {
    to.saturating_duration_since(from).as_millis() as u64
}

/// 这条 `SessionUpdate` 是否会在聊天流里呈现成**用户看得见的内容**
/// （正文 / 思考 / 工具卡 / 计划）。
///
/// 用于识别「协议回了正常终态、本轮却什么都没产出」的静默失败：`end_turn` 之类
/// 合法值不构成成功语义（AGENTS.md §8，实测 pi-acp 0.0.34 把 provider 403 折成
/// `end_turn`，见 `docs/reference/acp-protocol-reference.md` §6.8）。
///
/// 三个集合都**按变体**判定，不看内容长度：`agent_message_chunk` 携空串这种退化
/// 形态未观测到，为臆测加分支属过度设计（工程准则 7）。
/// - 可见产出：正文、思考、工具调用与其更新、计划。
/// - 记账/控制帧：会话元数据、用量、命令表、模式与配置变更、用户消息回声 ——
///   它们都**不是** agent 的回复，`UserMessageChunk` 只是回声。
/// - 兜底臂按「有产出」：`SessionUpdate` 是 `#[non_exhaustive]`，未来新增（含
///   `unstable_*` feature 下的 `plan_update` / advisory）一律先当作可见内容。
///   方向是刻意的：把未知变体判成「无产出」会让正常 turn 显示失败提示，而误判成
///   「有产出」只是维持改动前的静默行为 —— 可发现、不制造新噪音。
fn update_is_visible_output(update: &SessionUpdate) -> bool {
    match update {
        SessionUpdate::AgentMessageChunk(_)
        | SessionUpdate::AgentThoughtChunk(_)
        | SessionUpdate::ToolCall(_)
        | SessionUpdate::ToolCallUpdate(_)
        | SessionUpdate::Plan(_) => true,
        SessionUpdate::SessionInfoUpdate(_)
        | SessionUpdate::UsageUpdate(_)
        | SessionUpdate::AvailableCommandsUpdate(_)
        | SessionUpdate::CurrentModeUpdate(_)
        | SessionUpdate::ConfigOptionUpdate(_)
        | SessionUpdate::UserMessageChunk(_) => false,
        _ => true,
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

/// [`agent_message_text`] 的思考版：`AgentThoughtChunk` 的文本内容块。
fn agent_thought_text(update: &SessionUpdate) -> Option<&str> {
    if let SessionUpdate::AgentThoughtChunk(chunk) = update
        && let ContentBlock::Text(t) = &chunk.content
    {
        return Some(&t.text);
    }
    None
}

/// 本帧的输出字符数（tps 分子）：正文与思考的文本块按 **UTF-16 单元**计——与
/// 旧前端 `action.text.length` 同口径，保证既有读数（及 E20 的校准）逐字延续；
/// 非文本内容（图片等）不计（前端分类器同样不产出 text action）。
fn output_chars(update: &SessionUpdate) -> Option<u64> {
    let text = agent_message_text(update).or_else(|| agent_thought_text(update))?;
    Some(text.encode_utf16().count() as u64)
}

/// 本帧携带的工具执行状态：`(toolCallId, status)`。
/// - `ToolCall`（初始卡片）：status 必有（SDK 对缺省/无法识别的状态串解析为
///   `Pending`——`DefaultOnError` 语义，与旧前端「缺省不证明执行」一致）。
/// - `ToolCallUpdate`（partial update）：status 可选，缺省 = 保持既有状态。
fn tool_status_update(update: &SessionUpdate) -> Option<(&str, &ToolCallStatus)> {
    match update {
        SessionUpdate::ToolCall(t) => Some((t.tool_call_id.0.as_ref(), &t.status)),
        SessionUpdate::ToolCallUpdate(u) => {
            u.fields.status.as_ref().map(|s| (u.tool_call_id.0.as_ref(), s))
        }
        _ => None,
    }
}

/// 取下一条 writer 命令。`biased` 且 `end_rx` 优先：两条通道的 sender 同生命周期
/// （同一个 `Sink`），但无界通道里可能还有缓冲的 `EndTurn` 未消费——若让先关闭的
/// `cmd_rx` 返回 `None` 抢先结束循环，那条定稿命令就被丢在死通道里了。
async fn next_cmd(
    cmd_rx: &mut mpsc::Receiver<WriterCmd>,
    end_rx: &mut mpsc::UnboundedReceiver<WriterCmd>,
) -> Option<WriterCmd> {
    tokio::select! {
        biased;
        end = end_rx.recv() => end,
        flush = cmd_rx.recv() => flush,
    }
}

/// Debounce writer: coalesces `Flush` pings into a bounded number of SQLite writes,
/// and performs the final flush + row finalize + session work-time accumulation on
/// [`WriterCmd::EndTurn`].
async fn writer_loop(
    acc: Arc<TurnAccumulator>,
    db: SqlitePool,
    session_id: String,
    mut cmd_rx: mpsc::Receiver<WriterCmd>,
    mut end_rx: mpsc::UnboundedReceiver<WriterCmd>,
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
            match tokio::time::timeout(wait, next_cmd(&mut cmd_rx, &mut end_rx)).await {
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
            match next_cmd(&mut cmd_rx, &mut end_rx).await {
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
            WriterCmd::EndTurn(t) => {
                // 定稿前刷完最后的帧，使行内容与时长对应同一个 turn。
                // 顺手消费已排队的 Flush 信号：它们要的"写一次"由下面这次 flush_once
                // 完成（快照取的是活状态，是其超集），留着只会让定稿后再触发一次内容
                // 相同的冗余写。
                while cmd_rx.try_recv().is_ok() {}
                flush_once(&acc, &db, &session_id).await;
                pending_since = None;
                let (work, wait) = (t.work_ms as i64, t.wait_ms as i64);
                if let Some(row_id) = &t.row_id
                    && let Err(e) = chat_persistence::finalize_message(
                        &db,
                        row_id,
                        work,
                        wait,
                        t.tool_ms.map(|v| v as i64),
                        t.tps,
                        &t.finished_at,
                    )
                    .await
                {
                    tracing::warn!("failed to finalize streaming chat message: {}", e);
                }
                // 会话累计无条件写：空 turn 没有消息行，但那段时间确实发生了。
                if let Err(e) =
                    chat_persistence::accumulate_turn(&db, &session_id, work, wait).await
                {
                    tracing::warn!("failed to accumulate session work time: {}", e);
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
    use agent_client_protocol::schema::v1::{
        ConfigOptionUpdate, ContentChunk, Plan, SessionId, SessionInfoUpdate, TextContent,
        ToolCall, ToolCallUpdate, ToolCallUpdateFields, UsageUpdate,
    };
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

    /// 装内存命令通道代替真实 sink，捕获发给 writer 的命令而不触库。返回
    /// `(Flush 信号通道, EndTurn 通道)`；测试深度取 64，远超本模块测试产生的命令数。
    fn capture_cmds(
        acc: &TurnAccumulator,
    ) -> (mpsc::Receiver<WriterCmd>, mpsc::UnboundedReceiver<WriterCmd>) {
        let (tx, rx) = mpsc::channel(64);
        let (end_tx, end_rx) = mpsc::unbounded_channel();
        *acc.sink.lock().expect("sink lock") = Some(Sink { cmd_tx: tx, end_tx });
        (rx, end_rx)
    }

    /// 取走 EndTurn 通道里已排队的命令，只留下载荷（每 turn 至多一条）。
    /// 前三位是历史字段（既有断言的索引依赖），速率与工具读数追加在后。
    #[allow(clippy::type_complexity)]
    fn end_turns(
        rx: &mut mpsc::UnboundedReceiver<WriterCmd>,
    ) -> Vec<(u64, u64, Option<String>, Option<u64>, Option<f64>)> {
        let mut out = Vec::new();
        while let Ok(cmd) = rx.try_recv() {
            if let WriterCmd::EndTurn(t) = cmd {
                out.push((t.work_ms, t.wait_ms, t.row_id, t.tool_ms, t.tps));
            }
        }
        out
    }

    /// 直读等待计时的中间态：`(未决审批数, 等待段是否在走, 已累加等待 ms)`。
    fn wait_state(acc: &TurnAccumulator) -> (u32, bool, u64) {
        let st = acc.inner.lock().expect("lock");
        (st.wait_depth, st.wait_since.is_some(), st.wait_ms)
    }

    /// 等待一段可被毫秒时钟分辨的时间。阈值一律取下限的 6 成，避免调度抖动致脆。
    fn nap(ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
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

        assert!(acc.finalize_turn().is_some(), "有活跃 turn 时定稿必须赢得跃迁");
        assert_eq!(acc.turn_row_id().as_deref(), Some(row_id.as_str()), "定稿后仍可读到");

        acc.begin_turn();
        assert_eq!(acc.turn_row_id(), None, "下一 turn 开始才清除");
    }

    /// 时长载荷的存活契约与 `turn_row_id` 同源：WS 层在 `mark_prompt_idle` **之后**读它
    /// 拼 `prompt_done` 的 `duration`，前端据此当场显示耗时。
    #[test]
    fn timing_is_readable_after_finalize_and_reset_by_next_turn() {
        let acc = TurnAccumulator::new();
        assert!(acc.turn_timing().is_none(), "从未定稿过 → None");

        acc.begin_turn();
        assert!(acc.turn_timing().is_none(), "turn 进行中不得读到上一 turn 的结算值");
        nap(20);
        assert!(acc.finalize_turn().is_some(), "有活跃 turn 时定稿必须赢得跃迁");
        let t = acc.turn_timing().expect("定稿后 WS 层仍要能读到");
        assert!(t.work_ms >= 12, "墙钟应记进 work_ms，实得 {}", t.work_ms);
        assert_eq!(t.wait_ms, 0, "本 turn 没有审批等待");

        acc.begin_turn();
        assert!(acc.turn_timing().is_none(), "下一 turn 开始才清除");
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

    // ---- 工作时长记账（docs/dev/plans/archive/2026-08-30-acp-work-time.md）----

    /// 并发定稿只能记一次账：多个收尾路径（prompt 完成 / cancel 兜底 / reaper /
    /// 崩溃看护）都会调 `finalize_turn`，若不去重就会把同一 turn 累计多遍。
    #[test]
    fn repeated_finalize_turn_emits_exactly_one_end_turn() {
        let acc = TurnAccumulator::new();
        let (_flush_rx, mut end_rx) = capture_cmds(&acc);
        let sid = SessionId::new("s1");

        acc.begin_turn();
        acc.fold(&text_chunk(&sid, "hello"));
        // 返回值语义：首个调用赢得跃迁，其余全部是无操作 —— 世代守卫/看门狗路径
        // 靠这个区分「我收的尾」（才广播终态帧）与「轮不到我」。
        assert!(acc.finalize_turn().is_some(), "首个定稿调用赢得跃迁");
        assert!(acc.finalize_turn().is_none(), "重复定稿必须是无操作");
        assert!(acc.finalize_turn().is_none(), "重复定稿必须是无操作");

        let turns = end_turns(&mut end_rx);
        assert_eq!(turns.len(), 1, "重复定稿不得重复发记账命令，得到 {turns:?}");
        assert!(turns[0].2.is_some(), "折叠过帧的 turn 应携带消息行 id");
    }

    /// 深度模型：并发未决审批下，只应答其中一个时等待**不能**提前结束（布尔标志会错），
    /// 全部应答完才累加那一段。
    #[test]
    fn concurrent_permits_hold_one_wait_segment_until_all_resolve() {
        let acc = TurnAccumulator::new();
        acc.begin_turn();

        acc.begin_wait();
        acc.begin_wait();
        nap(50);
        acc.end_wait();
        let (depth, running, waited) = wait_state(&acc);
        assert_eq!(depth, 1, "还剩一个未决审批");
        assert!(running, "仍有未决审批时等待段不得结束");
        assert_eq!(waited, 0, "集合未清空前不得累加，得到 {waited}");

        acc.end_wait();
        let (depth, running, waited) = wait_state(&acc);
        assert_eq!((depth, running), (0, false), "全部应答后等待段应关闭");
        assert!(waited >= 30, "清空时应累加整段等待，得到 {waited}ms");

        // 多余的 end_wait（例如另一条连接重复应答）不得让计数变负、不得再开新段。
        acc.end_wait();
        assert_eq!(wait_state(&acc).0, 0, "计数下溢须被 saturating 挡住");
    }

    /// 定稿时审批仍挂着（用户点取消 / reaper 卡死兜底的真实时序）：那一段等待必须
    /// 截到定稿时刻结算，否则会被算成工作时间（计划 D5）。
    #[test]
    fn finalize_clips_an_open_wait_segment() {
        let acc = TurnAccumulator::new();
        let (_flush_rx, mut end_rx) = capture_cmds(&acc);

        acc.begin_turn();
        acc.begin_wait();
        nap(50);
        assert!(acc.finalize_turn().is_some());

        let turns = end_turns(&mut end_rx);
        assert_eq!(turns.len(), 1, "一个 turn 只应有一条记账：{turns:?}");
        let (work, wait, _, _, _) = &turns[0];
        assert!(*wait >= 30, "未决审批那段应截到定稿时刻计入 wait，得到 {wait}ms");
        // 唯一一处减法在 finalize 锁内且已 clamp，故 work 恒非负、两者相加即墙钟。
        assert!(*work <= 50, "等待不得反噬工作时长，work={work} wait={wait}");
        assert!(*work + *wait >= 50, "work + wait 应覆盖整段墙钟（{work} + {wait}）");
    }

    /// 一帧未发的空 turn（agent 立即报错返回）没有消息行，但那段时间确实发生了 ——
    /// 记账命令必须照样发出，`row_id` 为 None 让 writer 跳过消息行那半边。
    #[test]
    fn empty_turn_is_still_accounted() {
        let acc = TurnAccumulator::new();
        let (_flush_rx, mut end_rx) = capture_cmds(&acc);

        acc.begin_turn();
        nap(20);
        assert!(acc.finalize_turn().is_some());

        let turns = end_turns(&mut end_rx);
        assert_eq!(turns.len(), 1, "空 turn 也要记账，得到 {turns:?}");
        assert_eq!(turns[0].2, None, "未折叠任何帧 → 无消息行 id");
    }

    /// turn 之外到达的审批（上一 turn 已定稿、agent 自行发起）不得泄漏到下一个 turn
    /// 的等待账上，否则下一个正常 turn 会被整段算成等待。
    #[test]
    fn wait_outside_an_active_turn_is_dropped() {
        let acc = TurnAccumulator::new();
        let (_flush_rx, mut end_rx) = capture_cmds(&acc);

        acc.begin_wait();
        acc.end_all_waits();
        assert_eq!(wait_state(&acc), (0, false, 0), "无活跃 turn 时两个动作都应为 no-op");

        acc.begin_turn();
        nap(20);
        assert!(acc.finalize_turn().is_some());

        let turns = end_turns(&mut end_rx);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].1, 0, "turn 外的审批不得算进本 turn 的等待：{:?}", turns[0]);
    }

    /// `end_all_waits`（session/cancel 会以 Cancelled 应答全部未决审批）就地结束等待段，
    /// 之后 agent 的收尾时间算工作而非等待。
    #[test]
    fn end_all_waits_closes_an_open_segment_immediately() {
        let acc = TurnAccumulator::new();
        let (_flush_rx, mut end_rx) = capture_cmds(&acc);
        acc.begin_turn();
        acc.begin_wait();
        acc.begin_wait();
        nap(30);
        acc.end_all_waits();
        let (depth, running, waited) = wait_state(&acc);
        assert_eq!((depth, running), (0, false), "全部取消后不得继续走等待表");
        assert!(waited >= 18, "取消时刻即该段终点，得到 {waited}ms");

        // 取消后 agent 继续干活的 30ms 必须归工作：若等待表没在取消时结掉，会被算进 wait。
        nap(30);
        assert!(acc.finalize_turn().is_some());
        let turns = end_turns(&mut end_rx);
        assert_eq!(turns.len(), 1, "应恰好一条 EndTurn：{turns:?}");
        let (work, wait, _, _, _) = &turns[0];
        assert!(*work >= 18, "取消后的收尾应算工作，得到 {work}ms");
        assert!(*wait < 48, "等待不得把取消后的收尾也算进去，得到 {wait}ms");
    }

    /// 回归（2026-09-21 审查发现）：`EndTurn` 曾与 `Flush` 信号共用一条 `try_send`
    /// 通道。信号通道被高帧率折叠塞满时（writer 卡在一次 DB 写内，万级帧率下 25ms
    /// 即可填满 256 深度），定稿命令被**静默丢弃**——会话级记账（`turn_count` /
    /// `work_ms` / `wait_ms`）与消息行定稿（`finalize_message`，行永久停在
    /// `streaming`）同时丢失，且无日志；UI 却照显示耗时（`turn_timing` 读发送前就
    /// 写好的 `last_timing`），DB 与界面静默分叉。定稿跃迁必须走独立可靠通道，
    /// 不依赖信号通道余量。
    #[test]
    fn end_turn_is_delivered_when_the_flush_signal_channel_is_saturated() {
        let acc = TurnAccumulator::new();
        let sid = SessionId::new("s1");
        // 容量 2 的信号通道：折叠几帧即满，复现"writer 卡在 DB 写内、ping 积压"现场。
        let (flush_tx, _flush_rx) = mpsc::channel(2);
        let probe = flush_tx.clone();
        let (end_tx, mut end_rx) = mpsc::unbounded_channel();
        *acc.sink.lock().expect("sink lock") = Some(Sink { cmd_tx: flush_tx, end_tx });

        acc.begin_turn();
        for i in 0..8 {
            acc.fold(&text_chunk(&sid, format!("chunk {i}")));
        }
        assert!(
            probe.try_send(WriterCmd::Flush).is_err(),
            "前置条件：Flush 信号通道应已被折叠 ping 塞满"
        );

        assert!(acc.finalize_turn().is_some());

        let turns = end_turns(&mut end_rx);
        assert_eq!(turns.len(), 1, "信号通道饱和时 EndTurn 仍须恰好送达一次：{turns:?}");
        assert!(turns[0].2.is_some(), "折叠过帧的 turn 应携带消息行 id");
    }

    // ── 可见产出判定（空 turn 留痕的输入） ───────────────────────────────

    fn fold_one(update: SessionUpdate) -> bool {
        let acc = TurnAccumulator::new();
        let (_flush_rx, _end_rx) = capture_cmds(&acc);
        let sid = SessionId::new("s-visible");
        acc.begin_turn();
        acc.fold(&SessionNotification::new(sid, update));
        acc.turn_has_visible_output()
    }

    /// 变体分类表：正文 / 思考 / 工具（含纯工具 turn，正式库里「有工具卡无正文」
    /// 是真实形态）/ 计划算可见；记账与控制帧、以及**用户消息回声**不算 ——
    /// 只回声一次的 turn 对用户同样等于什么都没产出。
    #[test]
    fn visible_output_classification_follows_the_variant_table() {
        assert!(fold_one(SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::Text(
            TextContent::new("想")
        )))));
        assert!(fold_one(SessionUpdate::ToolCall(ToolCall::new("t1", "跑命令"))));
        assert!(fold_one(SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(
            "t1",
            ToolCallUpdateFields::default()
        ))));
        assert!(fold_one(SessionUpdate::Plan(Plan::new(vec![]))));

        assert!(!fold_one(SessionUpdate::UsageUpdate(UsageUpdate::new(1, 2))));
        assert!(!fold_one(SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new())));
        assert!(!fold_one(SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(vec![]))));
        assert!(!fold_one(SessionUpdate::UserMessageChunk(ContentChunk::new(ContentBlock::Text(
            TextContent::new("用户那句话")
        )))));
    }

    /// 实测事故形态（正式库会话 `Pi ACP_1009-1438`）：pi-acp 把 provider 403 折成
    /// `end_turn`，一轮里只有 running 标志 + 用量两种记账帧。折叠了三帧、开了消息行，
    /// 可见产出仍为假 —— 单看 `row_id` 会把这种空气泡判成「有内容」。
    #[test]
    fn bookkeeping_only_turn_reports_no_visible_output() {
        let acc = TurnAccumulator::new();
        let (_flush_rx, _end_rx) = capture_cmds(&acc);
        let sid = SessionId::new("s-empty");
        acc.begin_turn();
        acc.fold(&SessionNotification::new(
            sid.clone(),
            SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new()),
        ));
        acc.fold(&SessionNotification::new(
            sid.clone(),
            SessionUpdate::UsageUpdate(UsageUpdate::new(21692, 512000)),
        ));
        acc.fold(&SessionNotification::new(
            sid,
            SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new()),
        ));

        assert!(acc.turn_row_id().is_some(), "前置条件：记账帧同样会开出一行（空气泡的来源）");
        assert!(!acc.turn_has_visible_output(), "只折叠记账帧 → 无可见产出");

        assert!(acc.finalize_turn().is_some());
        assert!(!acc.turn_has_visible_output(), "定稿后仍要读得到本 turn 的判定值");
    }

    /// 一帧可见内容之后，后续全是记账帧也必须为真：判定是「本轮出现过」而非
    /// 「窗口里现在还有」。
    #[test]
    fn visible_output_latches_once_seen_and_resets_on_begin_turn() {
        let acc = TurnAccumulator::new();
        let (_flush_rx, _end_rx) = capture_cmds(&acc);
        let sid = SessionId::new("s-latch");

        acc.begin_turn();
        acc.fold(&text_chunk(&sid, "正文"));
        for _ in 0..5 {
            acc.fold(&SessionNotification::new(
                sid.clone(),
                SessionUpdate::UsageUpdate(UsageUpdate::new(1, 1)),
            ));
        }
        assert!(acc.turn_has_visible_output());

        acc.begin_turn();
        assert!(
            !acc.turn_has_visible_output(),
            "begin_turn 必须清零，否则上一轮的产出会掩盖本轮的空气泡"
        );
    }

    /// 帧窗口从头部驱逐后判定不变 —— 窗口是崩溃恢复兜底、不是历史存档
    /// （见 2026-08-10 计划「未决问题」勘误），拿它当依据会把长 turn 误判成空。
    #[test]
    fn visible_output_survives_frame_eviction() {
        let acc = TurnAccumulator::new();
        let (_flush_rx, _end_rx) = capture_cmds(&acc);
        let sid = SessionId::new("s-evict");

        acc.begin_turn();
        acc.fold(&text_chunk(&sid, "唯一一句正文"));
        // 每帧约 40KB，4 帧即触到 MAX_BLOCKS_BYTES 的字节预算 → 旧帧（含那句正文）被驱逐。
        let fat = "x".repeat(40 * 1024);
        for _ in 0..8 {
            acc.fold(&SessionNotification::new(
                sid.clone(),
                SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::Text(
                    TextContent::new(&fat),
                ))),
            ));
        }

        let (len, bytes) = retained_frames(&acc);
        assert!(len < 8, "前置条件：可见帧应已被字节预算驱逐，窗口仍留 {len} 帧");
        assert!(bytes <= MAX_BLOCKS_BYTES, "窗口须守字节预算：{bytes} B");
        assert!(acc.turn_has_visible_output(), "驱逐掉的可见帧不得把判定翻成假");
    }

    // ── 速率（tps）与工具耗时记账 ─────────────────────────────────────────
    // 口径 2026-10-15 自前端 `utils/turnClock.ts` 整体迁移至后端（work-time 计划
    // E23）。以下向量按旧前端测试逐条移植（同名场景、同期望值），保证读数连续。
    // 时间一律合成注入（旧前端 `at` 参数的 Rust 版）：不引入真实等待，逐毫秒对齐。

    /// 合成时间线：`base + ms`。
    fn at(base: Instant, ms: u64) -> Instant {
        base + Duration::from_millis(ms)
    }

    /// 起一个合成时钟的 turn（`begin_turn` 后把起点覆写为 `base`）。
    fn begin_turn_at(acc: &TurnAccumulator, base: Instant) {
        acc.begin_turn();
        acc.inner.lock().expect("lock").started = Some(base);
    }

    /// 合成时钟的等待段开关（生产同款语义见 `begin_wait` / `end_wait`）。
    fn open_wait(st: &mut TurnState, at_: Instant) {
        st.wait_depth += 1;
        if st.wait_since.is_none() {
            st.wait_since = Some(at_);
        }
    }

    fn close_wait(st: &mut TurnState, at_: Instant) {
        st.wait_depth = st.wait_depth.saturating_sub(1);
        if st.wait_depth == 0
            && let Some(since) = st.wait_since.take()
        {
            st.wait_ms += ms_between(since, at_);
        }
    }

    fn assert_tps(actual: Option<f64>, expected: f64) {
        let value = actual.expect("应测得速率");
        assert!((value - expected).abs() < 1e-6, "tps 期望 {expected}，实得 {value}");
    }

    fn in_progress() -> ToolCallStatus {
        ToolCallStatus::InProgress
    }

    /// `char/4/(ms/1000)` 的换算与三态：0 输出 / 0 时长 → `None`，不产生 NaN/Inf。
    #[test]
    fn compute_tps_converts_and_rejects_zero() {
        assert_eq!(compute_tps(0, 1_000), None);
        assert_eq!(compute_tps(40, 0), None);
        assert_eq!(compute_tps(40, 1_000), Some(10.0));
        assert_eq!(compute_tps(80, 2_000), Some(10.0));
        assert_eq!(compute_tps(20, 1_000), Some(5.0));
    }

    /// 首字前的等待不进分母：解码窗口从首个输出起算（E17）。单 chunk 无可测窗口。
    #[test]
    fn decode_window_starts_at_first_output() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(1_200, at(base, 8_000));
        assert_eq!(st.tps(at(base, 8_000)), None, "单 chunk 无可测窗口，不把等待算成生成");
        st.stats_on_output(1_200, at(base, 9_000));
        assert_tps(st.tps(at(base, 9_000)), 600.0); // 2_400 字符 ÷ 4 ÷ 1s
    }

    /// 输出间隔 ≤ 阈值归入同一 burst（窗口延长到 now）；超阈值闭合在末 chunk。
    #[test]
    fn gap_within_threshold_extends_the_open_window() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 0));
        st.stats_on_output(400, at(base, 800));
        assert_tps(st.tps(at(base, 1_700)), 800.0 / 4.0 / 1.7);
        assert_tps(st.tps(at(base, 2_000)), 800.0 / 4.0 / 0.8);
    }

    /// 审批挂起期间读数冻结在最后测得值（burst 已闭合），解除后新输出另起一段。
    #[test]
    fn approval_wait_freezes_the_reading_and_output_resumes() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 1_000));
        st.stats_on_output(400, at(base, 2_000)); // burst [1s,2s]
        open_wait(&mut st, at(base, 2_000));
        // 挂 5 分钟：burst 早已闭合，读数一动不动，不随真人思考时间跌落。
        assert_tps(st.tps(at(base, 300_000)), 200.0);
        close_wait(&mut st, at(base, 302_000));
        assert_tps(st.tps(at(base, 302_000)), 200.0);
        // 恢复吐字：间隔远超阈值 → 新开一段，两段字符合计 ÷ 合计时长。
        st.stats_on_output(800, at(base, 303_000));
        assert_tps(st.tps(at(base, 303_000)), 200.0);
        st.stats_on_output(800, at(base, 304_000));
        assert_tps(st.tps(at(base, 304_000)), 300.0); // 2_400 字符 ÷ 2s
    }

    /// 审批挂起与工具并集同时冻住；挂起段不计入工具，tps 只看输出流（白名单）。
    #[test]
    fn wait_freezes_tool_union_and_whitelist_ignores_tools() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 0));
        st.stats_on_tool("a", &in_progress(), at(base, 1_000));
        open_wait(&mut st, at(base, 2_000));
        assert_eq!(st.tool_elapsed_ms(at(base, 120_000)), Some(1_000), "并集跨度冻在挂起那刻");
        assert_eq!(st.tps(at(base, 120_000)), None, "单 chunk 无可测窗口");
        st.stats_on_output(400, at(base, 60_000));
        assert_eq!(st.tps(at(base, 60_000)), None);
        close_wait(&mut st, at(base, 122_000));
        assert_eq!(st.work_elapsed_ms(at(base, 122_000)), 2_000, "挂起的 120s 不算工作");
        assert_eq!(st.tool_elapsed_ms(at(base, 122_000)), Some(1_000));
        assert_eq!(st.tps(at(base, 122_000)), None);
    }

    /// 首个输出落在工具并集内：首段（并集起点 → 首输出）封存，静默尾段归工具。
    #[test]
    fn first_output_inside_union_seals_head_and_tail() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_tool("a", &in_progress(), at(base, 1_000));
        st.stats_on_output(1_200, at(base, 4_000));
        assert_eq!(st.tps(at(base, 4_000)), None, "零长度窗口，不把工具时间算成生成");
        st.stats_on_tool("a", &ToolCallStatus::Completed, at(base, 6_000));
        assert_eq!(st.tps(at(base, 6_000)), None);
        assert_eq!(
            st.tool_elapsed_ms(at(base, 6_000)),
            Some(5_000),
            "首段 [1s,4s] + 静默尾段 [4s,6s]"
        );
    }

    /// 模型持续吐字期间工具表冻结（E18）：每次输出把「末次输出」前移，尾段从头起算。
    #[test]
    fn prose_streaming_freezes_tool_timing_and_resumes_after_last_delta() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_tool("a", &in_progress(), at(base, 1_000));
        assert_eq!(st.tool_elapsed_ms(at(base, 2_000)), Some(1_000));
        st.stats_on_output(400, at(base, 2_000));
        assert_eq!(st.tool_elapsed_ms(at(base, 2_000)), Some(1_000));
        st.stats_on_output(400, at(base, 2_500));
        assert_eq!(st.tool_elapsed_ms(at(base, 2_500)), Some(1_000));
        st.stats_on_output(400, at(base, 11_500));
        assert_eq!(st.tool_elapsed_ms(at(base, 11_500)), Some(1_000));
        st.stats_on_output(400, at(base, 12_000));
        assert_eq!(st.tool_elapsed_ms(at(base, 12_000)), Some(1_000));
        // 末次输出之后到并集关闭的 1.5s 无新输出证据：静默执行段归工具（E19）。
        st.stats_on_tool("a", &ToolCallStatus::Completed, at(base, 13_500));
        assert_eq!(st.tool_elapsed_ms(at(base, 13_500)), Some(2_500));
        // 白名单：两个 burst 各 800 字符 ÷ 0.5s，中间的 9s 静默不进分母。
        assert_tps(st.tps(at(base, 13_500)), 400.0);
    }

    /// 首字之后整段落在工具内且无后续输出：无可测速率（宁 null 不虚报），工具照记。
    #[test]
    fn tool_only_silence_yields_no_rate() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 1_000));
        st.stats_on_tool("a", &in_progress(), at(base, 1_000));
        assert_eq!(st.work_elapsed_ms(at(base, 11_000)), 11_000);
        assert_eq!(st.tool_elapsed_ms(at(base, 11_000)), Some(10_000));
        assert_eq!(st.tps(at(base, 11_000)), None);

        let timing = {
            drop(st);
            acc.finalize_turn_at(at(base, 11_000)).expect("定稿")
        };
        assert_eq!(timing.tool_ms, Some(10_000));
        assert_eq!(timing.tps, None);
    }

    /// 并行工具的重叠只计一次；并集在**最后一个**工具结束时才关闭。
    #[test]
    fn parallel_tools_count_once_and_close_after_the_last() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 1_000));
        st.stats_on_tool("a", &in_progress(), at(base, 1_000));
        st.stats_on_tool("b", &in_progress(), at(base, 2_000));
        st.stats_on_tool("a", &in_progress(), at(base, 3_000)); // 重复 start：幂等
        st.stats_on_tool("a", &ToolCallStatus::Completed, at(base, 4_000));
        st.stats_on_tool("a", &ToolCallStatus::Completed, at(base, 5_000)); // 重复结束：无操作
        assert_eq!(st.tool_elapsed_ms(at(base, 6_000)), Some(5_000));
        st.stats_on_tool("b", &ToolCallStatus::Failed, at(base, 7_000));
        assert_eq!(st.tool_elapsed_ms(at(base, 8_000)), Some(6_000));
        assert_eq!(st.tps(at(base, 8_000)), None);
    }

    /// 审批与工具并集重叠只扣一次（工作坐标度量）；定稿时仍挂着的审批截到定稿时刻。
    #[test]
    fn approval_overlap_deducts_once_from_work_and_tools() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 1_000));
        st.stats_on_tool("a", &in_progress(), at(base, 1_000));
        open_wait(&mut st, at(base, 2_000));
        st.stats_on_tool("b", &in_progress(), at(base, 3_000));
        st.stats_on_tool("a", &ToolCallStatus::Completed, at(base, 4_000));
        close_wait(&mut st, at(base, 5_000));
        open_wait(&mut st, at(base, 7_000));
        assert_eq!(st.work_elapsed_ms(at(base, 10_000)), 4_000);
        assert_eq!(st.tool_elapsed_ms(at(base, 10_000)), Some(3_000));
        assert_eq!(st.tps(at(base, 10_000)), None, "解码窗口全落在工具并集内");

        let timing = {
            drop(st);
            acc.finalize_turn_at(at(base, 10_000)).expect("定稿")
        };
        assert_eq!(timing.tool_ms, Some(3_000));
        assert_eq!(timing.tps, None);
        assert_eq!(timing.work_ms, 4_000, "未决审批那段截到定稿时刻计入 wait");
    }

    /// 只有显式 in_progress 才起表；pending / 缺省状态不证明执行（缺省在帧分类处
    /// 已滤掉），其中 pending 会**释放**并集成员（与旧前端 delete 语义一致）。
    #[test]
    fn explicit_status_only_and_pending_releases() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 1_000));
        st.stats_on_tool("b", &ToolCallStatus::Pending, at(base, 1_000));
        assert_eq!(st.tool_elapsed_ms(at(base, 3_000)), Some(0), "pending 不起表");
        st.stats_on_tool("a", &in_progress(), at(base, 3_000));
        assert_eq!(st.tool_elapsed_ms(at(base, 5_000)), Some(2_000));
        st.stats_on_tool("a", &ToolCallStatus::Pending, at(base, 5_000));
        assert_eq!(
            st.tool_elapsed_ms(at(base, 7_000)),
            Some(2_000),
            "pending 释放并集，此后不再走表"
        );
        assert_eq!(st.tps(at(base, 7_000)), None);
    }

    /// 静默尾段归工具、并集关闭后新并集另记（E19 的组合形态）。
    #[test]
    fn silent_tail_stays_tool_time_across_unions() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 1_000));
        st.stats_on_tool("a", &in_progress(), at(base, 1_000));
        open_wait(&mut st, at(base, 2_000));
        close_wait(&mut st, at(base, 4_000));
        assert_eq!(st.tps(at(base, 5_000)), None);
        assert_eq!(st.tps(at(base, 6_000)), None);
        st.stats_on_output(400, at(base, 5_000)); // 并集内输出：封存首段
        assert_eq!(st.tps(at(base, 5_000)), None);
        assert_tps(st.tps(at(base, 6_000)), 100.0); // 400 字符 ÷ 1s（开放窗口含 ≤1s 容差）
        st.stats_on_tool("b", &in_progress(), at(base, 6_000));
        st.stats_on_tool("a", &ToolCallStatus::Completed, at(base, 7_000));
        st.stats_on_tool("b", &ToolCallStatus::Completed, at(base, 8_000));
        st.stats_on_tool("c", &in_progress(), at(base, 9_000));

        let timing = {
            drop(st);
            acc.finalize_turn_at(at(base, 11_000)).expect("定稿")
        };
        // a/b 并集的非生成段 [1s,6s] + c 开放并集的 [7s,9s]，共 7s。
        assert_eq!(timing.tool_ms, Some(7_000));
        assert_eq!(timing.tps, None, "两个孤立 chunk 各自单段：无可测流式窗口");
    }

    /// 活跃跟踪越界（条数）→ 工具估算整体失效；work 与 tps 不受影响（E20 解耦）。
    #[test]
    fn tool_overflow_invalidates_tools_not_work_or_rate() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 1_000));
        for i in 0..MAX_ACTIVE_TURN_TOOLS {
            st.stats_on_tool(&format!("tool-{i}"), &in_progress(), at(base, 1_000));
        }
        assert_eq!(st.tool_elapsed_ms(at(base, 2_000)), Some(1_000));
        st.stats_on_tool("overflow", &in_progress(), at(base, 2_000));
        assert_eq!(st.work_elapsed_ms(at(base, 3_000)), 3_000, "越界不得动工作计时");
        assert_eq!(st.tool_elapsed_ms(at(base, 3_000)), None, "越界 → 工具读数整体作废");
        assert_eq!(st.tps(at(base, 3_000)), None);
    }

    /// 单条 ID 超长（UTF-16 口径）同样令工具估算失效；tps 照常可测（白名单解耦）。
    #[test]
    fn oversized_tool_id_drops_tools_but_keeps_rate() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 1_000));
        st.stats_on_output(400, at(base, 1_500)); // burst [1s,1.5s]
        st.stats_on_tool(&"x".repeat(MAX_TURN_TOOL_ID_UTF16 + 1), &in_progress(), at(base, 1_000));

        let timing = {
            drop(st);
            acc.finalize_turn_at(at(base, 2_600)).expect("定稿")
        };
        assert_tps(timing.tps, 400.0); // 800 字符 ÷ 0.5s
        assert_eq!(timing.tool_ms, None, "超长 ID 被丢出并集 → 工具估算作废");
    }

    /// 顺序工具不会耗尽活跃跟踪（完成即释放）。
    #[test]
    fn sequential_tools_release_ids_and_do_not_overflow() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let mut st = acc.inner.lock().expect("lock");

        st.stats_on_output(400, at(base, 1_000));
        for i in 0..=MAX_ACTIVE_TURN_TOOLS {
            let id = format!("tool-{i}");
            st.stats_on_tool(&id, &in_progress(), at(base, 1_000 + i as u64));
            st.stats_on_tool(&id, &ToolCallStatus::Completed, at(base, 1_001 + i as u64));
        }
        st.stats_on_output(1_200, at(base, 2_000));
        // 唯一 burst [1s,2s]，1_600 字符 ÷ 1s。
        assert_tps(st.tps(at(base, 3_257)), 400.0);
    }

    /// 定稿前的孤立尾 chunk 不带字符（零长度 burst 不虚构时长）。
    #[test]
    fn isolated_tail_chunk_contributes_nothing_at_finalize() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        {
            let mut st = acc.inner.lock().expect("lock");
            st.stats_on_output(400, at(base, 0));
            st.stats_on_output(400, at(base, 500)); // burst [0,500ms]
            st.stats_on_output(4, at(base, 5_000)); // 定稿前一句 "done"
        }
        let timing = acc.finalize_turn_at(at(base, 6_100)).expect("定稿");
        assert_tps(timing.tps, 400.0); // 800 字符 ÷ 0.5s
    }

    /// 一帧未发的空 turn：定稿读数「有效但零工具 / 无速率」，与「失效」是两回事。
    #[test]
    fn empty_turn_reports_zero_tools_and_no_rate() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let timing = acc.finalize_turn_at(at(base, 20)).expect("空 turn 也要定稿");
        assert_eq!(timing.tool_ms, Some(0), "有效观测下没记到工具 = 0，非 None");
        assert_eq!(timing.tps, None);
    }

    /// `live_stats`：无活跃 turn → None；活跃期读数可取；定稿后回到 None。
    #[test]
    fn live_stats_tracks_turn_lifecycle() {
        let acc = TurnAccumulator::new();
        assert!(acc.live_stats().is_none(), "无 turn 时无读数");

        acc.begin_turn();
        let stats = acc.live_stats().expect("活跃 turn 应有读数");
        assert!(stats.tool_ms.is_some(), "有效观测的活跃 turn 恒有工具读数（可为 0）");
        assert_eq!(stats.tps, None, "尚无输出 → 无速率");

        acc.finalize_turn().expect("定稿");
        assert!(acc.live_stats().is_none(), "定稿后不再有实时读数");
    }

    /// 端到端：fold 真帧驱动记账 —— 正文 chunk 计数、思考 chunk 计数、工具状态起表；
    /// 用真实时钟的小步长 + 容差断言（合成时间线覆盖精确口径，这里覆盖接线）。
    #[test]
    fn fold_drives_rate_and_tool_accounting() {
        let acc = TurnAccumulator::new();
        let (_flush_rx, _end_rx) = capture_cmds(&acc);
        let sid = SessionId::new("s-stats");
        acc.begin_turn();

        // 两个间隔极小的正文 chunk → 可测窗口存在（时长 > 0）。
        acc.fold(&text_chunk(&sid, "你好，世界。"));
        nap(30);
        acc.fold(&text_chunk(&sid, "继续输出。"));
        // 思考 chunk 同样计入分子。
        acc.fold(&SessionNotification::new(
            sid.clone(),
            SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::Text(
                TextContent::new("思考中。"),
            ))),
        ));
        // 工具执行状态帧：显式 in_progress → 起表。
        let fields = {
            let mut f = ToolCallUpdateFields::default();
            f.status = Some(in_progress());
            f
        };
        acc.fold(&SessionNotification::new(
            sid.clone(),
            SessionUpdate::ToolCallUpdate(ToolCallUpdate::new("t1", fields)),
        ));

        // 与工具起表拉开一小段，保证尾段时长可测（> 0ms）。
        nap(20);
        let stats = acc.live_stats().expect("活跃 turn 应有读数");
        assert!(stats.work_ms >= 20, "工作时长应走表，实得 {}", stats.work_ms);
        assert!(stats.tool_ms.unwrap_or(0) > 0, "工具应已起表，实得 {:?}", stats.tool_ms);
        assert!(stats.tps.unwrap_or(0.0) > 0.0, "有输出应有速率，实得 {:?}", stats.tps);
    }

    /// mid-turn SYSTEM 告知帧进入同一帧窗口，且不改变 agent 产出判定/文本/统计。
    #[test]
    fn host_update_is_inlined_without_counting_as_agent_output() {
        let acc = TurnAccumulator::new();
        let base = Instant::now();
        begin_turn_at(&acc, base);
        let update = serde_json::json!({
            "sessionUpdate": "session_info_update",
            "_meta": { "omnitermSystem": { "id": "notice-1", "label": "system.permTimeout.auto" } }
        });
        let (seq, row_id) = acc.append_host_update(&update).expect("活跃 turn 应接受宿主帧");
        assert_eq!(row_id, acc.turn_row_id().expect("row id"));
        let snap = acc.turn_snapshot();
        assert_eq!(snap.seq, seq);
        assert!(snap.text.is_empty(), "宿主告知不写 agent text");
        assert!(!acc.turn_has_visible_output(), "宿主告知不是 agent 可见产出");
        let parsed: serde_json::Value = serde_json::from_str(&snap.blocks).expect("blocks json");
        assert!(
            parsed["frames"]
                .as_array()
                .expect("frames array")
                .iter()
                .any(|f| f["_meta"]["omnitermSystem"]["id"] == "notice-1"),
            "宿主帧应进入 turn 的有序帧窗口：{}",
            snap.blocks
        );
    }

    /// 无活跃 turn（turn 已定稿/从未开始）时返回 None，调用方降级为独立 system 行。
    #[test]
    fn host_update_is_rejected_outside_an_active_turn() {
        let acc = TurnAccumulator::new();
        assert!(acc.append_host_update(&serde_json::json!({"x": 1})).is_none());
        acc.begin_turn();
        acc.finalize_turn();
        assert!(acc.append_host_update(&serde_json::json!({"x": 1})).is_none());
    }

    /// UTF-16 计数口径：emoji（代理对）按 2 计——与旧前端 `String.length` 同口径，
    /// 保证读数校准逐字延续。
    #[test]
    fn output_chars_counts_utf16_units() {
        assert_eq!(output_chars(&text_chunk(&SessionId::new("s"), "ab").update), Some(2));
        assert_eq!(output_chars(&text_chunk(&SessionId::new("s"), "\u{1F642}").update), Some(2));
        assert_eq!(
            output_chars(
                &SessionNotification::new(
                    SessionId::new("s"),
                    SessionUpdate::UsageUpdate(UsageUpdate::new(1, 2)),
                )
                .update
            ),
            None,
            "记账帧不计入输出字符"
        );
    }
}
