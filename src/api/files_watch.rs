use axum::{
    extract::{Query, State},
    response::{sse::{Event, KeepAlive, Sse}, IntoResponse},
    routing::get,
    Router,
};
use futures_util::stream::{self, Stream};
use notify::{Event as NotifyEvent, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Deserialize;
use std::convert::Infallible;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::Duration;
use tokio::sync::broadcast;

use crate::AppState;

use super::files::{resolve_session_base, resolve_project_root};

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
        resolve_session_base(&state, sid)
            .await
            .map(|(cwd, _)| PathBuf::from(cwd))
    } else {
        let wid = q.workspace.as_deref().unwrap_or("default");
        resolve_project_root(&state, wid)
            .await
            .map(PathBuf::from)
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

    let watch_dir = watch_path.clone();
    let watch_dir_for_cb = watch_dir.clone();
    tokio::task::spawn_blocking(move || {
        let mut watcher = match RecommendedWatcher::new(
            move |res: Result<NotifyEvent, notify::Error>| {
                let event = match res {
                    Ok(e) => e,
                    Err(_) => return,
                };
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

        if watcher.watch(&watch_dir, RecursiveMode::Recursive).is_err() {
            return;
        }

        // Park until the SSE stream drops `shutdown_tx` (client disconnect).
        // `recv_timeout` returns `Disconnected` when the sender is dropped —
        // a pure sync mechanism that works reliably from any thread.
        loop {
            match shutdown_rx.recv_timeout(Duration::from_millis(250)) {
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                _ => {} // Timeout or Ok — keep waiting
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

    let boxed: Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> =
        Box::pin(sse_stream);

    Sse::new(boxed).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}

/// Convert a notify event into one or more JSON change messages.
fn notify_event_to_changes(event: &NotifyEvent, base_dir: &std::path::Path) -> Vec<String> {
    let mut changes = Vec::new();

    for path in &event.paths {
        // Compute relative path from the watched directory
        let rel_path = path
            .strip_prefix(base_dir)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

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

        let json = format!(
            r#"{{"kind":"{}","path":"{}"}}"#,
            kind_str,
            escape_json(&rel_path)
        );
        changes.push(json);
    }

    // Handle renames specially
    if let EventKind::Modify(notify::event::ModifyKind::Name(_)) = event.kind {
        if event.paths.len() == 2 {
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

/// Escape a string for JSON embedding.
fn escape_json(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}
