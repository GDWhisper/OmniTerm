use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::ai_commit::{self, AiCommitConfig, AiError, ApiKeyInfo, Provider};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/settings/ai-commit", get(get_config).put(set_config))
        .route("/settings/ai-commit/models", post(list_models))
}

fn config_json(cfg: &AiCommitConfig, key: &ApiKeyInfo) -> serde_json::Value {
    json!({
        "provider": cfg.provider.as_str(),
        "base_url": cfg.base_url,
        "model": cfg.model,
        "has_api_key": key.configured,
        "api_key_source": key.source,
        "api_key_env": key.env_name,
        "api_key_env_set": key.env_set,
    })
}

/// 422, not 401: `ai_auth` describes the *upstream provider* rejecting the
/// configured key. Returning 401 here would make the frontend treat it as an
/// expired OmniTerm session and bounce the user to the login page.
pub(crate) fn ai_error_response(e: AiError) -> Response {
    let status = match e.code {
        "ai_timeout" => StatusCode::GATEWAY_TIMEOUT,
        "ai_rate_limited" => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    (status, Json(json!({ "error": e.message, "code": e.code }))).into_response()
}

async fn get_config(State(state): State<AppState>) -> Json<serde_json::Value> {
    let cfg = ai_commit::load_config(&state.db).await;
    let key = ai_commit::api_key_info(&state.ai_commit_key_path);
    Json(config_json(&cfg, &key))
}

#[derive(Deserialize)]
struct SetConfigRequest {
    provider: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
    api_key: Option<String>,
    #[serde(default)]
    clear_api_key: bool,
}

async fn set_config(State(state): State<AppState>, Json(req): Json<SetConfigRequest>) -> Response {
    let Some(provider) = Provider::parse(req.provider.trim()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid provider" })))
            .into_response();
    };
    let cfg = AiCommitConfig {
        provider,
        base_url: req.base_url.trim().to_string(),
        model: req.model.trim().to_string(),
    };
    if let Err(message) = ai_commit::validate_config(&cfg) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": message, "code": "ai_invalid_config" })),
        )
            .into_response();
    }
    if let Err(e) = ai_commit::save_config(&state.db, &cfg).await {
        tracing::warn!("save ai commit config failed: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "save failed" })))
            .into_response();
    }

    if req.clear_api_key {
        if let Err(e) = ai_commit::clear_api_key(&state.ai_commit_key_path) {
            tracing::warn!("clear ai commit key failed: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "clear key failed" })),
            )
                .into_response();
        }
    } else if let Some(key) = req.api_key.as_deref().filter(|k| !k.trim().is_empty())
        && let Err(e) = ai_commit::write_api_key(&state.ai_commit_key_path, key)
    {
        tracing::warn!("write ai commit key failed: {e}");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "write key failed" })))
            .into_response();
    }

    let key = ai_commit::api_key_info(&state.ai_commit_key_path);
    (StatusCode::OK, Json(config_json(&cfg, &key))).into_response()
}

#[derive(Deserialize)]
struct ListModelsRequest {
    provider: String,
    #[serde(default)]
    base_url: String,
    api_key: Option<String>,
}

async fn list_models(
    State(state): State<AppState>,
    Json(req): Json<ListModelsRequest>,
) -> Response {
    let Some(provider) = Provider::parse(req.provider.trim()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "invalid provider" })))
            .into_response();
    };
    if provider == Provider::Off {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "provider is off" })))
            .into_response();
    }
    // Unsaved key input wins; otherwise resolve the stored value (which may
    // point at an environment variable).
    let key = match req.api_key.filter(|k| !k.trim().is_empty()) {
        Some(key) => Some(key),
        None => match ai_commit::resolve_api_key(&state.ai_commit_key_path) {
            Ok(key) => key,
            Err(e) => return ai_error_response(e),
        },
    };
    match ai_commit::list_models(provider, &req.base_url, key.as_deref()).await {
        Ok(list) => (
            StatusCode::OK,
            Json(json!({
                "models": list.models,
                "truncated": list.truncated,
            })),
        )
            .into_response(),
        Err(e) => ai_error_response(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn response_json(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 64).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn get_returns_defaults_and_no_key() {
        let state = crate::test_utils::test_state().await;
        let value = get_config(State(state)).await.0;
        assert_eq!(
            value,
            json!({
                "provider": "off",
                "base_url": "",
                "model": "",
                "has_api_key": false,
                "api_key_source": null,
                "api_key_env": null,
                "api_key_env_set": null,
            })
        );
    }

    #[tokio::test]
    async fn get_reports_environment_key_source_and_missing_state() {
        let state = crate::test_utils::test_state().await;
        ai_commit::write_api_key(&state.ai_commit_key_path, "$PATH").unwrap();
        let value = get_config(State(state.clone())).await.0;
        assert_eq!(value["has_api_key"], true);
        assert_eq!(value["api_key_source"], "env");
        assert_eq!(value["api_key_env"], "PATH");
        assert_eq!(value["api_key_env_set"], true);

        ai_commit::write_api_key(&state.ai_commit_key_path, "$OMNITERM_TEST_MISSING_KEY_9F3A")
            .unwrap();
        let value = get_config(State(state)).await.0;
        assert_eq!(value["api_key_source"], "env");
        assert_eq!(value["api_key_env_set"], false, "missing env var must be reported");
    }

    #[tokio::test]
    async fn put_persists_non_secret_fields_and_key_presence() {
        let state = crate::test_utils::test_state().await;
        let response = set_config(
            State(state.clone()),
            Json(SetConfigRequest {
                provider: "openai".into(),
                base_url: "https://api.openai.com/v1".into(),
                model: "gpt-4o-mini".into(),
                api_key: Some("sk-secret".into()),
                clear_api_key: false,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let value = response_json(response).await;
        assert_eq!(value["has_api_key"], true);
        assert_eq!(value["api_key_source"], "file");
        assert_eq!(value["api_key_env"], serde_json::Value::Null);
        assert!(value.get("api_key").is_none(), "API key must never be echoed");

        let cfg = ai_commit::load_config(&state.db).await;
        assert_eq!(cfg.provider, Provider::Openai);
        assert_eq!(cfg.model, "gpt-4o-mini");
        assert_eq!(
            ai_commit::read_api_key(&state.ai_commit_key_path).as_deref(),
            Some("sk-secret")
        );
        let db_raw: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key = 'ai_commit_config'")
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert!(!db_raw.unwrap().contains("sk-secret"), "key must not be stored in the DB");
    }

    #[tokio::test]
    async fn put_rejects_invalid_provider_and_missing_model() {
        let state = crate::test_utils::test_state().await;
        let response = set_config(
            State(state.clone()),
            Json(SetConfigRequest {
                provider: "acp".into(),
                base_url: String::new(),
                model: String::new(),
                api_key: None,
                clear_api_key: false,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);

        let response = set_config(
            State(state),
            Json(SetConfigRequest {
                provider: "openai".into(),
                base_url: "https://x/v1".into(),
                model: String::new(),
                api_key: None,
                clear_api_key: false,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn clear_key_removes_the_file() {
        let state = crate::test_utils::test_state().await;
        ai_commit::write_api_key(&state.ai_commit_key_path, "sk-x").unwrap();
        let response = set_config(
            State(state.clone()),
            Json(SetConfigRequest {
                provider: "off".into(),
                base_url: String::new(),
                model: String::new(),
                api_key: None,
                clear_api_key: true,
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(ai_commit::read_api_key(&state.ai_commit_key_path), None);
    }
}
