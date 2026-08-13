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
//! 补屏说明：前端 xterm.js 消费原始 ANSI 流，重连补屏继续用补屏环回放
//! （字节级保真，切片 A 已验收）；herdr 的「模拟器重渲染整帧」适配其
//! 帧 diff 协议，对 ANSI 流客户端无增益，故不采用（计划 §3 切片 B 的
//! 执行偏差记录）。模拟器承担 capture/title/resize + 切片 C 的 ANSI seed。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use alacritty_terminal::event::{Event, EventListener, WindowSize};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::{Config as TermConfig, Osc52, Term};
use alacritty_terminal::vte::ansi::{Processor, Rgb};
use tracing::warn;

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

pub struct VtState {
    term: Term<VtEventListener>,
    processor: Processor,
    sink: Arc<ResponseSink>,
    rows: u16,
    cols: u16,
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
        Self { term, processor: Processor::new(), sink, rows: rows as u16, cols: cols as u16 }
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
}
