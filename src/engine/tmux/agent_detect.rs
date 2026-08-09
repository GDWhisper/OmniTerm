//! Agent 屏幕状态检测引擎（herdr manifest 体系的精简移植）。
//!
//! 每个 agent 一份 TOML 规则文件（`manifests/*.toml`，编译进二进制），对
//! `tmux capture-pane` 的可见屏文本 + `#{pane_title}`（OSC 标题）做声明式
//! 匹配，输出 [`AgentState`]。规则按 `priority` 降序取首个命中；无命中回退
//! Idle（blocked 检测刻意保守：宁漏报不误报，与 herdr 一致）。
//!
//! 与 herdr 的差异（见 docs/reference/herdr-reference.md）：
//! - state 命名映射：working→Running、blocked→Waiting、idle→Idle、
//!   unknown→跳过（沿用本项目既有 `AgentState` 枚举）
//! - region 支持子集：`whole_recent` / `bottom_non_empty_lines(N)` /
//!   `osc_title` / `after_last_horizontal_rule` / `prompt_box_body`；
//!   herdr 的 `after_last_prompt_marker` 等在 manifest 里降级为 `whole_recent`
//! - 匹配前统一剥离 TUI 边框字符（`│┃║`），使 `^\s*❯` 类行锚定模式
//!   能命中框内正文
//!
//! 防抖状态机 [`Debounce`]：Running/Waiting 立即发布；Idle 需连续
//! [`IDLE_CONFIRM_TICKS`] 次确认（除非规则带 `visible_idle` 强证据），
//! 吸收 agent 渲染间隙的假 idle。

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::Deserialize;
use tracing::warn;

use crate::engine::tmux::agent_state::{AgentKind, AgentState};

const CLAUDE_MANIFEST: &str = include_str!("manifests/claude.toml");
const CODEX_MANIFEST: &str = include_str!("manifests/codex.toml");
const QODER_MANIFEST: &str = include_str!("manifests/qoder.toml");

/// Idle 需要连续确认的 tick 数（tick 间隔见 agent_watch::TICK_INTERVAL）。
pub const IDLE_CONFIRM_TICKS: u8 = 2;

// ---------- manifest 反序列化 ----------

#[derive(Debug, Deserialize)]
struct ManifestDoc {
    #[serde(default)]
    rules: Vec<RuleDoc>,
}

#[derive(Debug, Deserialize)]
struct RuleDoc {
    id: String,
    state: String,
    priority: i64,
    region: String,
    #[serde(default)]
    skip_state_update: bool,
    #[serde(default)]
    visible_idle: bool,
    #[serde(flatten)]
    matcher: MatcherDoc,
}

#[derive(Debug, Deserialize, Default)]
struct MatcherDoc {
    #[serde(default)]
    contains: Vec<String>,
    #[serde(default)]
    regex: Vec<String>,
    #[serde(default)]
    line_regex: Vec<String>,
    #[serde(default)]
    any: Vec<MatcherDoc>,
    #[serde(default)]
    all: Vec<MatcherDoc>,
    #[serde(default)]
    not: Vec<MatcherDoc>,
}

// ---------- 编译后的规则 ----------

#[derive(Debug)]
struct Rule {
    id: String,
    /// `None` 表示 skip_state_update / unknown：命中时保持上一状态。
    outcome: Option<AgentState>,
    priority: i64,
    region: Region,
    visible_idle: bool,
    matcher: Matcher,
}

#[derive(Debug, Clone, Copy)]
enum Region {
    Whole,
    BottomNonEmpty(usize),
    OscTitle,
    AfterLastHRule,
    PromptBoxBody,
}

#[derive(Debug, Default)]
struct Matcher {
    /// 已小写化；对区域文本做大小写不敏感子串匹配。
    contains: Vec<String>,
    regex: Vec<Regex>,
    line_regex: Vec<Regex>,
    any: Vec<Matcher>,
    all: Vec<Matcher>,
    not: Vec<Matcher>,
}

