//! CellFrame wire format types (design §9) + Phase 3 diff engine.
//!
//! Phase 1: full-frame JSON encoding via `VtState::encode_cell_frame`.
//! Phase 3: `DiffEngine` for row-level diff (hash → skip unchanged rows).

use alacritty_terminal::vte::ansi::CursorShape;
use serde::Serialize;

// ──────────────────────────────────────────────────────────────
// Wire format types (§9.2, §9.3)
// ──────────────────────────────────────────────────────────────

/// CellFrame JSON message — 前端 renderCellFrame 消费。
#[derive(Serialize)]
pub struct CellFrame {
    pub t: &'static str,
    pub session_id: String,
    pub width: u16,
    pub height: u16,
    pub full: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<CursorState>,
    pub overlay: bool,
    /// 全帧时 `rows` 长度为 `height`，每元素一行；
    /// diff 帧时 `rows` 仅含变化行，`row_indices` 标注各行在原 grid 中的位置。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_indices: Option<Vec<usize>>,
    /// Viewport 窗口帧标记（方案 C Phase 1）：携带本帧展示的历史窗口偏移
    /// （行，0 = live 屏）。仅 `viewport_request` 的响应帧携带，常规/overlay
    /// 帧省略——前端据此区分历史帧与实时帧（stale 响应按 y 单调性丢弃）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewport: Option<u32>,
    /// alt-screen 激活标记（方案 C Phase 2，D4）：仅 overlay 帧携带（enter/exit
    /// 都发 overlay，无此标记前端无法区分）。viewport 控制器据此在 alt-screen
    /// 期间禁用滚轮接管、并把 wheel 交回 xterm 默认路径。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_screen: Option<bool>,
    pub rows: Vec<RowData>,
}

/// 一行的线格负载：行内 RLE —— 按 sgr 合并连续字符的扁平数组
/// `[sgr, text, sgr, text, ...]`（`docs/dev/plans/2026-08-28-pty-frame-rle.md` D1/D5）。
///
/// 这是 cell_frame 协议的**唯一**行编码：逐 cell 的 `cells` 格式随该计划
/// P3 的 D4 一并移除，故不存在格式协商（前端无需按字段分派）。
#[derive(Serialize)]
pub struct RowData {
    pub runs: Vec<String>,
}

#[derive(Serialize)]
pub struct CursorState {
    pub row: i32,
    pub col: u16,
    /// DECSCUSR 形状码（0=blink-block, 1=blink-block, 2=steady-block,
    /// 3=blink-under, 4=steady-under, 5=blink-bar, 6=steady-bar）。
    /// 省略时前端保持当前 cursor 形状。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<u8>,
    pub visible: bool,
}

// ──────────────────────────────────────────────────────────────
// DiffEngine (Phase 3)
// ──────────────────────────────────────────────────────────────

/// Row-level diff engine for CellFrame encoding.
///
/// Tracks per-row hashes from the previous frame.  When the calling code
/// produces a **diff frame** (`full: false`), only rows whose hash changed
/// since the last frame are included — the rest are skipped entirely.
///
/// # Invariants
/// - `prev.len() == current grid height` (caller must `resize()` on change).
/// - `invalidate()` forces the next frame to be full (all rows included).
#[derive(Default)]
pub struct DiffEngine {
    prev: Vec<Option<u64>>,
}

impl DiffEngine {
    /// Create engine aligned to a grid of `rows` rows.  First frame is always
    /// treated as a change (no hashes to compare against).
    pub fn with_rows(rows: usize) -> Self {
        Self { prev: vec![None; rows] }
    }

    /// Mark all rows as untracked — the next `changed_rows()` call will
    /// report every row as changed (producing a full frame).
    pub fn invalidate(&mut self) {
        self.prev.fill(None);
    }

    /// Return true when all rows are untracked (first frame after
    /// construction or `invalidate()`) — the next frame should be full.
    pub fn is_untracked(&self) -> bool {
        self.prev.is_empty() || self.prev.iter().all(|h| h.is_none())
    }

    /// Resize to match a new grid height.
    ///
    /// Grows with fresh `None` entries; truncates (extra rows disappear from
    /// the viewport so they don't need tracking).
    pub fn resize(&mut self, new_rows: usize) {
        if new_rows > self.prev.len() {
            self.prev.resize(new_rows, None);
        } else {
            self.prev.truncate(new_rows);
        }
    }

    /// Compare pre-computed per-row hashes against the previous frame.
    ///
    /// Takes a borrowed slice so the caller can compute hashes with a
    /// separate `&self` borrow (avoids `&self` / `&mut self` conflict).
    pub fn changed_rows_from(&mut self, hashes: &[u64]) -> Vec<usize> {
        let mut changed = Vec::new();
        for (i, &h) in hashes.iter().enumerate() {
            if let Some(entry) = self.prev.get(i) {
                if *entry != Some(h) {
                    changed.push(i);
                    if let Some(slot) = self.prev.get_mut(i) {
                        *slot = Some(h);
                    }
                }
            } else {
                // More hash rows than tracked: new rows (after resize extension).
                changed.push(i);
                if i < self.prev.len() {
                    self.prev[i] = Some(h);
                }
            }
        }
        changed
    }
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

/// Map alacritty `CursorShape` to DECSCUSR shape code (0-6).
/// Hidden shape maps to 0 (block) because `visible` flag takes precedence.
#[inline]
pub fn decscusr_code(shape: CursorShape) -> u8 {
    match shape {
        CursorShape::Block => 0,
        CursorShape::Underline => 3,
        CursorShape::Beam => 5,
        CursorShape::Hidden => 0,
        CursorShape::HollowBlock => 0,
    }
}
