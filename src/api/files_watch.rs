use axum::{
    Router,
    extract::{Query, State},
    response::{
        IntoResponse,
        sse::{Event, KeepAlive, Sse},
    },
    routing::get,
};
use futures_util::stream::{self, Stream};
use notify::event::CreateKind;
use notify::{Event as NotifyEvent, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::Duration;
use tokio::sync::broadcast;
use walkdir::WalkDir;

use crate::AppState;

use super::files::{resolve_project_root, resolve_session_base};

pub fn routes() -> Router<AppState> {
    Router::new().route("/files/watch", get(watch_files))
}

#[derive(Deserialize)]
struct WatchQuery {
    session: Option<String>,
    workspace: Option<String>,
}

/// SSE endpoint for real-time file change notifications.
/// Watches the specified directory and pushes change events to the client.
async fn watch_files(
    State(state): State<AppState>,
    Query(q): Query<WatchQuery>,
) -> impl IntoResponse {
    // Resolve the directory to watch
    let watch_path = if let Some(sid) = q.session.as_deref() {
        resolve_session_base(&state, sid).await.map(|(cwd, _)| PathBuf::from(cwd))
    } else {
        let wid = q.workspace.as_deref().unwrap_or("default");
        resolve_project_root(&state, wid).await.map(PathBuf::from)
    };

    let watch_path = match watch_path {
        Some(p) if p.exists() => p,
        _ => {
            // Return an empty stream if path can't be resolved
            let empty: Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> =
                Box::pin(stream::empty());
            return Sse::new(empty).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)));
        }
    };

    let (tx, mut rx) = broadcast::channel::<String>(64);

    // Shutdown channel: uses std::sync::mpsc (not tokio::sync::watch) so the
    // blocking thread can detect sender-drop without depending on a tokio
    // runtime context.  `now_or_never()` inside `spawn_blocking` was unreliable
    // and leaked inotify instances (each watcher = 1 inotify fd, system limit
    // is 128; leaked watchers consumed ~50% → new Vite could not start).
    let (shutdown_tx, shutdown_rx) = std::sync::mpsc::channel::<()>();
    // 新目录注册通道：回调里不能碰 watcher（构造在回调外），Create(Folder) 事件
    // 把新目录路径投给消费循环，由它在同一阻塞线程内补注册（见下）。
    let (new_dir_tx, new_dir_rx) = std::sync::mpsc::channel::<PathBuf>();

    let watch_dir = watch_path.clone();
    let watch_dir_for_cb = watch_dir.clone();
    tokio::task::spawn_blocking(move || {
        let mut watcher = match RecommendedWatcher::new(
            move |res: Result<NotifyEvent, notify::Error>| {
                let event = match res {
                    Ok(e) => e,
                    Err(_) => return,
                };
                // 新目录 → 投给消费循环补注册 inotify watch（跳过 ignore 目录）。
                // 必须手动处理：`RecursiveMode::Recursive` 会让 notify 内部 WalkDir
                // 把 node_modules/.git/target 等全注册（1 万+ watch，见 collect_watch_dirs
                // 注释），且 notify 8.2 在该规模 + 持续事件下 `handle_inotify` 内层循环
                // 饿死 mio poll——notify-rx 线程 100% CPU、RSS 堆膨胀（2026-08-16 根因）。
                if let EventKind::Create(CreateKind::Folder) = event.kind {
                    for path in &event.paths {
                        if !is_ignored_dir(path, &watch_dir_for_cb) {
                            let _ = new_dir_tx.send(path.clone());
                        }
                    }
                }
                let changes = notify_event_to_changes(&event, &watch_dir_for_cb);
                for change in changes {
                    let _ = tx.send(change);
                }
            },
            notify::Config::default(),
        ) {
            Ok(w) => w,
            Err(_) => return,
        };

        // 根目录 + 全部非 ignore 子目录逐个注册（NonRecursive）。相比
        // `RecursiveMode::Recursive`（notify 内部 WalkDir 不跳过 ignore 目录，
        // 项目含 node_modules 时 watch 数可达上万），此处把 watch 数压到
        // 实际业务目录量级，从源头隔离 node_modules 等高频目录的事件风暴。
        if watcher.watch(&watch_dir, RecursiveMode::NonRecursive).is_err() {
            return;
        }
        for dir in collect_watch_dirs(&watch_dir) {
            if watcher.watch(&dir, RecursiveMode::NonRecursive).is_err() {
                break;
            }
        }

        // Park until the SSE stream drops `shutdown_tx` (client disconnect).
        // `recv_timeout` returns `Disconnected` when the sender is dropped —
        // a pure sync mechanism that works reliably from any thread.
        // 同时消费 `new_dir_rx`：新目录（含 Create 时已存在的深层子目录）补注册。
        loop {
            while let Ok(dir) = new_dir_rx.try_recv() {
                if watcher.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
                    for sub in collect_watch_dirs(&dir) {
                        if watcher.watch(&sub, RecursiveMode::NonRecursive).is_err() {
                            break;
                        }
                    }
                }
            }
            if let Err(std::sync::mpsc::RecvTimeoutError::Disconnected) =
                shutdown_rx.recv_timeout(Duration::from_millis(250))
            {
                break;
                // Timeout 或 Ok：继续等待
            }
        }
        // `watcher` drops here → `inotify_rm_watch` for every registered path.
    });

    let sse_stream = async_stream::stream! {
        // `_shutdown_guard` lives as long as the generator; dropping the SSE
        // body drops the generator, which drops the guard, which drops the
        // channel sender, which wakes the blocking task via `Disconnected`.
        let _shutdown_guard = shutdown_tx;
        loop {
            match rx.recv().await {
                Ok(data) => {
                    yield Ok(Event::default().event("change").data(data));
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    let boxed: Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> = Box::pin(sse_stream);

    Sse::new(boxed).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("ping"))
}

/// Convert a notify event into one or more JSON change messages.
fn notify_event_to_changes(event: &NotifyEvent, base_dir: &std::path::Path) -> Vec<String> {
    let mut changes = Vec::new();

    for path in &event.paths {
        // Compute relative path from the watched directory
        let rel_path = path.strip_prefix(base_dir).unwrap_or(path).to_string_lossy().to_string();

        // Skip hidden files and common non-interesting directories
        if should_ignore(&rel_path) {
            continue;
        }

        let kind_str = match event.kind {
            EventKind::Create(_) => "create",
            EventKind::Modify(_) => "modify",
            EventKind::Remove(_) => "delete",
            _ => continue, // ignore access, metadata, etc.
        };

        let json = format!(r#"{{"kind":"{}","path":"{}"}}"#, kind_str, escape_json(&rel_path));
        changes.push(json);
    }

    // Handle renames specially
    if let EventKind::Modify(notify::event::ModifyKind::Name(_)) = event.kind
        && event.paths.len() == 2
    {
        let from = event.paths[0]
            .strip_prefix(base_dir)
            .unwrap_or(&event.paths[0])
            .to_string_lossy()
            .to_string();
        let to = event.paths[1]
            .strip_prefix(base_dir)
            .unwrap_or(&event.paths[1])
            .to_string_lossy()
            .to_string();

        if !should_ignore(&from) && !should_ignore(&to) {
            changes.clear(); // remove the generic modify events
            changes.push(format!(
                r#"{{"kind":"rename","path":"{}","newPath":"{}"}}"#,
                escape_json(&from),
                escape_json(&to)
            ));
        }
    }

    changes
}

/// Check if a path should be ignored (hidden files, node_modules, .git, etc.)
fn should_ignore(rel_path: &str) -> bool {
    for component in rel_path.split('/') {
        if component.starts_with('.') && !component.is_empty() {
            return true;
        }
        if component == "node_modules" || component == "target" || component == "__pycache__" {
            return true;
        }
    }
    false
}

/// 路径相对 base 的段是否命中 ignore 规则（node_modules/.git/target/隐藏项）。
/// base 自身（相对路径为空）不忽略。
fn is_ignored_dir(path: &Path, base: &Path) -> bool {
    path.strip_prefix(base).ok().is_some_and(|rel| should_ignore(&rel.to_string_lossy()))
}

/// 递归枚举需要注册 inotify watch 的目录，**跳过 ignore 目录及整棵子树**。
///
/// 对比 notify 的 `RecursiveMode::Recursive`：其内部 `WalkDir` 不跳过任何目录，
/// 项目含 node_modules 时会注册上万 watch（2026-08-16 正式版内存泄漏根因——watch
/// 数 1 万+ 后 notify 8.2 `handle_inotify` 内层 `read_events` 循环在持续事件下饿死
/// mio poll，`notify-rx` 线程 100% CPU、高频分配致堆膨胀）。这里用 walkdir
/// `filter_entry` 剪枝，watch 数压到实际业务目录量级。纯函数，便于单测。
fn collect_watch_dirs(base: &Path) -> Vec<PathBuf> {
    WalkDir::new(base)
        .into_iter()
        .filter_entry(|e| !is_ignored_dir(e.path(), base))
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_dir())
        .map(|e| e.into_path())
        .collect()
}

/// Escape a string for JSON embedding.
fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试临时目录：Drop 时递归清理。
    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "files_watch_test_{}_{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn mkdir(p: &Path) {
        std::fs::create_dir_all(p).unwrap();
    }

    #[test]
    fn should_ignore_skips_hidden_and_build_dirs() {
        assert!(should_ignore(".git"));
        assert!(should_ignore(".git/config"));
        assert!(should_ignore("src/.hidden/x"));
        assert!(should_ignore("node_modules"));
        assert!(should_ignore("a/node_modules/b"));
        assert!(should_ignore("target"));
        assert!(should_ignore("__pycache__/x.py"));
        assert!(!should_ignore(""));
        assert!(!should_ignore("src"));
        assert!(!should_ignore("src/main.rs"));
    }

    #[test]
    fn is_ignored_dir_base_itself_is_not_ignored() {
        let base = PathBuf::from("/tmp/x");
        assert!(!is_ignored_dir(&base, &base));
        assert!(!is_ignored_dir(&base.join("src"), &base));
        assert!(is_ignored_dir(&base.join("node_modules").join("pkg"), &base));
        assert!(is_ignored_dir(&base.join(".git"), &base));
    }

    #[test]
    fn collect_watch_dirs_skips_ignore_subtrees() {
        let tmp = TempDir::new();
        let base = tmp.0.clone();
        mkdir(&base.join("src").join("components"));
        mkdir(&base.join("node_modules").join("pkg"));
        mkdir(&base.join(".git"));
        mkdir(&base.join("target").join("debug"));
        mkdir(&base.join("public"));

        let dirs: Vec<String> = collect_watch_dirs(&base)
            .iter()
            .map(|p| p.strip_prefix(&base).unwrap().to_string_lossy().into_owned())
            .collect();

        assert!(dirs.contains(&"".into()), "根目录应注册: {dirs:?}");
        assert!(dirs.contains(&"src".into()), "src 应注册: {dirs:?}");
        assert!(dirs.contains(&"src/components".into()), "src/components 应注册: {dirs:?}");
        assert!(dirs.contains(&"public".into()), "public 应注册: {dirs:?}");
        assert!(
            !dirs.iter().any(|d| d.starts_with("node_modules")),
            "不应含 node_modules: {dirs:?}"
        );
        assert!(!dirs.iter().any(|d| d.starts_with(".git")), "不应含 .git: {dirs:?}");
        assert!(!dirs.iter().any(|d| d.starts_with("target")), "不应含 target: {dirs:?}");
    }
}
