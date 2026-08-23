//! Semantic 事件检测（Phase 2）：在 Pty 读循环中检测 alt-screen / mode
//! 等 VT 模式变化，经 broadcast 通道通知 forward 任务发送 overlay
//! cell_frame 给前端清屏重绘。
//!
//! 设计依据：design.md §2 Phase 2、「选择性覆盖层」。

use alacritty_terminal::term::TermMode;

use super::vt::VtState;

/// 前端需感知的语义事件。
///
/// 每个变体携带足够的信息让 forward 任务构造对应的 cell_frame。
#[derive(Clone, Debug)]
pub enum SemanticEvent {
    /// 进入 alt-screen（vim / htop / less 等）。
    AltScreenEnter,
    /// 退出 alt-screen 回到主屏。
    AltScreenExit,
    /// DECSET/DECRST 模式切换（除 alt-screen 外的其他影响渲染的模式）。
    ModeChange { added: TermMode, removed: TermMode },
}

/// 在 pty 读循环的 `vt.feed()` 之后调用，检测模式变化并返回
/// 需要通知前端的事件列表。
///
/// - 无状态：只对比新旧 TermMode，不持有任何内部缓存
/// - 低成本：bitflags 操作，O(1)
pub fn detect_events(vt: &VtState, prev_mode: &mut TermMode) -> Vec<SemanticEvent> {
    let cur_mode = vt.mode();
    let mut events = Vec::new();

    let was_alt = prev_mode.contains(TermMode::ALT_SCREEN);
    let is_alt = cur_mode.contains(TermMode::ALT_SCREEN);

    if !was_alt && is_alt {
        events.push(SemanticEvent::AltScreenEnter);
    } else if was_alt && !is_alt {
        events.push(SemanticEvent::AltScreenExit);
    }

    let diff_added = cur_mode - *prev_mode;
    let diff_removed = *prev_mode - cur_mode;
    if !diff_added.is_empty() || !diff_removed.is_empty() {
        // 排除 ALT_SCREEN（由 AltScreenEnter/Exit 单独处理）
        let added = diff_added & !TermMode::ALT_SCREEN;
        let removed = diff_removed & !TermMode::ALT_SCREEN;
        if !added.is_empty() || !removed.is_empty() {
            events.push(SemanticEvent::ModeChange { added, removed });
        }
    }

    *prev_mode = cur_mode;
    events
}

#[cfg(test)]
mod tests {
    use super::super::vt::VtState;
    use super::*;

    #[test]
    fn detect_alt_screen_enter() {
        let mut v = VtState::new(24, 80);
        v.feed(b"\x1b[?1049h"); // 进入 alt-screen
        let mut prev_mode = TermMode::empty();
        let events = detect_events(&v, &mut prev_mode);
        assert!(
            matches!(events[0], SemanticEvent::AltScreenEnter),
            "expected AltScreenEnter, got: {events:?}"
        );
    }

    #[test]
    fn detect_alt_screen_exit() {
        let mut v = VtState::new(24, 80);
        v.feed(b"\x1b[?1049h");
        let mut prev_mode = TermMode::empty();
        let _ = detect_events(&v, &mut prev_mode); // consume enter
        v.feed(b"\x1b[?1049l");
        let events = detect_events(&v, &mut prev_mode);
        assert!(
            matches!(events[0], SemanticEvent::AltScreenExit),
            "expected AltScreenExit, got: {events:?}"
        );
    }

    #[test]
    fn no_event_on_unchanged_mode() {
        let v = VtState::new(24, 80);
        // prev_mode 从终端的当前 mode 开始，feed 前无输入故无变化
        let mut prev_mode = v.mode();
        let events = detect_events(&v, &mut prev_mode);
        assert!(events.is_empty(), "no change yet: {events:?}");
    }

    #[test]
    fn detect_mode_change_other_than_alt() {
        let mut v = VtState::new(24, 80);
        v.feed(b"\x1b[?1h"); // DECCKM (cursor keys mode)
        let mut prev_mode = TermMode::empty();
        let events = detect_events(&v, &mut prev_mode);
        let has_mode_change = events.iter().any(|e| matches!(e, SemanticEvent::ModeChange { .. }));
        assert!(has_mode_change, "expected ModeChange, got: {events:?}");
    }
}
