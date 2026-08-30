//! 服务端 VT 模拟器（alacritty_terminal，计划 D8 v5 / Phase 2.5）。
//!
//! 每个 pty 会话维护一份 grid，作为「屏幕真相源」：
//! - `capture_visible`：agent 屏幕检测的干净文本（替代切片 A 的原始字节
//!   lossy 方案，消除转义序列碎片对规则匹配的干扰）
//! - `title`：OSC 0/2 标题（watch_targets 的证据源）
//! - `resize`：与 pty master 同步视口
//! - 模拟器应答（DSR/DA/颜色查询等）经 `take_responses` 排空，由调用方
//!   （`mod.rs` 读循环）按 attach 状态门控后经 `PtySession::write` 回写——
//!   有客户端订阅时由浏览器 xterm.js 应答，服务端不写，避免双应答（D8 v5）
//!
//! 选型（2026-08-13）：wezterm-term 未发布 crates.io（git 依赖阻塞发布
//! 渠道，0.2.14 中止事故），换 registry 依赖 alacritty_terminal 0.26；
//! 对外四件套 feed/title/resize/capture_visible 语义与 wezterm-term 版等价
//! （D8 v5 选型对照实测）。已知细微差异：进入 alt-screen 时保留当前光标行
//! （`\x1b[?1049h` 后 capture 首行可能为空），对整屏文本匹配的检测无影响。
//!
//! 补屏说明：重连补屏 = 补屏环原始字节尾（进本地 scrollback + 恢复模式态：
//! DECSET/alt-screen 等）+ 清可见屏（`\x1b[H\x1b[2J`，不清 scrollback）+
//! [`VtState::render_screen`] 以 grid 为真相源重画当前屏。原始字节尾单独回放
//! 对增量绘制的 TUI 会花屏（diff 序列依赖已不存在的屏幕状态），可见屏必须
//! 整帧重画，后续增量才能衔接。模拟器承担 capture/title/render_screen/
//! resize + 切片 C 的 ANSI seed。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config as TermConfig, Osc52, Term, TermMode};
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Processor, Rgb};
use tracing::warn;

use super::frame::{CellFrame, CursorState, DiffEngine, RowData, decscusr_code};

/// VT scrollback 行数上限（P1 有界：grid 内存 ≈ 行数 × 列数 × 单元开销，
/// 1000 行 × 200 列 ≈ 数 MB 量级/会话）。
const VT_SCROLLBACK_LINES: usize = 1000;

/// 应答缓冲条目上限（P1 有界，AGENTS §6 / performance-and-safety §P1）。
const MAX_RESPONSE_ENTRIES: usize = 64;
/// 应答缓冲字节上限：条目大小由会话内程序决定，只限条目数等于没限。
const MAX_RESPONSE_BYTES: usize = 8 * 1024;
/// 闭包型应答（颜色/文本区尺寸查询）无预知产物大小，按估值记账。
const RESPONSE_CLOSURE_EST_BYTES: usize = 32;

/// 应答缓冲（超限策略：丢最旧 + warn，见 `ResponseSink::push`）。
/// 正常路径下每次 feed 后即被 `take_responses` 排空，上限仅为防御
/// （无人 drain 的窗口内缓冲不得无界累积）。
#[derive(Default)]
struct ResponseSink {
    inner: Mutex<SinkInner>,
}

#[derive(Default)]
struct SinkInner {
    queue: VecDeque<PendingResponse>,
    bytes: usize,
    title: String,
}