fn parse_region(s: &str) -> Option<Region> {
    match s {
        "whole_recent" | "whole" => Some(Region::Whole),
        "osc_title" => Some(Region::OscTitle),
        "after_last_horizontal_rule" => Some(Region::AfterLastHRule),
        "prompt_box_body" => Some(Region::PromptBoxBody),
        _ => {
            let n = s.strip_prefix("bottom_non_empty_lines(")?.strip_suffix(")")?;
            n.parse().ok().map(Region::BottomNonEmpty)
        }
    }
}

fn parse_state(s: &str) -> Option<Option<AgentState>> {
    match s {
        "working" => Some(Some(AgentState::Running)),
        "blocked" => Some(Some(AgentState::Waiting)),
        "idle" => Some(Some(AgentState::Idle)),
        "unknown" => Some(None),
        _ => None,
    }
}

fn compile_matcher(doc: MatcherDoc, rule_id: &str) -> Option<Matcher> {
    let compile_regexes = |patterns: Vec<String>| -> Option<Vec<Regex>> {
        patterns
            .into_iter()
            .map(|p| {
                Regex::new(&p)
                    .map_err(|e| warn!("agent_detect: bad regex in rule {}: {}", rule_id, e))
                    .ok()
            })
            .collect()
    };
    Some(Matcher {
        contains: doc.contains.into_iter().map(|s| s.to_lowercase()).collect(),
        regex: compile_regexes(doc.regex)?,
        line_regex: compile_regexes(doc.line_regex)?,
        any: doc.any.into_iter().map(|m| compile_matcher(m, rule_id)).collect::<Option<_>>()?,
        all: doc.all.into_iter().map(|m| compile_matcher(m, rule_id)).collect::<Option<_>>()?,
        not: doc.not.into_iter().map(|m| compile_matcher(m, rule_id)).collect::<Option<_>>()?,
    })
}

fn compile_manifest(src: &str, name: &str) -> Vec<Rule> {
    let doc: ManifestDoc = match toml::from_str(src) {
        Ok(d) => d,
        Err(e) => {
            warn!("agent_detect: failed to parse manifest {}: {}", name, e);
            return vec![];
        }
    };
    let mut rules: Vec<Rule> = doc
        .rules
        .into_iter()
        .filter_map(|r| {
            let outcome = match parse_state(&r.state) {
                Some(o) if !r.skip_state_update => o,
                Some(_) => None,
                None => {
                    warn!("agent_detect: unknown state '{}' in rule {}", r.state, r.id);
                    return None;
                }
            };
            let region = match parse_region(&r.region) {
                Some(reg) => reg,
                None => {
                    warn!("agent_detect: unknown region '{}' in rule {}", r.region, r.id);
                    return None;
                }
            };
            let matcher = compile_matcher(r.matcher, &r.id)?;
            Some(Rule {
                id: r.id,
                outcome,
                priority: r.priority,
                region,
                visible_idle: r.visible_idle,
                matcher,
            })
        })
        .collect();
    rules.sort_by_key(|r| std::cmp::Reverse(r.priority));
    rules
}

fn manifests() -> &'static HashMap<AgentKind, Vec<Rule>> {
    static MANIFESTS: OnceLock<HashMap<AgentKind, Vec<Rule>>> = OnceLock::new();
    MANIFESTS.get_or_init(|| {
        HashMap::from([
            (AgentKind::Claude, compile_manifest(CLAUDE_MANIFEST, "claude")),
            (AgentKind::Codex, compile_manifest(CODEX_MANIFEST, "codex")),
            (AgentKind::Qoder, compile_manifest(QODER_MANIFEST, "qoder")),
        ])
    })
}

// ---------- 屏幕文本 → 区域视图 ----------

struct RegionView {
    text: String,
    lower: String,
    lines: Vec<String>,
}

impl RegionView {
    fn from_lines(lines: Vec<String>) -> Self {
        let text = lines.join("\n");
        let lower = text.to_lowercase();
        Self { text, lower, lines }
    }
}

/// 剥离行两侧的 TUI 竖边框字符（Claude 权限框等把正文包在 `│ … │` 内）。
fn strip_box_border(line: &str) -> String {
    let trimmed = line.trim_end();
    let stripped =
        trimmed.trim_start_matches([' ', '\t']).strip_prefix(['│', '┃', '║']).unwrap_or(trimmed);
    let stripped = stripped.strip_suffix(['│', '┃', '║']).unwrap_or(stripped);
    stripped.trim_end().to_string()
}

