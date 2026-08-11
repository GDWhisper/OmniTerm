//! 服务端 VT 模拟器（wezterm-term，计划 D8 / 切片 B）。
//!
//! 每个 pty 会话维护一份 grid，作为「屏幕真相源」：
//! - `capture_visible`：agent 屏幕检测的干净文本（替代切片 A 的原始字节
//!   lossy 方案，消除转义序列碎片对规则匹配的干扰）
//! - `title`：OSC 0/2 标题（watch_targets 的证据源）
//! - `resize`：与 pty master 同步视口
//! - 模拟器对 pty 的应答字节（DSR/DA 等）经 [`PtySession::write`] 回写闭环
//!
//! 补屏说明：前端 xterm.js 消费原始 ANSI 流，重连补屏继续用补屏环回放
//! （字节级保真，切片 A 已验收）；herdr 的「模拟器重渲染整帧」适配其
//! 帧 diff 协议，对 ANSI 流客户端无增益，故不采用（计划 §3 切片 B 的
//! 执行偏差记录）。模拟器承担 capture/title/resize + 切片 C 的 ANSI seed。

use std::io;
use std::sync::Arc;

use wezterm_term::color::ColorPalette;
use wezterm_term::{Terminal, TerminalConfiguration, TerminalSize};

use crate::engine::pty::session::PtySession;

/// VT scrollback 行数上限（P1 有界：grid 内存 ≈ 行数 × 列数 × 单元开销，
/// 1000 行 × 200 列 ≈ 数 MB 量级/会话）。
const VT_SCROLLBACK_LINES: usize = 1000;

/// 固定配置：默认调色板 + 有界 scrollback。
#[derive(Debug)]
struct VtConfig;

impl TerminalConfiguration for VtConfig {
    fn color_palette(&self) -> ColorPalette {
        ColorPalette::default()
    }

    fn scrollback_size(&self) -> usize {
        VT_SCROLLBACK_LINES
    }
}

/// 模拟器应答回写：DSR/DA 等响应直接写回 pty master（herdr I/O 闭环模式）。
struct ResponseWriter {
    session: Arc<PtySession>,
}

impl io::Write for ResponseWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.session.write(buf).map_err(|e| io::Error::other(e.to_string()))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub struct VtState {
    term: Terminal,
}

impl VtState {
    pub fn new(rows: u16, cols: u16, session: Arc<PtySession>) -> Self {
        let size = TerminalSize {
            rows: rows.max(1) as usize,
            cols: cols.max(1) as usize,
            pixel_width: 0,
            pixel_height: 0,
            dpi: 96,
        };
        let term = Terminal::new(
            size,
            Arc::new(VtConfig),
            "OmniTerm",
            env!("CARGO_PKG_VERSION"),
            Box::new(ResponseWriter { session }),
        );
        Self { term }
    }

    /// 喂入 pty 输出（允许任意切片边界，解析器自处理跨块序列）。
    pub fn feed(&mut self, bytes: &[u8]) {
        self.term.advance_bytes(bytes);
    }

    /// OSC 0/2 标题（无则空串）。
    pub fn title(&self) -> String {
        self.term.get_title().to_string()
    }

    /// 与 pty resize 同步视口。
    pub fn resize(&mut self, rows: u16, cols: u16) {
        let size = TerminalSize {
            rows: rows.max(1) as usize,
            cols: cols.max(1) as usize,
            pixel_width: 0,
            pixel_height: 0,
            dpi: 96,
        };
        self.term.resize(size);
    }

    /// 可见屏纯文本（tmux `capture-pane -p` 等价语义：活动屏、不带转义）。
    /// 行尾空白去除，行间 `\n` 连接。
    pub fn capture_visible(&self) -> String {
        let screen = self.term.screen();
        let rows = screen.physical_rows;
        if rows == 0 {
            return String::new();
        }
        // 可见区 = 最后 physical_rows 行（stable 索引空间里取尾部窗口）
        let bottom = screen.visible_row_to_stable_row((rows - 1) as i64) + 1;
        let top = bottom - rows as isize;
        let phys_range = screen.stable_range(&(top..bottom));
        let mut out = String::new();
        for line in screen.lines_in_phys_range(phys_range) {
            let text: String = line.visible_cells().map(|c| c.str().to_string()).collect();
            out.push_str(text.trim_end());
            out.push('\n');
        }
        out
    }

    /// 全部 scrollback + 可见屏纯文本（切片 C 的 ANSI seed 源之一）。
    #[allow(dead_code)]
    pub fn capture_all(&self) -> String {
        let screen = self.term.screen();
        let total = screen.physical_rows;
        let bottom = screen.visible_row_to_stable_row((total - 1) as i64) + 1;
        let top = bottom - total as isize - screen.scrollback_rows() as isize;
        let phys_range = screen.stable_range(&(top..bottom));
        let mut out = String::new();
        for line in screen.lines_in_phys_range(phys_range) {
            let text: String = line.visible_cells().map(|c| c.str().to_string()).collect();
            out.push_str(text.trim_end());
            out.push('\n');
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{CommandBuilder, PtySize};

    fn vt(rows: u16, cols: u16) -> VtState {
        // 会话进程仅为应答回写提供 fd；测试结束 drop VtState 时 master 关闭，
        // sleep 收到 SIGHUP 退出，无进程泄漏。
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("30");
        let session = Arc::new(
            PtySession::spawn(cmd, PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .unwrap(),
        );
        VtState::new(rows, cols, session)
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
}
