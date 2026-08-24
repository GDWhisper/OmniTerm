//! Phase R2 binary: backend frame-size / frequency benchmarks.
//!
//! Measures `render_screen()` output size, ByteRing snapshots,
//! and cell-level diff estimates for typical pty output patterns.
//!
//! Usage:
//!   cargo run --bin bench-frames --
//!
//! Does NOT modify any production code paths.

use alacritty_terminal::event::{Event, EventListener};
use alacritty_terminal::grid::Dimensions;
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use alacritty_terminal::term::{Config, Osc52, Term};
use alacritty_terminal::vte::ansi::{Color, NamedColor, Processor, Timeout};
use std::collections::VecDeque;
use std::time::Instant;

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const ROWS: u16 = 24;
const COLS: u16 = 80;
const VT_SCROLLBACK: usize = 256;
const REPLAY_BYTES: usize = 256 * 1024;

// ──────────────────────────────────────────────────────────────
// Dimensions (mirrors VtSize in vt.rs)
// ──────────────────────────────────────────────────────────────

#[derive(Clone, Copy)]
struct VDims {
    rows: usize,
    cols: usize,
}

impl Dimensions for VDims {
    fn total_lines(&self) -> usize {
        self.rows + VT_SCROLLBACK
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

// ──────────────────────────────────────────────────────────────
// Minimal EventListener
// ──────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
struct BenchEvt;

impl Timeout for BenchEvt {
    fn set_timeout(&mut self, _duration: std::time::Duration) {}
    fn clear_timeout(&mut self) {}
    fn pending_timeout(&self) -> bool {
        false
    }
}

impl EventListener for BenchEvt {
    fn send_event(&self, _event: Event) {}
}

// ──────────────────────────────────────────────────────────────
// ByteRing (simplified from ring.rs)
// ──────────────────────────────────────────────────────────────

struct ByteRing {
    cap: usize,
    chunks: VecDeque<Vec<u8>>,
    total: usize,
}

impl ByteRing {
    fn new(cap: usize) -> Self {
        Self { cap, chunks: VecDeque::new(), total: 0 }
    }
    fn push(&mut self, d: &[u8]) {
        if d.len() > self.cap {
            self.chunks.clear();
            self.chunks.push_back(d[d.len() - self.cap..].to_vec());
            self.total = self.cap;
            return;
        }
        self.chunks.push_back(d.to_vec());
        self.total += d.len();
        while self.total > self.cap {
            if let Some(f) = self.chunks.pop_front() {
                self.total -= f.len();
            }
        }
    }
    fn snapshot(&self) -> Vec<u8> {
        let mut o = Vec::with_capacity(self.total.min(self.cap));
        for c in &self.chunks {
            o.extend_from_slice(c);
        }
        o
    }
    #[allow(dead_code)]
    fn bytes(&self) -> usize {
        self.total.min(self.cap)
    }
}

// ──────────────────────────────────────────────────────────────
// SGR builder (mirrors vt.rs sgr_body + color_sgr + color_sgr_bg)
// ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
struct CCfg {
    fg: Color,
    bg: Color,
    flags: Flags,
}

impl CCfg {
    fn of(c: &Cell) -> Self {
        Self { fg: c.fg, bg: c.bg, flags: c.flags }
    }
    fn is_default(&self) -> bool {
        self.fg == Color::Named(NamedColor::Foreground)
            && self.bg == Color::Named(NamedColor::Background)
            && self.flags.is_empty()
    }
}

fn sgr(st: &CCfg) -> Option<String> {
    let mut p = Vec::<String>::new();
    for (f, c) in [
        (Flags::BOLD, "1"),
        (Flags::DIM, "2"),
        (Flags::ITALIC, "3"),
        (Flags::UNDERLINE, "4"),
        (Flags::INVERSE, "7"),
        (Flags::HIDDEN, "8"),
        (Flags::STRIKEOUT, "9"),
    ] {
        if st.flags.contains(f) {
            p.push(c.into());
        }
    }
    if st.fg != Color::Named(NamedColor::Foreground)
        && let Some(s) = fg_s(st.fg)
    {
        p.push(s);
    }
    if st.bg != Color::Named(NamedColor::Background)
        && let Some(s) = bg_s(st.bg)
    {
        p.push(s);
    }
    if p.is_empty() { None } else { Some(p.join(";")) }
}

fn fg_s(c: Color) -> Option<String> {
    match c {
        Color::Named(n) => {
            // Standard 16 SGR colors (0-15), rest return None.
            // NamedColor is Copy+Ord, can use discriminant.
            let idx = n as u32;
            static STD_FG: [Option<&'static str>; 16] = {
                const {
                    [
                        Some("30"),
                        Some("31"),
                        Some("32"),
                        Some("33"),
                        Some("34"),
                        Some("35"),
                        Some("36"),
                        Some("37"),
                        Some("90"),
                        Some("91"),
                        Some("92"),
                        Some("93"),
                        Some("94"),
                        Some("95"),
                        Some("96"),
                        None, // 0-15
                    ]
                }
            };
            STD_FG.get(idx as usize).copied().flatten().map(String::from)
        }
        Color::Indexed(i) => Some(format!("38;5;{}", i)),
        Color::Spec(rgb) => Some(format!("38;2;{};{};{}", rgb.r, rgb.g, rgb.b)),
    }
}

fn bg_s(c: Color) -> Option<String> {
    match c {
        Color::Named(n) => {
            let idx = n as u32;
            static STD_BG: [Option<&'static str>; 16] = {
                const {
                    [
                        Some("40"),
                        Some("41"),
                        Some("42"),
                        Some("43"),
                        Some("44"),
                        Some("45"),
                        Some("46"),
                        Some("47"),
                        Some("100"),
                        Some("101"),
                        Some("102"),
                        Some("103"),
                        Some("104"),
                        Some("105"),
                        Some("106"),
                        None, // 0-15
                    ]
                }
            };
            STD_BG.get(idx as usize).copied().flatten().map(String::from)
        }
        Color::Indexed(i) => Some(format!("48;5;{}", i)),
        Color::Spec(rgb) => Some(format!("48;2;{};{};{}", rgb.r, rgb.g, rgb.b)),
    }
}

// ──────────────────────────────────────────────────────────────
// Benchmark state
// ──────────────────────────────────────────────────────────────

struct Stats {
    render_bytes: usize,
    raw_bytes: usize,
    visible_cells: usize,
    sgr_changes: usize,
    non_default_cells: usize,
    feed_us: u128,
}

struct Bench {
    rows: usize,
    cols: usize,
}

impl Bench {
    fn new() -> Self {
        Self { rows: ROWS as usize, cols: COLS as usize }
    }

    /// Feed raw bytes into alacritty_terminal::Term, then compute what
    /// vt.rs render_screen() would produce as byte size.
    fn measure(&self, bytes: &[u8]) -> Stats {
        let cfg = Config {
            scrolling_history: VT_SCROLLBACK,
            osc52: Osc52::Disabled,
            ..Config::default()
        };
        let dims = VDims { rows: self.rows, cols: self.cols };
        let mut term = Term::new(cfg, &dims, BenchEvt);
        let mut proc: Processor<BenchEvt> = Processor::new();

        let t0 = Instant::now();
        proc.advance(&mut term, bytes);
        let feed_us = t0.elapsed().as_micros();

        let grid = term.grid();
        let mut rb: usize = 0; // render bytes
        let mut vc: usize = 0; // visible cells
        let mut sc: usize = 0; // sgr changes

        for row in 0..self.rows {
            let sl = &grid[Line(row as i32)][Column(0)..Column(self.cols)];
            let vis: Vec<(CCfg, char)> = sl
                .iter()
                .filter(|c| {
                    !c.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
                })
                .map(|c| {
                    vc += 1;
                    (CCfg::of(c), c.c)
                })
                .collect();

            let trim =
                vis.iter().rev().take_while(|(st, ch)| *ch == ' ' && st.is_default()).count();
            let ct = &vis[..vis.len() - trim];

            let mut prev: Option<&CCfg> = None;
            for (st, ch) in ct {
                if prev != Some(st) {
                    rb += 4; // \x1b[0m
                    if let Some(bd) = sgr(st) {
                        rb += bd.len() + 2;
                    }
                    prev = Some(st);
                    sc += 1;
                }
                rb += ch.len_utf8();
            }
            rb += 4; // final reset for this line
            if row + 1 < self.rows {
                rb += 2;
            } // \r\n
        }
        // CUP + cursor visibility
        rb += format!("\x1b[{};{}H", self.rows, self.cols).len() + 5;

        // Count non-default cells (diff candidate)
        let mut nd = 0;
        for row in 0..self.rows {
            let sl = &grid[Line(row as i32)][Column(0)..Column(self.cols)];
            for c in sl {
                if c.flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) {
                    continue;
                }
                if !(c.c == ' '
                    && c.fg == Color::Named(NamedColor::Foreground)
                    && c.bg == Color::Named(NamedColor::Background)
                    && c.flags.is_empty())
                {
                    nd += 1;
                }
            }
        }

        Stats {
            render_bytes: rb,
            raw_bytes: bytes.len(),
            visible_cells: vc,
            sgr_changes: sc,
            non_default_cells: nd,
            feed_us,
        }
    }
}

// ──────────────────────────────────────────────────────────────
// Raw pty output generators
// ──────────────────────────────────────────────────────────────

fn gen_empty() -> Vec<u8> {
    Vec::new()
}

fn gen_plain() -> Vec<u8> {
    let mut o = Vec::new();
    o.extend_from_slice(b"\x1b[0m");
    o.extend_from_slice(b"Hello, OmniTerm!\r\n");
    o.extend_from_slice(b"Line 2: more text here.\r\n");
    o.extend_from_slice(b"Line 3: more content.\r\n");
    o
}

fn gen_color_tui() -> Vec<u8> {
    let mut o = Vec::new();
    o.extend_from_slice(b"\x1b[2J\x1b[H");
    for r in 0..22 {
        for c in 0..75 {
            let fgs = ["1;31", "32", "33", "1;34", "35", "36", "91", "92", "1;33"];
            let s = fgs[(r * 3 + c) % fgs.len()];
            o.extend_from_slice(format!("\x1b[{}mX\x1b[0m", s).as_bytes());
        }
        o.extend_from_slice(b"\r\n");
    }
    o
}

fn gen_alt_toggle() -> Vec<u8> {
    let mut o = Vec::new();
    o.extend_from_slice(b"\x1b[?1049h");
    for _ in 0..10 {
        o.extend_from_slice(b"Alt screen!\r\n");
    }
    o.extend_from_slice(b"\x1b[?1049l\x1b[2J\x1b[H");
    o.extend_from_slice(b"Main screen back.\r\n");
    o
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

fn show(name: &str, data: &[u8], b: &Bench) {
    let s = b.measure(data);
    let r = if s.raw_bytes > 0 { s.render_bytes as f64 / s.raw_bytes as f64 } else { 0.0 };
    println!("\n=== {} ===", name);
    println!("  Raw:            {:>6} bytes", s.raw_bytes);
    println!("  render_screen:  {:>6} bytes", s.render_bytes);
    println!("  Ratio:          {:>6.3}x", r);
    println!("  Vis cells:      {:>6}", s.visible_cells);
    println!("  SGR changes:    {:>6}", s.sgr_changes);
    println!("  Non def cells:  {:>6}", s.non_default_cells);
    println!("  Feed VT:        {:>6.1} us", s.feed_us);
}

fn main() {
    let b = Bench::new();
    eprintln!("OmniTerm Phase R2 | {}x{} | alacritty_terminal 0.26.0", ROWS, COLS);

    show("empty", &gen_empty(), &b);
    show("plain text", &gen_plain(), &b);
    show("color TUI", &gen_color_tui(), &b);
    show("alt-screen toggle", &gen_alt_toggle(), &b);

    // ByteRing burst
    println!("\n=== ByteRing burst ===");
    let mut ring = ByteRing::new(REPLAY_BYTES);
    for i in 0..100 {
        ring.push(&format!("\x1b[1;34m{}\x1b[0m\r\n", "f".repeat(10 + (i % 5))).into_bytes());
    }
    let snap = ring.snapshot();
    println!(
        "  100 bursts -> {} snap / {} KB cap ({:.1}%)",
        snap.len(),
        REPLAY_BYTES / 1024,
        snap.len() as f64 / REPLAY_BYTES as f64 * 100.0
    );

    // H4 bandwidth estimate
    println!("\n=== H4 Bandwidth estimate ===");
    let raw = gen_color_tui().len() as f64 / 1024.0;
    let st = b.measure(&gen_color_tui());
    let rs = st.render_bytes as f64 / 1024.0;
    let fps = 30;
    println!("  Raw/ frame:    {:.1} KB", raw);
    println!("  Cell/ frame:   {:.1} KB", rs);
    println!("  Ratio:         {:.3}x", rs / raw);
    println!("  At {}fps:", fps);
    println!("    Raw BW:  {:.1} KB/s", raw * fps as f64);
    println!("    Cell BW: {:.1} KB/s", rs * fps as f64);
    if rs < raw {
        println!("  H4 sparse: cell BW < raw BW ({:.1}% saving)", (1.0 - rs / raw) * 100.0);
    } else {
        println!("  H4 dense: cell BW >= raw BW");
        println!(
            "    {} KB/s = {} MBit/s",
            (rs * fps as f64) as u32,
            (rs * fps as f64 * 8.0 / 1024.0) as u32
        );
    }
}