/// 待回写的模拟器应答。颜色/尺寸查询携带 alacritty 的格式化闭包，
/// 需要 Term 上下文（调色板/视口尺寸）才能生成应答字节——`EventListener`
/// 只拿得到 `&self`，故先入队、`take_responses` 时统一解析。
enum PendingResponse {
    Bytes(Vec<u8>),
    Color(usize, Arc<dyn Fn(Rgb) -> String + Sync + Send + 'static>),
    TextArea(Arc<dyn Fn(WindowSize) -> String + Sync + Send + 'static>),
}

fn response_len(resp: &PendingResponse) -> usize {
    match resp {
        PendingResponse::Bytes(b) => b.len(),
        PendingResponse::Color(..) | PendingResponse::TextArea(_) => RESPONSE_CLOSURE_EST_BYTES,
    }
}

impl ResponseSink {
    fn push(&self, resp: PendingResponse) {
        let len = response_len(&resp);
        if len > MAX_RESPONSE_BYTES {
            warn!("vt response entry exceeds {MAX_RESPONSE_BYTES}B cap, dropped");
            return;
        }
        let mut g = self.inner.lock().unwrap();
        while g.queue.len() >= MAX_RESPONSE_ENTRIES || g.bytes + len > MAX_RESPONSE_BYTES {
            let Some(oldest) = g.queue.pop_front() else { break };
            g.bytes -= response_len(&oldest);
            warn!(
                "vt response buffer overflow (cap {MAX_RESPONSE_ENTRIES} entries / {MAX_RESPONSE_BYTES}B), oldest dropped"
            );
        }
        g.queue.push_back(resp);
        g.bytes += len;
    }
}

/// EventListener 只收不可变引用，状态经共享 sink 收集（D8 v5 API 映射）。
struct VtEventListener {
    sink: Arc<ResponseSink>,
}

impl EventListener for VtEventListener {
    fn send_event(&self, event: Event) {
        match event {
            Event::Title(title) => self.sink.inner.lock().unwrap().title = title,
            Event::ResetTitle => self.sink.inner.lock().unwrap().title.clear(),
            Event::PtyWrite(text) => self.sink.push(PendingResponse::Bytes(text.into_bytes())),
            Event::ColorRequest(index, fmt) => self.sink.push(PendingResponse::Color(index, fmt)),
            Event::TextAreaSizeRequest(fmt) => self.sink.push(PendingResponse::TextArea(fmt)),
            // Wakeup/Bell/CursorBlinking/MouseCursor/Clipboard*：服务端无消费者。
            // OSC 52 已在 Config 关闭（剪贴板归前端 xterm.js）。
            _ => {}
        }
    }
}

/// 自实现 Dimensions（不用上游标为 test helper 的 `term::test::TermSize`）。
struct VtSize {
    rows: usize,
    cols: usize,
}

impl Dimensions for VtSize {
    fn total_lines(&self) -> usize {
        self.rows + VT_SCROLLBACK_LINES
    }

    fn screen_lines(&self) -> usize {
        self.rows
    }

    fn columns(&self) -> usize {
        self.cols
    }
}

/// 颜色查询的兜底色（调色板未设置该索引时）：xterm 经典默认前景。
const FALLBACK_COLOR: Rgb = Rgb { r: 0xd8, g: 0xd8, b: 0xd8 };

/// 相邻单元合并为同段的样式键（减少 SGR 序列量）。
/// fg/bg 为 `None` 表示默认色；flags 全集参与等值比较（变化即重发）。
#[derive(Clone, Copy, PartialEq)]
pub struct CellStyle {
    fg: Option<Color>,
    bg: Option<Color>,
    flags: Flags,
}

impl Default for CellStyle {
    fn default() -> Self {
        Self { fg: None, bg: None, flags: Flags::empty() }
    }
}

impl CellStyle {
    pub fn of(cell: &Cell) -> Self {
        Self { fg: normalize_color(cell.fg), bg: normalize_color(cell.bg), flags: cell.flags }
    }

    /// 默认样式（行尾裁剪判据：只有默认样式的空白才可裁）。
    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// 默认色归一为 `None`：Foreground/Background/Cursor 及 Dim* 系仅内部
/// 调色板/特殊场景使用，单元色不携带；标准 16 色原样保留供 SGR 映射。
fn normalize_color(c: Color) -> Option<Color> {
    let Color::Named(n) = c else { return Some(c) };
    match n {
        NamedColor::Black
        | NamedColor::Red
        | NamedColor::Green
        | NamedColor::Yellow
        | NamedColor::Blue
        | NamedColor::Magenta
        | NamedColor::Cyan
        | NamedColor::White
        | NamedColor::BrightBlack
        | NamedColor::BrightRed
        | NamedColor::BrightGreen
        | NamedColor::BrightYellow
        | NamedColor::BrightBlue
        | NamedColor::BrightMagenta
        | NamedColor::BrightCyan
        | NamedColor::BrightWhite => Some(c),
        _ => None,
    }
}

/// 颜色 → 判别值（供行指纹用，避免 `sgr_body` 的 String 分配）。
///
/// 只要求「颜色变 → 值变」，与 SGR 编码形式无关。
fn color_key(c: Option<Color>) -> u64 {
    match c {
        None => 0,
        Some(Color::Named(n)) => 1 + n as u64,
        Some(Color::Indexed(i)) => 0x100 + i as u64,
        Some(Color::Spec(rgb)) => {
            0x1_0000 + ((rgb.r as u64) << 16 | (rgb.g as u64) << 8 | rgb.b as u64)
        }
    }
}

/// 行级指纹（FNV-1a 64）：**直接遍历 grid，不构造 `CellData`**。
///
/// 原实现先 `row_cells()` 为整行构造 `CellData`（每 cell 一次 `sgr_body` 的
/// String 分配 + 一次 `to_string`），再交给 `hash_row`。40×100 的屏即 4000 次
/// 分配/帧——RLE 把行编码成本压下来后，这笔开销反成了实时帧的主要成本
/// （实测 7.5 ms/帧，占 30fps 转发循环 23% 的时间，期间到达的 viewport 请求
/// 只能排队）。指纹只需保证「内容/样式变 → 值变」，无需经过 SGR 字符串。
fn hash_grid_row(grid: &alacritty_terminal::grid::Grid<Cell>, cols: usize, line: Line) -> u64 {
    const FNV_OFFSET: u64 = 14695981039346656037;
    const FNV_PRIME: u64 = 1099511628211;
    let mut h = FNV_OFFSET;
    let mut mix = |v: u64| {
        h ^= v;
        h = h.wrapping_mul(FNV_PRIME);
    };
    for col in 0..cols {
        let cell_ref = &grid[line][Column(col)];
        if cell_ref.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
            // 占位 cell：混入哨兵，与「该位置无 cell」区分（沿用原 hash_row 语义）
            mix(0x42);
            continue;
        }
        mix(cell_ref.c as u64);
        // 零宽字符（组合音标等）也参与指纹：它不占列但改变显示，漏检会让
        // diff 帧不发该行 —— 界面停在旧内容（`row_hash_*` 单测守这条）。
        if let Some(zw) = cell_ref.zerowidth() {
            for z in zw {
                mix(*z as u64);
            }
        }
        let style = CellStyle::of(cell_ref);
        mix(style.flags.bits() as u64);
        mix(color_key(style.fg));
        mix(color_key(style.bg));
    }
    h
}

/// 把 cell 的文本追加到 `out`：主字符 + 附加在该 cell 上的零宽字符。
///
/// 零宽字符（组合音标、emoji 变体选择符等）渲染时不占列，但必须与主字符
/// 一起写入，否则 `e` + U+0301 退化成 `e`。常态（无零宽）零分配 —— 只有
/// 命中零宽时才 push 额外字符，不回到 E-7 之前每 cell 一次 String 分配。
fn push_cell_text(out: &mut String, cell: &Cell) {
    out.push(cell.c);
    if let Some(zw) = cell.zerowidth() {
        out.extend(zw.iter().copied());
    }
}

/// 样式 → SGR 参数体（不含 CSI 与结尾 `m`）；默认样式返回 `None`（仅发 reset）。
/// 扩展下划线系 flag（DOUBLE_UNDERLINE 等）不映射：样式键含全集 flags，
/// 变化检测不受影响，仅该类罕见样式降级为普通文本（不影响正确性）。
/// blink（SGR 5）同样不映射——alacritty 0.26 无对应单元位，无从检测。
pub fn sgr_body(style: &CellStyle) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for (flag, code) in [
        (Flags::BOLD, "1"),
        (Flags::DIM, "2"),
        (Flags::ITALIC, "3"),
        (Flags::UNDERLINE, "4"),
        (Flags::INVERSE, "7"),
        (Flags::HIDDEN, "8"),
        (Flags::STRIKEOUT, "9"),
    ] {
        if style.flags.contains(flag) {
            parts.push(code.to_string());
        }
    }
    if let Some(c) = style.fg {
        let p = color_sgr(c, true);
        if !p.is_empty() {
            parts.push(p);
        }
    }
    if let Some(c) = style.bg {
        let p = color_sgr(c, false);
        if !p.is_empty() {
            parts.push(p);
        }
    }
    (!parts.is_empty()).then(|| parts.join(";"))
}

/// 单色 → SGR 参数：标准 16 色用基础码（30-37/90-97、40-47/100-107），
/// 其余走扩展形式（38;5;n / 38;2;r;g;b）。归一化后的默认色不会到达此处；
/// 防御性兜底按默认处理（降级显示，不出错码）。
pub fn color_sgr(c: Color, foreground: bool) -> String {
    let std = if foreground { 30 } else { 40 };
    let bright = if foreground { 90 } else { 100 };
    let ext = if foreground { 38 } else { 48 };
    match c {
        Color::Named(n) => {
            let idx: u8 = match n {
                NamedColor::Black => 0,
                NamedColor::Red => 1,
                NamedColor::Green => 2,
                NamedColor::Yellow => 3,
                NamedColor::Blue => 4,
                NamedColor::Magenta => 5,
                NamedColor::Cyan => 6,
                NamedColor::White => 7,
                NamedColor::BrightBlack => 8,
                NamedColor::BrightRed => 9,
                NamedColor::BrightGreen => 10,
                NamedColor::BrightYellow => 11,
                NamedColor::BrightBlue => 12,
                NamedColor::BrightMagenta => 13,
                NamedColor::BrightCyan => 14,
                _ => return String::new(),
            };
            if idx < 8 { (std + idx).to_string() } else { (bright + idx - 8).to_string() }
        }
        Color::Indexed(i) => format!("{ext};5;{i}"),
        Color::Spec(rgb) => format!("{ext};2;{};{};{}", rgb.r, rgb.g, rgb.b),
    }
}

pub struct VtState {
    term: Term<VtEventListener>,
    processor: Processor,
    sink: Arc<ResponseSink>,
    rows: u16,
    cols: u16,
    /// Phase 3: row-level diff tracker (invalidated on full frame / resize / mode change).
    diff_engine: DiffEngine,
    /// Phase 3: last encoded cursor state — omit cursor field when unchanged (reduce flicker).
    last_cursor: Mutex<Option<(i32, u16, u8, bool)>>,
}

impl VtState {
    pub fn new(rows: u16, cols: u16) -> Self {
        let rows = rows.max(1) as usize;
        let cols = cols.max(1) as usize;
        let config = TermConfig {
            scrolling_history: VT_SCROLLBACK_LINES,
            // OSC 52 剪贴板归前端 xterm.js，服务端不参与（上游默认 OnlyCopy，须显式关闭）
            osc52: Osc52::Disabled,
            ..Default::default()
        };
        let sink = Arc::new(ResponseSink::default());
        let size = VtSize { rows, cols };
        let term = Term::new(config, &size, VtEventListener { sink: Arc::clone(&sink) });
        Self {
            term,
            processor: Processor::new(),
            sink,
            rows: rows as u16,
            cols: cols as u16,
            diff_engine: DiffEngine::with_rows(rows),
            last_cursor: Mutex::new(None),
        }
    }

