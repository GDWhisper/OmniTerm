//! ACP 客户端侧的异步后台任务跟踪。
//!
//! 背景：Claude / CodeBuddy 适配器把 Workflow、后台 Bash 等任务以
//! `async_task_spawned` / `async_task_progress` / `async_task_state_update`
//! 三种 session update 广播出来（JetBrains AIR 扩展；客户端必须在 initialize 的
//! `_meta.jetbrains.air.capabilities` 里显式声明 `asyncTasks` 才会收到）。
//!
//! 核心 ACP 没有“后台任务仍在运行”的语义：一个 turn 以 `end_turn` 结束后，
//! 宿主只看到 `active_prompt = false`。若后台任务仍在跑，reaper 会按空闲阈值
//! 杀掉 agent 进程，连带杀掉任务（2026-10-19 正式库 Workflow 事故）。
//!
//! 本模块只负责：解析扩展帧 → 有界注册表 → 开始/结束事件。是否回收由
//! `AcpClient::is_idle_stale` 读取 [`AsyncTaskRegistry::has_active`] 决定；
//! 事件由 client 侧落库并广播 system 消息。

use std::collections::{HashMap, VecDeque};

use serde::Deserialize;

/// 同时跟踪的活跃后台任务上限（§P1）。真实会话远小于此；超限时淘汰最久未
/// 更新的任务并记 WARN——淘汰旧任务仍比“注册表满了就不再保护新任务”安全。
pub const MAX_TRACKED_ASYNC_TASKS: usize = 256;

/// 任务名/类型/摘要进入系统消息的字符上限：扩展载荷由 agent 决定，不能无界
/// 写进 DB 行（§P1 的字节维度）。
pub const MAX_ASYNC_TASK_TEXT_CHARS: usize = 200;

/// 后台任务开始/结束的系统消息 i18n key（与前端 translation.json 对齐）。
pub const SYSTEM_LABEL_ASYNC_TASK_STARTED: &str = "system.asyncTask.started";
pub const SYSTEM_LABEL_ASYNC_TASK_FINISHED: &str = "system.asyncTask.finished";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AsyncTaskState {
    Running,
    Paused,
    Completed,
    Failed,
    Stopped,
}