fn is_horizontal_rule(line: &str) -> bool {
    let t = line.trim();
    t.len() >= 8 && t.chars().all(|c| matches!(c, '─' | '━' | '═' | '╌')) && t.chars().count() >= 8
}

fn extract_region(region: Region, screen: &str, title: &str) -> Option<RegionView> {
    match region {
        Region::OscTitle => Some(RegionView::from_lines(vec![title.to_string()])),
        Region::Whole => {
            Some(RegionView::from_lines(screen.lines().map(strip_box_border).collect()))
        }
        Region::BottomNonEmpty(n) => {
            let mut lines: Vec<String> =
                screen.lines().map(strip_box_border).filter(|l| !l.trim().is_empty()).collect();
            let start = lines.len().saturating_sub(n);
            lines.drain(..start);
            Some(RegionView::from_lines(lines))
        }
        Region::AfterLastHRule => {
            let raw: Vec<&str> = screen.lines().collect();
            let idx = raw.iter().rposition(|l| is_horizontal_rule(l));
            let lines: Vec<String> = match idx {
                Some(i) => raw[i + 1..].iter().map(|l| strip_box_border(l)).collect(),
                None => raw.iter().map(|l| strip_box_border(l)).collect(),
            };
            Some(RegionView::from_lines(lines))
        }
        Region::PromptBoxBody => {
            let raw: Vec<&str> = screen.lines().collect();
            let top = raw.iter().rposition(|l| l.trim_start().starts_with('╭'))?;
            let bottom = raw[top..].iter().position(|l| l.trim_start().starts_with('╰'))?;
            let body: Vec<String> =
                raw[top + 1..top + bottom].iter().map(|l| strip_box_border(l)).collect();
            if body.is_empty() { None } else { Some(RegionView::from_lines(body)) }
        }
    }
}

fn matcher_matches(m: &Matcher, view: &RegionView) -> bool {
    m.contains.iter().all(|needle| view.lower.contains(needle))
        && m.regex.iter().all(|r| r.is_match(&view.text))
        && m.line_regex.iter().all(|r| view.lines.iter().any(|l| r.is_match(l)))
        && (m.any.is_empty() || m.any.iter().any(|s| matcher_matches(s, view)))
        && m.all.iter().all(|s| matcher_matches(s, view))
        && m.not.iter().all(|s| !matcher_matches(s, view))
}

// ---------- 对外接口 ----------

/// 单次屏幕扫描结果。
#[derive(Debug, Clone)]
pub struct Detection {
    /// `None` 表示命中 skip 规则（transcript 查看器等）：保持上一状态。
    pub state: Option<AgentState>,
    /// 命中的规则 id（调试/日志用；无命中为 `idle_fallback`）。
    pub rule_id: String,
    /// 屏上存在可见 idle 强证据（❯ 提示框等）——防抖可立即放行 idle。
    pub visible_idle: bool,
}

/// 对一个 agent 的可见屏文本 + pane 标题跑规则，返回检测结果。
pub fn evaluate(kind: AgentKind, screen: &str, title: &str) -> Detection {
    let rules = match manifests().get(&kind) {
        Some(r) => r,
        None => {
            return Detection {
                state: Some(AgentState::Idle),
                rule_id: "no_manifest".into(),
                visible_idle: false,
            };
        }
    };
    for rule in rules {
        let Some(view) = extract_region(rule.region, screen, title) else { continue };
        if matcher_matches(&rule.matcher, &view) {
            return Detection {
                state: rule.outcome,
                rule_id: rule.id.clone(),
                visible_idle: rule.visible_idle,
            };
        }
    }
    // 保守回退：已识别 agent 无规则命中 → idle（宁漏报 blocked 不误报）
    Detection {
        state: Some(AgentState::Idle),
        rule_id: "idle_fallback".into(),
        visible_idle: false,
    }
}

