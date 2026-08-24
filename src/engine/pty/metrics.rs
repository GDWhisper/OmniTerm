//! Frame-level metrics (Phase 3 observability).
//!
//! Exposes cell_frame encoding size for monitoring/dashboard hooks.

#![allow(dead_code)]

use std::sync::LazyLock;
use std::sync::atomic::{AtomicU64, Ordering};

/// Frame size metrics singleton.
#[derive(Default)]
pub struct FrameMetrics {
    /// Most recent cell_frame JSON payload size (bytes).
    last_bytes: AtomicU64,
    /// Total cell_frame encodings since process start.
    total_frames: AtomicU64,
}

impl FrameMetrics {
    /// Record one cell_frame encoding.
    pub fn record_cell_frame_bytes(&self, bytes: usize) {
        self.last_bytes.store(bytes as u64, Ordering::Relaxed);
        self.total_frames.fetch_add(1, Ordering::Relaxed);
    }

    /// Last recorded cell_frame size (bytes), or 0 if none recorded yet.
    pub fn last_bytes(&self) -> u64 {
        self.last_bytes.load(Ordering::Relaxed)
    }

    /// Total cell_frame encodings since process start.
    pub fn total_frames(&self) -> u64 {
        self.total_frames.load(Ordering::Relaxed)
    }
}

static METRICS: LazyLock<FrameMetrics> = LazyLock::new(FrameMetrics::default);

/// Record a cell_frame encoding for observability.
pub fn record_cell_frame_bytes(bytes: usize) {
    METRICS.record_cell_frame_bytes(bytes);
}

/// Read access for monitoring hooks.
pub fn last_cell_frame_bytes() -> u64 {
    METRICS.last_bytes()
}

/// Read access for monitoring hooks.
pub fn total_cell_frames() -> u64 {
    METRICS.total_frames()
}
