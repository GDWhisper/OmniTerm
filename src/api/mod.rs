pub mod agents;
pub mod auth;
pub mod files;
pub mod files_watch;
pub mod git;
pub mod health;
pub mod hooks;
pub mod projects;
pub mod sessions;
pub mod system;
pub mod targets;

use crate::AppState;
use crate::ws;
use axum::{Router, middleware};

pub fn routes(state: AppState) -> Router {
    let public = Router::new().merge(health::routes()).merge(auth::routes());

    let protected = Router::new()
        .merge(auth::protected_routes())
        .merge(system::routes())
        .merge(targets::routes())
        .merge(projects::routes())
        .merge(sessions::routes())
        .merge(hooks::routes())
        .merge(files::routes())
        .merge(files_watch::routes())
        .merge(git::routes())
        .merge(agents::routes())
        .route("/ws/terminal/{session_id}", axum::routing::get(ws::ws_terminal_handler))
        .route(
            "/ws/terminal/external/{tmux_name}",
            axum::routing::get(ws::ws_external_terminal_handler),
        )
        .route("/ws/acp/{session_id}", axum::routing::get(ws::ws_acp_handler))
        .route_layer(middleware::from_fn_with_state(state.clone(), crate::auth::require_auth_mw));

    Router::new().nest("/api/v1", public.merge(protected)).with_state(state)
}
