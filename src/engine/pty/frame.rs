//! CellFrame wire format types (design §9).
//!
//! Phase 1: full-frame JSON encoding via `VtState::encode_cell_frame`.
//! Phase 3: diff encoder (row-level delta) will live here.

use serde::Serialize;

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
    pub rows: Vec<RowData>,
}

#[derive(Serialize)]
pub struct RowData {
    pub cells: Vec<CellData>,
}

#[derive(Serialize)]
pub struct CellData {
    /// SGR 参数体（不含 \x1b[ 前缀和 m 后缀），空字符串 = 默认样式。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub sgr: String,
    /// 单个 Unicode scalar（grapheme cluster 潜在跨 char 边界用 &str 语义）。
    pub ch: String,
    /// 宽字符占位位：前端应跳过渲染。
    #[serde(default)]
    pub skip: bool,
}

#[derive(Serialize)]
pub struct CursorState {
    pub row: i32,
    pub col: u16,
    pub visible: bool,
}
