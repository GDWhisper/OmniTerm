pub mod auth;
pub mod files;
pub mod health;
pub mod hooks;
pub mod sessions;
pub mod system;
pub mod targets;
pub mod workspaces;

use axum::Router;
use crate::AppState;
use crate::ws;

pub fn routes(state: AppState) -> Router {
    let api = Router::new()
        .merge(health::routes())
        .merge(auth::routes())
        .merge(system::routes())
        .merge(targets::routes())
        .merge(workspaces::routes())
        .merge(sessions::routes())
        .merge(hooks::routes())
        .merge(files::routes())
        .route("/ws/terminal/{session_id}", axum::routing::get(ws::ws_terminal_handler));

    Router::new()
        .nest("/api/v1", api)
        .with_state(state)
}
