use axum::{routing::get, Json, Router};
use serde_json::{json, Value};

use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/system/info", get(system_info))
}

async fn system_info() -> Json<Value> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".into());

    Json(json!({
        "home_dir": home,
    }))
}