    /// 喂入 pty 输出（允许任意切片边界，解析器自处理跨块序列）。
    pub fn feed(&mut self, bytes: &[u8]) {
        self.processor.advance(&mut self.term, bytes);
    }

    /// 排空本轮 feed 产生的模拟器应答（DSR/DA/颜色查询等）。
    /// 是否写回 pty 由调用方按 attach 状态门控（D8 v5 应答归属）。
    pub fn take_responses(&mut self) -> Vec<u8> {
        let pending: Vec<PendingResponse> = {
            let mut g = self.sink.inner.lock().unwrap();
            g.bytes = 0;
            g.queue.drain(..).collect()
        };
        let mut out = Vec::new();
        for resp in pending {
            match resp {
                PendingResponse::Bytes(b) => out.extend_from_slice(&b),
                PendingResponse::Color(index, fmt) => {
                    let rgb = self.term.colors()[index].unwrap_or(FALLBACK_COLOR);
                    out.extend_from_slice(fmt(rgb).as_bytes());
                }
                PendingResponse::TextArea(fmt) => {
                    let ws = WindowSize {
                        num_lines: self.rows,
                        num_cols: self.cols,
                        cell_width: 0,
                        cell_height: 0,
                    };
                    out.extend_from_slice(fmt(ws).as_bytes());
                }
            }
        }
        out
    }

    /// OSC 0/2 标题（无则空串）。
    pub fn title(&self) -> String {
        self.sink.inner.lock().unwrap().title.clone()
    }

    /// 与 pty resize 同步视口。
    pub fn resize(&mut self, rows: u16, cols: u16) {
        let rows = rows.max(1) as usize;
        let cols = cols.max(1) as usize;
        self.rows = rows as u16;
        self.cols = cols as u16;
        self.term.resize(VtSize { rows, cols });
        self.diff_engine.resize(rows);
        self.diff_engine.invalidate();
        // Invalidate cursor diff so a resize-triggered frame always includes cursor.
        if let Ok(mut lc) = self.last_cursor.lock() {
            lc.take();
        }
    }

    /// 可见屏纯文本（tmux `capture-pane -p` 等价语义：活动屏、不带转义）。
    /// 行尾空白去除，行间 `\n` 连接。
    pub fn capture_visible(&self) -> String {
        let grid = self.term.grid();
        let rows = self.term.screen_lines();
        let cols = Column(self.term.columns());
        let mut out = String::new();
        for row in 0..rows {
            let mut line = String::new();
            for cell in &grid[Line(row as i32)][Column(0)..cols] {
                // 跳过宽字符占位单元，否则宽字符在 capture 里重复出现
                if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                {
                    continue;
                }
                line.push(cell.c);
            }
            out.push_str(line.trim_end());
            out.push('\n');
        }
        out
    }

    /// 光标位置（视口相对坐标，行/列）——补屏重放一致性测试的比较读口。
    /// 仅测试编译（生产无消费者，避免 dead_code 告警）。
    #[cfg(test)]
    pub fn renderable_cursor_for_test(&self) -> (i32, u16) {
        let rc = self.term.renderable_content();
        (rc.cursor.point.line.0, rc.cursor.point.column.0 as u16)
    }

    /// 可见屏带样式渲染——补屏帧的「当前屏」部分（客户端清屏后整帧重画）。
    ///
    /// 输出 = 逐行 SGR 样式文本（`\r\n` 连接；行尾仅裁「默认样式的空白」，
    /// 带底色的行尾空白保留——TUI 整行铺底的常态）+ 收尾 reset + 光标定位
    /// 与显隐复位。光标必须复位：后续 TUI 增量多为相对移动/局部擦写，
    /// 客户端光标位置与服务端 grid 不一致即错位。
    ///
    /// P1 有界：输出上限 ≈ rows × cols × 单元预算（SGR 重发 ~24B + 字符
    /// ≤4B，容量按 8B/单元预留），视口尺寸经 PtySize 校验（≤1000×1000）；
    /// 构造即有界、不随时间累积。
    pub fn render_screen(&self) -> Vec<u8> {
        let grid = self.term.grid();
        let rows = self.term.screen_lines();
        let cols = self.term.columns();
        let mut out: Vec<u8> = Vec::with_capacity(rows * cols * 8 + 64);
        let mut cur = CellStyle::default();

        for row in 0..rows {
            let cells: Vec<(char, CellStyle)> = grid[Line(row as i32)][Column(0)..Column(cols)]
                .iter()
                .filter(|c| {
                    !c.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                })
                .map(|c| (c.c, CellStyle::of(c)))
                .collect();
            let trimmed =
                cells.iter().rev().take_while(|(ch, st)| *ch == ' ' && st.is_default()).count();
            for (ch, st) in &cells[..cells.len() - trimmed] {
                if *st != cur {
                    out.extend_from_slice(b"\x1b[0m");
                    if let Some(body) = sgr_body(st) {
                        out.push(b'\x1b');
                        out.push(b'[');
                        out.extend_from_slice(body.as_bytes());
                        out.push(b'm');
                    }
                    cur = *st;
                }
                let mut buf = [0u8; 4];
                out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            }
            // 行分隔只发在行间：末行若也补 `\r\n`，满屏客户端会因 LF 越界
            // 上滚一行（首行被顶出屏幕）——光标落点由收尾 CUP 保证。
            if row + 1 < rows {
                out.extend_from_slice(b"\r\n");
            }
        }

        if cur != CellStyle::default() {
            out.extend_from_slice(b"\x1b[0m");
        }
        let rc = self.term.renderable_content();
        let point = rc.cursor.point;
        out.extend_from_slice(
            format!("\x1b[{};{}H", point.line.0 + 1, point.column.0 + 1).as_bytes(),
        );
        match rc.cursor.shape {
            CursorShape::Hidden => out.extend_from_slice(b"\x1b[?25l"),
            _ => out.extend_from_slice(b"\x1b[?25h"),
        }
        out
    }

    /// 将当前 VT grid 编码为 CellFrame JSON（Phase 1 cell-frame 编码；Phase 3 行级 diff）。
    ///
    /// 首次调用（或 `invalidate_diff()` 后）输出全帧，后续调用输出 diff 帧
    /// （仅包含变化行），减少 JSON 序列化开销。
    ///
    /// 每行是 RLE runs 数组：`[sgr, text, sgr, text, ...]`（sgr 为 SGR 参数体，
    /// 不含 \x1b[ 前缀与 m 后缀；text 为同 sgr 的连续字符，含其零宽组合字符）。
    /// 宽字符占位 cell 不产生输出。输出 JSON 供 WebSocket Text 帧传输（§4.2），
    /// 前端 renderCellFrame 直接消费。
    pub fn encode_cell_frame(&mut self, session_id: &str) -> String {
        self.encode_frame_body(session_id, false)
    }