impl AsyncTaskState {
    pub fn is_active(self) -> bool {
        matches!(self, Self::Running | Self::Paused)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    fn from_wire(value: &str) -> Option<Self> {
        match value {
            "pending" | "running" => Some(Self::Running),
            "paused" => Some(Self::Paused),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "killed" | "cancelled" | "stopped" => Some(Self::Stopped),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsyncTask {
    pub id: String,
    pub name: String,
    pub task_type: String,
    pub state: AsyncTaskState,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AsyncTaskEvent {
    Started(AsyncTask),
    Finished(AsyncTask),
}

/// 适配器扩展帧（`sessionUpdate` 判别）。未知字段一律忽略：扩展会演进，
/// 客户端只消费自己需要的字段。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "sessionUpdate")]
pub enum AsyncTaskUpdate {
    #[serde(rename = "async_task_spawned")]
    Spawned(AsyncTaskSpawned),
    #[serde(rename = "async_task_progress")]
    Progress(AsyncTaskProgress),
    #[serde(rename = "async_task_state_update")]
    StateUpdate(AsyncTaskStateUpdate),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTaskSpawned {
    pub async_task_id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub task_type: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTaskProgress {
    pub async_task_id: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsyncTaskStateUpdate {
    pub async_task_id: String,
    pub state: String,
    #[serde(default)]
    pub summary: Option<String>,
}

/// 活跃后台任务注册表。只保存 active（running/paused）任务；terminal 帧到达即
/// 移除并产出结束事件，因此表大小由“同时运行的任务数”而非历史任务数决定。
#[derive(Debug, Default)]
pub struct AsyncTaskRegistry {
    tasks: HashMap<String, AsyncTask>,
    /// 插入/更新顺序，用于超限时淘汰最久未更新者。
    order: VecDeque<String>,
}

impl AsyncTaskRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn has_active(&self) -> bool {
        !self.tasks.is_empty()
    }

    pub fn active_count(&self) -> usize {
        self.tasks.len()
    }

    /// 消费一条扩展帧。返回 `Some` 仅当任务从“未跟踪”进入 active（Started）或
    /// 从 active 进入 terminal（Finished）；普通 progress 返回 None。
    pub fn apply(&mut self, update: AsyncTaskUpdate) -> Option<AsyncTaskEvent> {
        match update {
            AsyncTaskUpdate::Spawned(spawned) => self.on_spawned(spawned),
            AsyncTaskUpdate::Progress(progress) => self.on_progress(progress),
            AsyncTaskUpdate::StateUpdate(state) => self.on_state(state),
        }
    }

    fn on_spawned(&mut self, spawned: AsyncTaskSpawned) -> Option<AsyncTaskEvent> {
        let id = spawned.async_task_id.trim().to_string();
        if id.is_empty() {
            return None;
        }
        let existing = self.tasks.contains_key(&id);
        let name = cap_text(
            spawned
                .name
                .as_deref()
                .or(spawned.description.as_deref())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Background task"),
        );
        let task_type = cap_text(
            spawned.task_type.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("task"),
        );
        let task = AsyncTask {
            id: id.clone(),
            name,
            task_type,
            state: AsyncTaskState::Running,
            summary: self.tasks.get(&id).and_then(|t| t.summary.clone()),
        };
        self.insert(task.clone());
        (!existing).then_some(AsyncTaskEvent::Started(task))
    }

    fn on_progress(&mut self, progress: AsyncTaskProgress) -> Option<AsyncTaskEvent> {
        let id = progress.async_task_id.trim().to_string();
        if id.is_empty() {
            return None;
        }
        if let Some(task) = self.tasks.get_mut(&id) {
            if let Some(summary) = progress.summary.filter(|s| !s.trim().is_empty()) {
                task.summary = Some(cap_text(&summary));
            }
            if let Some(description) = progress.description.filter(|s| !s.trim().is_empty())
                && task.name == "Background task"
            {
                task.name = cap_text(&description);
            }
            self.touch(&id);
            return None;
        }
        // spawned 丢失（例如客户端晚连）时的兜底：先建占位，保证 reaper 仍能
        // 看到任务存在；后续 spawned 会补全名称/类型但不重复发 Started。
        let name = cap_text(
            progress
                .description
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Background task"),
        );
        let task = AsyncTask {
            id: id.clone(),
            name,
            task_type: "task".into(),
            state: AsyncTaskState::Running,
            summary: progress.summary.map(|s| cap_text(&s)),
        };
        self.insert(task.clone());
        Some(AsyncTaskEvent::Started(task))
    }

    fn on_state(&mut self, state: AsyncTaskStateUpdate) -> Option<AsyncTaskEvent> {
        let id = state.async_task_id.trim().to_string();
        if id.is_empty() {
            return None;
        }
        let Some(parsed) = AsyncTaskState::from_wire(&state.state) else {
            // 未知状态：不把它当成 terminal（宁可继续保护），也不新造任务。
            return None;
        };
        if parsed.is_active() {
            if let Some(task) = self.tasks.get_mut(&id) {
                task.state = parsed;
                if let Some(summary) = state.summary.filter(|s| !s.trim().is_empty()) {
                    task.summary = Some(cap_text(&summary));
                }
                self.touch(&id);
                return None;
            }
            let task = AsyncTask {
                id: id.clone(),
                name: "Background task".into(),
                task_type: "task".into(),
                state: parsed,
                summary: state.summary.map(|s| cap_text(&s)),
            };
            self.insert(task.clone());
            return Some(AsyncTaskEvent::Started(task));
        }
        // terminal：只有跟踪中的任务才产出结束事件；未知 id 的 terminal 帧忽略
        // （通常是注册表淘汰或重复终态，不能凭它清掉别的任务）。
        let mut task = self.tasks.remove(&id)?;
        self.order.retain(|x| x != &id);
        task.state = parsed;
        if let Some(summary) = state.summary.filter(|s| !s.trim().is_empty()) {
            task.summary = Some(cap_text(&summary));
        }
        Some(AsyncTaskEvent::Finished(task))
    }

    fn insert(&mut self, task: AsyncTask) {
        if !self.tasks.contains_key(&task.id)
            && self.tasks.len() >= MAX_TRACKED_ASYNC_TASKS
            && let Some(oldest) = self.order.pop_front()
        {
            self.tasks.remove(&oldest);
            tracing::warn!(
                evicted = %oldest,
                limit = MAX_TRACKED_ASYNC_TASKS,
                "async task registry full; evicted oldest task"
            );
        }
        let id = task.id.clone();
        self.tasks.insert(id.clone(), task);
        self.touch(&id);
    }

    fn touch(&mut self, id: &str) {
        self.order.retain(|x| x != id);
        self.order.push_back(id.to_string());
    }
}

fn cap_text(value: &str) -> String {
    let trimmed = value.trim();
    let mut out = String::new();
    for (index, ch) in trimmed.chars().enumerate() {
        if index >= MAX_ASYNC_TASK_TEXT_CHARS {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    if out.is_empty() { "Background task".into() } else { out }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawned(id: &str) -> AsyncTaskUpdate {
        AsyncTaskUpdate::Spawned(AsyncTaskSpawned {
            async_task_id: id.into(),
            name: Some("wf".into()),
            task_type: Some("workflow".into()),
            description: Some("design→implement".into()),
        })
    }

    fn state(id: &str, state: &str) -> AsyncTaskUpdate {
        AsyncTaskUpdate::StateUpdate(AsyncTaskStateUpdate {
            async_task_id: id.into(),
            state: state.into(),
            summary: Some("done".into()),
        })
    }

    #[test]
    fn spawn_and_terminal_track_active_set() {
        let mut reg = AsyncTaskRegistry::new();
        let event = reg.apply(spawned("t1")).expect("spawn should emit started");
        assert!(matches!(event, AsyncTaskEvent::Started(_)));
        assert!(reg.has_active());
        assert_eq!(reg.active_count(), 1);

        assert!(reg.apply(state("t1", "running")).is_none());
        let event = reg.apply(state("t1", "completed")).expect("terminal should emit finished");
        match event {
            AsyncTaskEvent::Finished(task) => {
                assert_eq!(task.state, AsyncTaskState::Completed);
                assert_eq!(task.name, "wf");
                assert_eq!(task.task_type, "workflow");
            }
            _ => panic!("expected finished"),
        }
        assert!(!reg.has_active());
    }

    #[test]
    fn progress_without_spawn_creates_placeholder() {
        let mut reg = AsyncTaskRegistry::new();
        let update = AsyncTaskUpdate::Progress(AsyncTaskProgress {
            async_task_id: "t2".into(),
            description: Some("long job".into()),
            summary: Some("step 1".into()),
        });
        let event = reg.apply(update).expect("progress should protect the task");
        match event {
            AsyncTaskEvent::Started(task) => {
                assert_eq!(task.id, "t2");
                assert_eq!(task.name, "long job");
                assert_eq!(task.summary.as_deref(), Some("step 1"));
            }
            _ => panic!("expected started placeholder"),
        }
        assert!(reg.has_active());
    }

    #[test]
    fn unknown_terminal_state_is_ignored() {
        let mut reg = AsyncTaskRegistry::new();
        reg.apply(spawned("t3"));
        assert!(reg.apply(state("t3", "quantum")).is_none());
        assert!(reg.has_active(), "unknown state must not clear an active task");
    }

    #[test]
    fn registry_is_bounded_and_evicts_oldest() {
        let mut reg = AsyncTaskRegistry::new();
        for i in 0..MAX_TRACKED_ASYNC_TASKS {
            reg.apply(spawned(&format!("t{i}")));
        }
        assert_eq!(reg.active_count(), MAX_TRACKED_ASYNC_TASKS);
        reg.apply(spawned("overflow"));
        assert_eq!(reg.active_count(), MAX_TRACKED_ASYNC_TASKS);
        assert!(!reg.tasks.contains_key("t0"), "oldest should be evicted");
        assert!(reg.tasks.contains_key("overflow"));
    }

    #[test]
    fn long_text_is_capped_at_char_boundary() {
        let text = "汉".repeat(MAX_ASYNC_TASK_TEXT_CHARS + 10);
        let capped = cap_text(&text);
        assert_eq!(capped.chars().count(), MAX_ASYNC_TASK_TEXT_CHARS + 1);
        assert!(capped.ends_with('…'));
    }
}