/// 发布防抖状态机：吸收 agent 渲染间隙产生的假 idle。
#[derive(Debug, Clone)]
pub struct Debounce {
    published: AgentState,
    idle_streak: u8,
}

impl Default for Debounce {
    fn default() -> Self {
        Self { published: AgentState::Idle, idle_streak: 0 }
    }
}

impl Debounce {
    pub fn published(&self) -> AgentState {
        self.published
    }

    /// 送入一次扫描结果，返回本 tick 应发布的状态。
    pub fn advance(&mut self, detection: &Detection) -> AgentState {
        match detection.state {
            None => {} // skip 规则：保持
            Some(AgentState::Running) => {
                self.published = AgentState::Running;
                self.idle_streak = 0;
            }
            Some(AgentState::Waiting) => {
                self.published = AgentState::Waiting;
                self.idle_streak = 0;
            }
            Some(AgentState::Idle) => {
                if self.published == AgentState::Idle || detection.visible_idle {
                    self.published = AgentState::Idle;
                    self.idle_streak = 0;
                } else {
                    self.idle_streak += 1;
                    if self.idle_streak >= IDLE_CONFIRM_TICKS {
                        self.published = AgentState::Idle;
                        self.idle_streak = 0;
                    }
                }
            }
        }
        self.published
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_manifests_compile_with_all_rules() {
        // 任一规则解析/编译失败都会被 filter 掉——数量断言防止无声丢规则
        let m = manifests();
        assert_eq!(m[&AgentKind::Claude].len(), 10);
        assert_eq!(m[&AgentKind::Codex].len(), 6);
        assert_eq!(m[&AgentKind::Qoder].len(), 3);
    }

    // ---- Claude fixtures ----

    const CLAUDE_PERMISSION_PROMPT: &str = "\
● Bash(rm -rf build)

╭─────────────────────────────────────────────╮
│ Bash command                                │
│                                             │
│   rm -rf build                              │
│   Remove the build directory                │
│                                             │
│ Do you want to proceed?                     │
│ ❯ 1. Yes                                    │
│   2. No, and tell Claude what to do         │
│                                             │
╰─────────────────────────────────────────────╯";

    const CLAUDE_IDLE_PROMPT: &str = "\
● Done! The build passes.

╭─────────────────────────────────────────────╮
│ ❯                                           │
╰─────────────────────────────────────────────╯
  ? for shortcuts";

    const CLAUDE_WORKING: &str = "\
● Reading src/main.rs…

✻ Cerebrating… (esc to interrupt · 42s · ↓ 1.2k tokens)";

    const CLAUDE_SELECT_FORM: &str = "\
 Some earlier output
──────────────────────────────
 Select an option:
 ❯ 1. Option A
   2. Option B
 tab/arrow keys to navigate · enter to select · esc to cancel";

    #[test]
    fn claude_permission_prompt_is_waiting() {
        let d = evaluate(AgentKind::Claude, CLAUDE_PERMISSION_PROMPT, "");
        assert_eq!(d.state, Some(AgentState::Waiting));
        assert_eq!(d.rule_id, "bash_permission_prompt");
    }

    #[test]
    fn claude_idle_prompt_box_is_visible_idle() {
        let d = evaluate(AgentKind::Claude, CLAUDE_IDLE_PROMPT, "");
        assert_eq!(d.state, Some(AgentState::Idle));
        assert_eq!(d.rule_id, "live_prompt_box");
        assert!(d.visible_idle);
    }

    #[test]
    fn claude_working_footer_is_running() {
        let d = evaluate(AgentKind::Claude, CLAUDE_WORKING, "");
        assert_eq!(d.state, Some(AgentState::Running));
    }

    #[test]
    fn claude_spinner_title_is_running() {
        let d = evaluate(AgentKind::Claude, "any screen text", "⠹ agent is thinking");
        assert_eq!(d.state, Some(AgentState::Running));
        assert_eq!(d.rule_id, "osc_title_working");
    }

    #[test]
    fn claude_select_form_is_waiting() {
        let d = evaluate(AgentKind::Claude, CLAUDE_SELECT_FORM, "");
        assert_eq!(d.state, Some(AgentState::Waiting));
        assert_eq!(d.rule_id, "live_blocked_form");
    }

    #[test]
    fn claude_plain_shell_output_falls_back_idle() {
        let d = evaluate(AgentKind::Claude, "$ ls\nCargo.toml src\n$", "bash");
        assert_eq!(d.state, Some(AgentState::Idle));
        assert_eq!(d.rule_id, "idle_fallback");
        assert!(!d.visible_idle);
    }

    // ---- Codex fixtures ----

    #[test]
    fn codex_working_footer_is_running() {
        let screen = "\
› fix the tests

• Working (2m 10s • esc to interrupt)";
        let d = evaluate(AgentKind::Codex, screen, "");
        assert_eq!(d.state, Some(AgentState::Running));
        assert_eq!(d.rule_id, "screen_working_fallback");
    }

    #[test]
    fn codex_confirm_prompt_is_waiting() {
        let screen = "Allow command?\n  yes (y)\n  no (n)\npress enter to confirm or esc to cancel";
        let d = evaluate(AgentKind::Codex, screen, "");
        assert_eq!(d.state, Some(AgentState::Waiting));
    }

    #[test]
    fn codex_action_required_title_is_waiting() {
        let d = evaluate(AgentKind::Codex, "", "Codex — Action Required");
        assert_eq!(d.state, Some(AgentState::Waiting));
    }

    // ---- Qoder fixtures ----

    #[test]
    fn qoder_spinner_is_running() {
        let d = evaluate(AgentKind::Qoder, "  ⠧ Generating response...", "");
        assert_eq!(d.state, Some(AgentState::Running));
    }

    #[test]
    fn qoder_confirmation_is_waiting() {
        let d = evaluate(AgentKind::Qoder, "Waiting for user confirmation\n> Yes\n  No", "");
        assert_eq!(d.state, Some(AgentState::Waiting));
    }

    // ---- skip 规则 ----

    #[test]
    fn claude_transcript_viewer_keeps_previous_state() {
        let d = evaluate(AgentKind::Claude, "Showing detailed transcript\n more text", "");
        assert_eq!(d.state, None);
    }

    // ---- Debounce ----

    fn det(state: Option<AgentState>, visible_idle: bool) -> Detection {
        Detection { state, rule_id: "test".into(), visible_idle }
    }

    #[test]
    fn debounce_running_publishes_immediately() {
        let mut d = Debounce::default();
        assert_eq!(d.advance(&det(Some(AgentState::Running), false)), AgentState::Running);
    }

    #[test]
    fn debounce_waiting_publishes_immediately() {
        let mut d = Debounce::default();
        d.advance(&det(Some(AgentState::Running), false));
        assert_eq!(d.advance(&det(Some(AgentState::Waiting), false)), AgentState::Waiting);
    }

    #[test]
    fn debounce_idle_needs_confirmation_after_running() {
        let mut d = Debounce::default();
        d.advance(&det(Some(AgentState::Running), false));
        // 第一次 idle：保持 running（渲染间隙假 idle）
        assert_eq!(d.advance(&det(Some(AgentState::Idle), false)), AgentState::Running);
        // 第二次连续 idle：发布
        assert_eq!(d.advance(&det(Some(AgentState::Idle), false)), AgentState::Idle);
    }

    #[test]
    fn debounce_idle_confirmation_resets_on_running() {
        let mut d = Debounce::default();
        d.advance(&det(Some(AgentState::Running), false));
        d.advance(&det(Some(AgentState::Idle), false));
        d.advance(&det(Some(AgentState::Running), false));
        assert_eq!(d.advance(&det(Some(AgentState::Idle), false)), AgentState::Running);
    }

    #[test]
    fn debounce_visible_idle_publishes_immediately() {
        let mut d = Debounce::default();
        d.advance(&det(Some(AgentState::Running), false));
        assert_eq!(d.advance(&det(Some(AgentState::Idle), true)), AgentState::Idle);
    }

    #[test]
    fn debounce_skip_keeps_previous() {
        let mut d = Debounce::default();
        d.advance(&det(Some(AgentState::Waiting), false));
        assert_eq!(d.advance(&det(None, false)), AgentState::Waiting);
    }
}