    /// Phase 2 overlay 帧：前端收到后先清屏再完整重绘当前 grid，
    /// 用于 alt-screen 退出等场景消除残留。
    ///
    /// Always produces a full frame (`full: true`) and invalidates the diff
    /// engine so the next periodic `encode_cell_frame` starts fresh.
    pub fn encode_overlay_frame(&mut self, session_id: &str) -> String {
        let grid = self.term.grid();
        let rows = self.term.screen_lines();
        let cols = self.term.columns();
        let out_rows: Vec<RowData> =
            (0..rows).map(|r| self.encode_row_static(grid, cols, Line(r as i32))).collect();

        let rc = self.term.renderable_content();
        let cursor = Some(CursorState {
            row: rc.cursor.point.line.0 + 1,
            col: (rc.cursor.point.column.0 + 1) as u16,
            shape: Some(decscusr_code(rc.cursor.shape)),
            visible: !matches!(rc.cursor.shape, CursorShape::Hidden),
        });

        let frame = CellFrame {
            t: "cell_frame",
            session_id: session_id.to_string(),
            width: cols as u16,
            height: rows as u16,
            full: true,
            cursor,
            overlay: true,
            row_indices: None,
            viewport: None,
            // D4：enter/exit 都发 overlay，前端靠此标记区分 alt-screen 状态
            alt_screen: Some(self.mode().contains(TermMode::ALT_SCREEN)),
            history_size: grid.history_size() as u32,
            rows: out_rows,
        };

        let json = serde_json::to_string(&frame).expect("CellFrame serialization must not fail");

        // Force next periodic frame to be full since rendering context changed.
        crate::engine::pty::metrics::record_cell_frame_bytes(json.len());

        json
    }

    /// 历史视口窗口帧（方案 C Phase 1，`pty-herdr-style-full-buffer-render.md`）：
    /// 以偏移 `y`（行，0 = live 屏，向上递增）为窗口顶，编码 `screen_lines()` 行。
    /// 滚轮接管后前端经 `viewport_request` 请求，取代 xterm 本地 scrollback。
    ///
    /// - `y` 钳制到 `history_size()`（外部输入兜底，负偏移在读循环侧已拦）；
    /// - 帧恒 `full: true` + `viewport: Some(y)`，不触碰 diff 基线
    ///   （实时流独立继续，前端在 viewport 模式下自行丢弃实时帧）；
    /// - `y > 0` 时光标隐藏（历史窗口内无活光标），`y = 0` 携带真实光标
    ///   （回底校准帧与 overlay 帧同语义）。
    ///
    /// 响应体积由构造有界（`rows × cols`，与 overlay 帧同级，PtySize ≤ 1000×1000）。
    pub fn encode_viewport_frame(&self, session_id: &str, y: u32) -> String {
        let grid = self.term.grid();
        let rows = self.term.screen_lines();
        let cols = self.term.columns();
        let y = (y as usize).min(grid.history_size()) as u32;

        let out_rows: Vec<RowData> = (0..rows)
            .map(|i| self.encode_row_static(grid, cols, Line(i as i32 - y as i32)))
            .collect();

        let rc = self.term.renderable_content();
        let cursor = Some(CursorState {
            row: 1,
            col: 1,
            shape: Some(decscusr_code(rc.cursor.shape)),
            // y = 0 回底校准帧携带真实光标；y > 0 历史窗口无活光标，隐藏
            visible: y == 0 && !matches!(rc.cursor.shape, CursorShape::Hidden),
        });

        let frame = CellFrame {
            t: "cell_frame",
            session_id: session_id.to_string(),
            width: cols as u16,
            height: rows as u16,
            full: true,
            cursor,
            overlay: false,
            row_indices: None,
            viewport: Some(y),
            alt_screen: None,
            history_size: grid.history_size() as u32,
            rows: out_rows,
        };

        let json = serde_json::to_string(&frame).expect("CellFrame serialization must not fail");
        crate::engine::pty::metrics::record_cell_frame_bytes(json.len());
        json
    }

    /// Phase 3: invalidate diff tracker → 下一帧强制全帧（resize / overlay / mode change 后调用）。
    pub fn invalidate_diff(&mut self) {
        self.diff_engine.invalidate();
        if let Ok(mut lc) = self.last_cursor.lock() {
            lc.take();
        }
    }

    /// 当前终端 mode flags（Phase 2 事件检测用）。
    pub fn mode(&self) -> TermMode {
        *self.term.mode()
    }

    /// Encode body (shared full/diff logic). Needs &mut for diff_engine updates.
    fn encode_frame_body(&mut self, session_id: &str, overlay: bool) -> String {
        use crate::engine::pty::frame::{CellFrame, RowData};

        let grid = self.term.grid();
        let rows = self.term.screen_lines();
        let cols = self.term.columns();

        // Probe untracked state BEFORE mutating the hash table — the first encode
        // after construction or `invalidate_diff()` must be a full frame.
        let full = self.diff_engine.is_untracked();

        // Compute row hashes first (immutable borrow of grid, 无分配)
        let mut row_hashes: Vec<u64> = Vec::with_capacity(rows);
        for r in 0..rows {
            row_hashes.push(hash_grid_row(grid, cols, Line(r as i32)));
        }

        // Diff-engine comparison (mutable borrow of diff_engine)
        let changed_indices = self.diff_engine.changed_rows_from(&row_hashes);

        // Build row data only for changed rows
        let out_rows: Vec<RowData> = changed_indices
            .iter()
            .map(|&r| self.encode_row_static(grid, cols, Line(r as i32)))
            .collect();

        // Cursor diff: include only when position/shape/visibility changed
        let rc = self.term.renderable_content();
        let cursor_key = (
            rc.cursor.point.line.0 + 1,
            (rc.cursor.point.column.0 + 1) as u16,
            decscusr_code(rc.cursor.shape),
            !matches!(rc.cursor.shape, CursorShape::Hidden),
        );
        let cursor = {
            let mut last = self.last_cursor.lock().unwrap();
            let changed = last.map(|l| l != cursor_key).unwrap_or(true);
            if changed {
                *last = Some(cursor_key);
                Some(CursorState {
                    row: cursor_key.0,
                    col: cursor_key.1,
                    shape: Some(cursor_key.2),
                    visible: cursor_key.3,
                })
            } else {
                None
            }
        };

        let row_indices = if full { None } else { Some(changed_indices) };

        let frame = CellFrame {
            t: "cell_frame",
            session_id: session_id.to_string(),
            width: cols as u16,
            height: rows as u16,
            full,
            cursor,
            overlay,
            row_indices,
            viewport: None,
            alt_screen: None,
            history_size: grid.history_size() as u32,
            rows: out_rows,
        };

        let json = serde_json::to_string(&frame).expect("CellFrame serialization must not fail");

        // Phase 3: record frame size for metrics
        crate::engine::pty::metrics::record_cell_frame_bytes(json.len());

        json
    }

    /// Encode one row as RowData (no lock needed - caller holds grid ref).
    /// `line` 为 grid 绝对行：`Line(0..screen_lines)` = 可见屏，负值 = 历史
    /// （`Line(-1)` 紧贴屏顶上方），供 viewport 窗口编码复用。
    ///
    /// 行内 RLE 编码：按 sgr 合并连续字符为 `[sgr, text, ...]` 扁平数组
    /// （cell_frame 协议的唯一行编码，见 `frame::RowData`）。
    ///
    /// 宽字符占位 cell 直接跳过（不切 run、不产生空段）——它在渲染输出中
    /// 不存在，故跳过前后渲染等价（计划 D5，四类内容实测无损）。
    fn encode_row_static(
        &self,
        grid: &alacritty_terminal::grid::Grid<Cell>,
        cols: usize,
        line: Line,
    ) -> RowData {
        let mut runs: Vec<String> = Vec::new();
        // 未开始（None）时首个可见字符开新 run；之后按 sgr 变化切 run。
        let mut current: Option<String> = None;
        let mut text = String::new();

        for col in 0..cols {
            let cell_ref = &grid[line][Column(col)];
            if cell_ref.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
            {
                continue;
            }
            let style = CellStyle::of(cell_ref);
            let sgr = sgr_body(&style).unwrap_or_default();
            match current {
                Some(ref cur) if *cur == sgr => push_cell_text(&mut text, cell_ref),
                _ => {
                    if let Some(prev) = current.take() {
                        runs.push(prev);
                        runs.push(std::mem::take(&mut text));
                    }
                    current = Some(sgr);
                    push_cell_text(&mut text, cell_ref);
                }
            }
        }
        if let Some(prev) = current.take() {
            runs.push(prev);
            runs.push(std::mem::take(&mut text));
        }

        RowData { runs }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vt(rows: u16, cols: u16) -> VtState {
        VtState::new(rows, cols)
    }

    #[test]
    fn capture_strips_ansi_and_keeps_text() {
        let mut v = vt(24, 80);
        v.feed(b"\x1b[1;32mgreen bold\x1b[0m plain\r\n");
        v.feed(b"second line\r\n");
        let cap = v.capture_visible();
        assert!(cap.starts_with("green bold plain\nsecond line\n"), "got: {cap:?}");
        assert!(!cap.contains('\x1b'), "capture must not contain escape bytes");
    }

    #[test]
    fn carriage_return_overwrites_in_grid() {
        let mut v = vt(24, 80);
        v.feed(b"AAAA\rBB\r\n");
        let cap = v.capture_visible();
        assert!(cap.starts_with("BBAA\n"), "CR overwrite wrong: {cap:?}");
    }

    #[test]
    fn osc2_sets_title() {
        let mut v = vt(24, 80);
        v.feed(b"\x1b]2;my agent task\x07");
        assert_eq!(v.title(), "my agent task");
    }

    #[test]
    fn resize_preserves_content() {
        let mut v = vt(24, 80);
        v.feed(b"keep me\r\n");
        v.resize(30, 120);
        let cap = v.capture_visible();
        assert!(cap.contains("keep me"), "content lost after resize: {cap:?}");
    }

    #[test]
    fn split_escape_sequence_across_feeds() {
        let mut v = vt(24, 80);
        // CSI 序列跨两次 feed（真实读循环 8KB 切块的常态）
        v.feed(b"\x1b[3");
        v.feed(b"1mred\x1b[0m");
        let cap = v.capture_visible();
        assert!(cap.starts_with("red\n"), "split sequence mishandled: {cap:?}");
    }

    #[test]
    fn alt_screen_toggle_restores_main() {
        let mut v = vt(24, 80);
        v.feed(b"main screen\r\n");
        v.feed(b"\x1b[?1049h"); // 进入 alt-screen（vim/htop）
        v.feed(b"alt content\r\n");
        let alt_cap = v.capture_visible();
        assert!(alt_cap.contains("alt content"), "alt screen missing content: {alt_cap:?}");
        v.feed(b"\x1b[?1049l"); // 回落主屏
        let cap = v.capture_visible();
        assert!(cap.contains("main screen"), "main screen lost after toggle: {cap:?}");
        assert!(!cap.contains("alt content"), "alt content leaked into main screen");
    }

    #[test]
    fn wide_chars_not_duplicated_in_capture() {
        let mut v = vt(24, 80);
        v.feed("终端宽度测试\r\n".as_bytes());
        let cap = v.capture_visible();
        assert!(cap.starts_with("终端宽度测试\n"), "got: {cap:?}");
        // 宽字符占 2 单元，占位单元未跳过时会重复出现
        assert_eq!(cap.matches("终端宽度测试").count(), 1, "wide char duplicated: {cap:?}");
    }

    #[test]
    fn dsr_generates_response_for_drain() {
        let mut v = vt(24, 80);
        v.feed(b"\x1b[6n"); // DSR：查询光标位置
        let resp = v.take_responses();
        let text = String::from_utf8_lossy(&resp);
        assert!(text.starts_with("\x1b["), "DSR response missing: {text:?}");
        assert!(text.ends_with('R'), "DSR response must be CPR: {text:?}");
        assert!(v.take_responses().is_empty(), "responses must drain");
    }

    #[test]
    fn response_buffer_overflow_drops_oldest() {
        // P1 有界：超限丢旧，长度恰为上限（performance-and-safety §P1 回归模板）
        let sink = ResponseSink::default();
        for _ in 0..(MAX_RESPONSE_ENTRIES + 10) {
            sink.push(PendingResponse::Bytes(vec![b'x'; 4]));
        }
        let g = sink.inner.lock().unwrap();
        assert_eq!(g.queue.len(), MAX_RESPONSE_ENTRIES);
        assert!(g.bytes <= MAX_RESPONSE_BYTES);
    }

    #[test]
    fn response_buffer_byte_cap_enforced() {
        let sink = ResponseSink::default();
        for _ in 0..8 {
            sink.push(PendingResponse::Bytes(vec![b'y'; MAX_RESPONSE_BYTES / 3]));
        }
        let g = sink.inner.lock().unwrap();
        assert!(g.bytes <= MAX_RESPONSE_BYTES, "byte cap violated: {}", g.bytes);
        assert!(!g.queue.is_empty(), "entries within cap must be kept");
    }

    #[test]
    fn oversized_response_entry_rejected() {
        let sink = ResponseSink::default();
        sink.push(PendingResponse::Bytes(vec![b'z'; MAX_RESPONSE_BYTES + 1]));
        let g = sink.inner.lock().unwrap();
        assert!(g.queue.is_empty(), "oversized entry must be rejected, not queued");
    }

    #[test]
    fn render_screen_emits_styled_text_with_reset() {
        let mut v = vt(24, 80);
        v.feed(b"\x1b[1;31mRED\x1b[0m tail\r\n");
        let rendered = v.render_screen();
        let r = String::from_utf8_lossy(&rendered);
        // 样式段：reset + 参数体；回落默认时仅发 reset
        assert!(r.contains("\x1b[0m\x1b[1;31mRED\x1b[0m tail"), "got: {r:?}");
    }

    #[test]
    fn render_screen_trims_only_default_trailing_blank() {
        let mut v = vt(24, 80);
        v.feed(b"abc\r\n"); // 行尾默认样式空白 → 裁剪
        v.feed(b"\x1b[41mA \x1b[0m\r\n"); // 行尾带底色空白 → 保留
        let rendered = v.render_screen();
        let r = String::from_utf8_lossy(&rendered);
        assert!(r.contains("abc\r\n"), "default trailing blank must be trimmed: {r:?}");
        // 样式变化按「reset + SGR 体」前发（见 render_screen），故带底色空白
        // 保留的形态是 `\x1b[41mA \r\n`——空格未被裁剪即为保留
        assert!(r.contains("\x1b[41mA \r\n"), "colored trailing blank must be kept: {r:?}");
    }

    #[test]
    fn render_screen_restores_cursor_position_and_visibility() {
        let mut v = vt(24, 80);
        v.feed(b"abc\r\nxy"); // 光标应落在第 2 行第 3 列
        let rendered = v.render_screen();
        let r = String::from_utf8_lossy(&rendered);
        assert!(r.ends_with("\x1b[2;3H\x1b[?25h"), "cursor restore wrong: {r:?}");
        v.feed(b"\x1b[?25l"); // 隐藏光标（DECTCEM）
        let rendered = v.render_screen();
        let r = String::from_utf8_lossy(&rendered);
        assert!(r.ends_with("\x1b[?25l"), "hidden cursor not synced: {r:?}");
    }

    #[test]
    fn render_screen_wide_chars_once() {
        let mut v = vt(24, 80);
        v.feed("终端宽度测试".as_bytes());
        let rendered = v.render_screen();
        let r = String::from_utf8_lossy(&rendered);
        assert_eq!(r.matches("终端宽度测试").count(), 1, "wide char duplicated: {r:?}");
    }

    #[test]
    fn render_screen_shows_active_screen() {
        let mut v = vt(24, 80);
        v.feed(b"main screen\r\n");
        v.feed(b"\x1b[?1049h"); // alt-screen（vim/htop 类）
        v.feed(b"alt content");
        let rendered = v.render_screen();
        let r = String::from_utf8_lossy(&rendered);
        assert!(r.contains("alt content"), "alt screen missing: {r:?}");
        assert!(!r.contains("main screen"), "main screen leaked into render: {r:?}");
    }

    #[test]
    fn render_screen_roundtrip_reproduces_visible_screen() {
        // 花屏场景的确定性回归：增量绘制型 agent TUI（光标绝对定位 + 局部
        // 擦除的 diff 流）画出的屏幕，经「清屏 + 补屏帧重放」后必须与真相源
        // 逐行一致——字节尾回放做不到，grid 整帧重渲染必须做到。
        let mut v = vt(24, 80);
        v.feed(b"\x1b[1;1Hheader line\x1b[K"); // 定位首行 + 行尾擦除
        v.feed(b"\x1b[2;1H\x1b[32mbody: ok\x1b[0m");
        v.feed(b"\x1b[5;10Hprogress: 42%");
        let frame = v.render_screen();
        let mut client = vt(24, 80);
        client.feed(&frame);
        assert_eq!(
            client.capture_visible(),
            v.capture_visible(),
            "replay frame diverges from server grid"
        );
        // 光标也必须一致（后续 TUI 增量多为相对移动，位置错即全错）
        assert_eq!(
            client.term.renderable_content().cursor.point,
            v.term.renderable_content().cursor.point
        );
    }

    // ──── Phase 1: encode_cell_frame (§1.1) ────

    #[test]
    fn encode_cell_frame_produces_valid_json() {
        let mut v = vt(24, 80);
        let json = v.encode_cell_frame("test-session");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["t"], "cell_frame");
        assert_eq!(parsed["session_id"], "test-session");
        assert_eq!(parsed["width"], 80);
        assert_eq!(parsed["height"], 24);
        assert_eq!(parsed["full"], true);
        assert_eq!(parsed["overlay"], false);
        assert!(parsed["cursor"].is_object(), "cursor must be present");
        assert_eq!(parsed["rows"].as_array().unwrap().len(), 24);
    }

    #[test]
    fn encode_cell_frame_includes_sgr_for_styled_runs() {
        let mut v = vt(24, 80);
        v.feed(b"\x1b[1;31mRED\x1b[0m");
        let json = v.encode_cell_frame("test-session");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        let runs = parsed["rows"][0]["runs"].as_array().unwrap();
        // First run: "RED" with bold+red SGR
        assert_eq!(runs[0].as_str(), Some("1;31"));
        assert_eq!(runs[1].as_str(), Some("RED"));
        // Cursor should be at col 4 (after RED)
        let cursor = parsed["cursor"].as_object().unwrap();
        assert_eq!(cursor["col"], 4);
    }

    /// D5：宽字符占位 cell 被跳过 —— 两个宽字符合并进同一个 run，
    /// 不产生空段（占位 cell 的字符与样式都不参与编码）。
    #[test]
    fn encode_cell_frame_merges_wide_chars_into_one_run() {
        let mut v = vt(24, 80);
        v.feed("你好".as_bytes()); // each CJK char occupies 2 cells
        let json = v.encode_cell_frame("test-session");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        let runs = parsed["rows"][0]["runs"].as_array().unwrap();
        assert_eq!(runs[0].as_str(), Some(""), "unstyled row starts with the default run");
        assert_eq!(runs[1].as_str().unwrap().trim_end(), "你好");
    }

    #[test]
    fn encode_cell_frame_empty_screen_is_one_blank_run() {
        let mut v = vt(24, 80);
        let json = v.encode_cell_frame("test-session");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        let rows = parsed["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 24);
        // 整行同默认样式 → 单个 run：空 sgr + 80 个空格
        let runs = rows[0]["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].as_str(), Some(""));
        assert_eq!(runs[1].as_str().unwrap().len(), 80);
    }

    // ──── Phase 3: row-level diff + cursor diff ────

    #[test]
    fn first_cell_frame_is_full() {
        let mut v = vt(24, 80);
        let json = v.encode_cell_frame("test-session");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["full"], true, "first frame must be full");
        assert!(parsed["row_indices"].is_null(), "full frame must not have row_indices");
    }

    #[test]
    fn unchanged_second_frame_is_diff() {
        let mut v = vt(24, 80);
        v.feed(b"stable\r\n");
        let _ = v.encode_cell_frame("test-session"); // first = full
        let json = v.encode_cell_frame("test-session"); // second = diff
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["full"], false, "unchanged second frame should be diff");
        assert!(parsed.get("row_indices").is_some(), "diff frame must have row_indices");
        let indices = parsed["row_indices"].as_array().unwrap();
        assert!(indices.is_empty(), "unchanged rows must produce empty diff");
    }

    #[test]
    fn changed_row_appears_in_row_indices() {
        let mut v = vt(24, 80);
        v.feed(b"stable\r\n"); // fills row 1 (0-indexed)
        let _ = v.encode_cell_frame("test-session"); // first = full
        v.feed(b"\x1b[5;1Hchanged"); // change row 4 (1-indexed = 0-indexed 4)
        let json = v.encode_cell_frame("test-session");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["full"], false);
        let indices = parsed["row_indices"].as_array().unwrap();
        assert_eq!(indices.len(), 1, "one row changed");
        let rows = parsed["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "one row in diff");
        assert!(rows[0]["runs"][1].as_str().unwrap().starts_with("changed"));
    }

    #[test]
    fn cursor_omitted_when_unchanged() {
        let mut v = vt(24, 80);
        v.feed(b"hello");
        let json1 = v.encode_cell_frame("test-session");
        let parsed: serde_json::Value = serde_json::from_str(&json1).expect("must be valid JSON");
        assert!(parsed["cursor"].is_object(), "first frame must include cursor");
        let _ = v.encode_cell_frame("test-session"); // second = diff, cursor unchanged
        let json2 = v.encode_cell_frame("test-session");
        // Re-feed same content; diff frame will report no changed rows
        // Cursor should be omitted because position/shape didn't change
        let parsed2: serde_json::Value = serde_json::from_str(&json2).expect("must be valid JSON");
        // Since changed_indices is empty, no rows emitted; cursor must also be omitted
        assert!(parsed2["cursor"].is_null(), "cursor must be omitted when unchanged");
    }

    #[test]
    fn invalidate_diff_forces_next_frame_full() {
        let mut v = vt(24, 80);
        v.feed(b"a\r\n");
        let _ = v.encode_cell_frame("ts"); // full
        let _ = v.encode_cell_frame("ts"); // diff (unchanged)
        v.invalidate_diff(); // force full
        let json = v.encode_cell_frame("ts");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["full"], true, "after invalidate_diff must be full");
        assert!(parsed["row_indices"].is_null());
    }

    #[test]
    fn diff_engine_resizes_on_vt_resize() {
        let mut v = vt(24, 80);
        let _ = v.encode_cell_frame("ts"); // full at 24 rows
        let _ = v.encode_cell_frame("ts"); // diff
        v.resize(40, 80);
        // Next frame: prev hashes resized to 40 None entries → all rows reported changed → full
        let json = v.encode_cell_frame("ts");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["full"], true, "after resize must be full");
        assert_eq!(parsed["height"], 40);
    }

    #[test]
    fn overlay_frame_includes_shape_in_cursor() {
        let mut v = vt(24, 80);
        v.feed(b"hello");
        let json = v.encode_overlay_frame("test-session");
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["overlay"], true);
        assert_eq!(parsed["full"], true);
        let cursor = parsed["cursor"].as_object().unwrap();
        assert!(cursor.get("shape").is_some(), "overlay cursor must include shape");
    }

    // ──── 方案 C Phase 2: alt_screen 标记（D4）────

    #[test]
    fn overlay_frame_carries_alt_screen_flag() {
        let mut v = vt(24, 80);
        v.feed(b"\x1b[?1049h"); // 进入 alt-screen
        let parsed: serde_json::Value =
            serde_json::from_str(&v.encode_overlay_frame("ts")).unwrap();
        assert_eq!(parsed["alt_screen"], true, "enter overlay must carry alt_screen=true");

        v.feed(b"\x1b[?1049l"); // 退出回主屏
        let parsed: serde_json::Value =
            serde_json::from_str(&v.encode_overlay_frame("ts")).unwrap();
        assert_eq!(parsed["alt_screen"], false, "exit overlay must carry alt_screen=false");
    }

    #[test]
    fn regular_frames_omit_alt_screen_field() {
        let mut v = vt(24, 80);
        let parsed: serde_json::Value = serde_json::from_str(&v.encode_cell_frame("ts")).unwrap();
        assert!(parsed.get("alt_screen").is_none(), "regular frame must omit alt_screen");
        let parsed: serde_json::Value =
            serde_json::from_str(&v.encode_viewport_frame("ts", 0)).unwrap();
        assert!(parsed.get("alt_screen").is_none(), "viewport frame must omit alt_screen");
    }

    // ──── 方案 C Phase 1: encode_viewport_frame ────

    /// 填满 24 行屏后多滚进历史的固定场景：末次 \r\n 也触发上滚，
    /// 历史 7 行（L0..L6），屏顶 L7，末行空白（光标行）。
    fn vt_with_history() -> VtState {
        let mut v = vt(24, 80);
        for i in 0..30 {
            v.feed(format!("L{i}\r\n").as_bytes());
        }
        v
    }

    #[test]
    fn viewport_frame_y0_is_live_screen_with_marker() {
        let v = vt_with_history();
        let json = v.encode_viewport_frame("ts", 0);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["viewport"], 0, "viewport marker must carry y");
        assert_eq!(parsed["full"], true);
        assert_eq!(parsed["overlay"], false);
        assert!(parsed["row_indices"].is_null());
        let rows = parsed["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 24);
        // y=0 窗口 = live 屏：顶行 L7
        assert_eq!(top_row_text(&parsed), "L7");
        // 光标可见（回底校准帧与 overlay 同语义）
        assert_eq!(parsed["cursor"]["visible"].as_bool(), Some(true));
    }

    /// 断言窗口顶行文本（取前两格，避开尾随空白格）
    fn top_row_text(parsed: &serde_json::Value) -> String {
        let runs = parsed["rows"][0]["runs"].as_array().unwrap();
        runs[1].as_str().unwrap().chars().take(2).collect()
    }

    #[test]
    fn viewport_frame_scrolls_into_history() {
        let v = vt_with_history();
        // 历史 7 行（L0..L6）；y=7 窗口顶 = Line(-7) = L0
        let json = v.encode_viewport_frame("ts", 7);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(top_row_text(&parsed), "L0");
        // y=5 窗口顶 = Line(-5) = L2
        let json = v.encode_viewport_frame("ts", 5);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(top_row_text(&parsed), "L2");
    }

    #[test]
    fn viewport_frame_y_clamps_to_history_size() {
        let v = vt_with_history();
        // 超界 y 钳制到 history_size（6），不 panic 且内容与 y=6 相同
        let json = v.encode_viewport_frame("ts", u32::MAX);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["viewport"], 7, "y must clamp to history size");
        assert_eq!(top_row_text(&parsed), "L0");
    }

    #[test]
    fn viewport_frame_hides_cursor_above_bottom() {
        let v = vt_with_history();
        let json = v.encode_viewport_frame("ts", 6);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(
            parsed["cursor"]["visible"].as_bool(),
            Some(false),
            "history window has no live cursor"
        );
        let json = v.encode_viewport_frame("ts", 0);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["cursor"]["visible"].as_bool(), Some(true));
    }

    #[test]
    fn viewport_frame_does_not_disturb_diff_baseline() {
        let mut v = vt_with_history();
        let _ = v.encode_cell_frame("ts"); // full
        let _ = v.encode_viewport_frame("ts", 6); // 不触碰 diff 基线
        let json = v.encode_cell_frame("ts"); // 实时流继续 diff
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["full"], false, "viewport encode must not invalidate diff");
        assert!(parsed["row_indices"].as_array().unwrap().is_empty());
    }

    #[test]
    fn viewport_frame_empty_history_clamps_to_zero() {
        let v = vt(24, 80); // 无历史
        let json = v.encode_viewport_frame("ts", 10);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("must be valid JSON");
        assert_eq!(parsed["viewport"], 0, "empty history clamps y to 0");
    }

    // ──── RLE 行编码（docs/dev/plans/2026-08-28-pty-frame-rle.md）────

    /// 从帧 JSON 的一行抽出「可见字符 → 该字符生效时 sgr」序列。
    fn visible_seq(row: &serde_json::Value) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let runs = row["runs"].as_array().expect("row must carry runs");
        for pair in runs.chunks(2) {
            let sgr = pair[0].as_str().unwrap_or_default();
            for c in pair[1].as_str().unwrap_or_default().chars() {
                out.push((c.to_string(), sgr.to_string()));
            }
        }
        out
    }

    /// 直接遍历 grid 的「字符 → 生效 sgr」序列 —— **与 RLE 编码独立**的参考
    /// 实现，作为 RLE 无损性的真相源（宽字符占位 cell 不产生渲染输出，跳过）。
    fn grid_seq(v: &VtState, line: Line) -> Vec<(String, String)> {
        let grid = v.term.grid();
        let mut out = Vec::new();
        for col in 0..v.term.columns() {
            let cell = &grid[line][Column(col)];
            if cell.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                continue;
            }
            let sgr = sgr_body(&CellStyle::of(cell)).unwrap_or_default();
            // 与 `visible_seq` 同粒度：主字符与零宽字符各自成一项（零宽不占列，
            // 故不算独立 cell，但仍是独立的码点）。
            let mut text = String::from(cell.c);
            if let Some(zw) = cell.zerowidth() {
                text.extend(zw.iter().copied());
            }
            for ch in text.chars() {
                out.push((ch.to_string(), sgr.clone()));
            }
        }
        out
    }

    fn rows_of(feed: &[u8]) -> Vec<serde_json::Value> {
        let mut v = vt(6, 20);
        v.feed(feed);
        let json = v.encode_viewport_frame("ts", 0);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        parsed["rows"].as_array().unwrap().clone()
    }

    /// 核心不变式：RLE 合并是无损的 —— 解码出的「字符 → 该字符生效时 sgr」
    /// 序列与直接遍历 grid 的结果逐项相同。覆盖空行、纯文本、彩色切换、
    /// 逐字符切换、行尾空格、CJK 宽字符（含占位）、emoji、组合音标。
    #[test]
    fn runs_encoding_is_lossless_against_grid() {
        let cases: &[&[u8]] = &[
            b"\r\n",
            b"plain ascii row\r\n",
            b"\x1b[1;32mgreen\x1b[0m plain\r\n",
            b"\x1b[31mR\x1b[32mG\x1b[33mY\x1b[34mB\x1b[0m tail\r\n",
            b"trailing spaces   \r\n",
            "中文测试 ターミナル 混排\r\n".as_bytes(),
            "\x1b[31m中文\x1b[0m 混排\r\n".as_bytes(),
            "emoji \u{1f600}\u{1f1fa}\u{1f1f8} end\r\n".as_bytes(),
            // 组合音标：e + U+0301 是**零宽**字符，cell.c 只存 'e'
            "combining e\u{301} cafe\u{301}\r\n".as_bytes(),
        ];
        for feed in cases {
            let mut v = vt(6, 20);
            v.feed(feed);
            let json = v.encode_viewport_frame("ts", 0);
            let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
            let rows = parsed["rows"].as_array().unwrap();
            for (i, row) in rows.iter().enumerate() {
                assert_eq!(
                    visible_seq(row),
                    grid_seq(&v, Line(i as i32)),
                    "row {i} lost information for input {:?}",
                    String::from_utf8_lossy(feed)
                );
            }
        }
    }

    #[test]
    fn runs_merges_consecutive_cells_sharing_sgr() {
        let rows = rows_of(b"\x1b[1;32mAB\x1b[0mcd\r\n");
        let runs = rows[0]["runs"].as_array().unwrap();
        // 4 个可见字符 + 16 列填充：cd 与填充同为默认样式 → 合并进同一 run
        assert_eq!(runs.len(), 4, "must be (sgr, text) pairs, got {runs:?}");
        assert_eq!(runs[0], "1;32");
        assert_eq!(runs[1], "AB");
        assert_eq!(runs[2], "");
        assert_eq!(runs[3].as_str().unwrap().trim_end(), "cd");
    }

    /// D5：宽字符占位 cell 被跳过且不切成独立 run。
    ///
    /// 占位 cell 若参与 RLE 编码会把彩色宽字符行从中间切断 —— 故用着色
    /// CJK 而非纯文本才有区分度。
    #[test]
    fn runs_skips_wide_char_spacers_without_empty_run() {
        let rows = rows_of("\x1b[31m中文\x1b[0m\r\n".as_bytes());
        let runs = rows[0]["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 4, "spacers must not split the run, got {runs:?}");
        assert_eq!(runs[0], "31");
        // 两个宽字符占 4 列，其后 16 列填充空格（默认样式）是第二个 run
        assert_eq!(runs[1].as_str().unwrap().trim_end(), "中文");
        assert_eq!(runs[2], "");
    }

    /// 零宽组合字符必须随主字符一起编码：alacritty 把它存在 cell 的
    /// `zerowidth` 里，只取 `cell.c` 会让 `e` + U+0301 退化成 `e`。
    ///
    /// 该缺陷由 `scripts/pty-frame-regression.mjs` T3（runs 帧 vs pty 原始字节流）
    /// 暴露 —— cells 与 runs 都漏它，两种编码互相比对测不出来。
    #[test]
    fn runs_keeps_zerowidth_combining_characters() {
        let rows = rows_of("cafe\u{301}\r\n".as_bytes());
        let text = rows[0]["runs"][1].as_str().unwrap();
        assert!(text.starts_with("cafe\u{301}"), "combining accent must survive, got {text:?}");
    }

    #[test]
    fn runs_handles_full_width_row_as_single_run() {
        let mut v = vt(2, 200);
        v.feed(&[b'x'; 200]);
        let json = v.encode_viewport_frame("ts", 0);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let runs = parsed["rows"][0]["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 2, "single-style row must be one run, got {runs:?}");
        assert_eq!(runs[1].as_str().unwrap().len(), 200);
    }

    /// 行指纹的不变式：**内容或样式任一改变都必须改变指纹**。
    ///
    /// 漏检的后果是 diff 帧不发该行 → 界面停在旧内容（且要等下次全帧才恢复），
    /// 属于静默错误，故单独守护。
    #[test]
    fn row_hash_detects_content_and_style_changes() {
        let mut v = vt(6, 20);
        v.feed(b"abc\r\ndef\r\n");
        let base = hash_grid_row(v.term.grid(), 20, Line(0));
        assert_eq!(base, hash_grid_row(v.term.grid(), 20, Line(0)), "同内容必须同指纹");
        assert_ne!(base, hash_grid_row(v.term.grid(), 20, Line(1)), "不同行内容必须不同");

        v.feed(b"\x1b[1;1Habd");
        assert_ne!(base, hash_grid_row(v.term.grid(), 20, Line(0)), "字符变化必须检出");

        v.feed(b"\x1b[1;1Habc"); // 还原字符
        assert_eq!(base, hash_grid_row(v.term.grid(), 20, Line(0)), "还原后回到原指纹");

        v.feed(b"\x1b[1;1H\x1b[1mabc"); // 同字符、加粗重写
        assert_ne!(base, hash_grid_row(v.term.grid(), 20, Line(0)), "样式变化必须检出");
    }

    /// D2：三种帧共用 `encode_row_static`，故行编码对三者一致。
    #[test]
    fn runs_encoding_applies_to_all_frame_types() {
        let mut v = vt(6, 20);
        v.feed(b"abc\r\n");
        for json in [
            v.encode_cell_frame("ts"),
            v.encode_overlay_frame("ts"),
            v.encode_viewport_frame("ts", 0),
        ] {
            let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert!(parsed["rows"][0]["runs"].is_array(), "all frames must use runs: {parsed}");
        }
    }
}
