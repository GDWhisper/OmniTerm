//! AI-assisted commit messages.
//!
//! Two explicit providers (2026-10-19 decision): OpenAI-compatible chat
//! completions and Anthropic's native Messages API. ACP agents are deliberately
//! not used — spawning an agent per message is heavy and leaves agent-side
//! session records. Configuration lives in the `settings` table; the API key is
//! stored in a dedicated `0600` file (never in the DB, never returned by the API).
//!
//! Cost is user-controlled: exactly one request per explicit Generate click,
//! no automatic retries and no fallback to another provider.

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

/// settings 表 key：非敏感配置（provider / base_url / model）整体 JSON。
const KEY_AI_COMMIT_CONFIG: &str = "ai_commit_config";

pub const ANTHROPIC_VERSION: &str = "2023-06-01";

const MODELS_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
/// Model lists are small; cap regardless of provider pagination (P1 bound).
pub const MAX_MODELS: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Off,
    Openai,
    Anthropic,
}

impl Provider {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "openai" => Some(Self::Openai),
            "anthropic" => Some(Self::Anthropic),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AiCommitConfig {
    #[serde(default)]
    pub provider: Provider,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ModelList {
    pub models: Vec<ModelInfo>,
    pub truncated: bool,
}

/// Machine-readable AI error for the frontend i18n mapping.
#[derive(Debug, Clone, Serialize)]
pub struct AiError {
    pub code: &'static str,
    pub message: String,
}

impl AiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for AiError {}

pub async fn load_config(db: &SqlitePool) -> AiCommitConfig {
    let raw: Option<String> = match sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(KEY_AI_COMMIT_CONFIG)
        .fetch_optional(db)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            tracing::warn!("load ai commit config failed: {e}");
            None
        }
    };
    raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub async fn save_config(db: &SqlitePool, cfg: &AiCommitConfig) -> Result<(), String> {
    let json = serde_json::to_string(cfg).map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES (?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(KEY_AI_COMMIT_CONFIG)
    .bind(json)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Validate a full config. `Off` stores the remaining fields for convenience but
/// does not need them to be usable.
pub fn validate_config(cfg: &AiCommitConfig) -> Result<(), String> {
    if cfg.provider == Provider::Off {
        return Ok(());
    }
    validate_endpoint(cfg.provider, &cfg.base_url)?;
    if cfg.model.trim().is_empty() {
        return Err("model is required".into());
    }
    Ok(())
}

pub fn validate_endpoint(provider: Provider, base_url: &str) -> Result<(), String> {
    if provider == Provider::Off {
        return Err("provider is off".into());
    }
    let base = base_url.trim();
    if base.is_empty() {
        return Err("base URL is required".into());
    }
    let url = reqwest::Url::parse(base).map_err(|_| "base URL is invalid".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("base URL must use http or https".into());
    }
    Ok(())
}

/// Key file name mirrors the instance suffix used for `jwt_secret`:
/// `ai_commit_key` (release) / `ai_commit_key_dev` (dev worktree).
pub fn key_file_name(suffix: &str) -> String {
    if suffix.is_empty() { "ai_commit_key".to_string() } else { format!("ai_commit_key_{suffix}") }
}

pub fn read_api_key(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn write_api_key(path: &Path, key: &str) -> std::io::Result<()> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        // `mode` only applies on creation; force 0600 for pre-existing files.
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.write_all(key.as_bytes())
    }
    #[cfg(not(unix))]
    {
        let mut file =
            std::fs::OpenOptions::new().write(true).create(true).truncate(true).open(path)?;
        file.write_all(key.as_bytes())
    }
}

pub fn clear_api_key(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn join_base(base_url: &str, path: &str) -> String {
    format!("{}/{}", base_url.trim().trim_end_matches('/'), path.trim_start_matches('/'))
}

/// Anthropic base URLs may or may not include the version prefix; avoid `v1/v1`.
fn with_v1(base_url: &str, path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/v1") {
        join_base(base, path)
    } else {
        join_base(base, &format!("v1/{path}"))
    }
}

pub fn models_url(provider: Provider, base_url: &str) -> Option<String> {
    match provider {
        Provider::Off => None,
        Provider::Openai => Some(join_base(base_url, "models")),
        Provider::Anthropic => Some(with_v1(base_url, "models?limit=1000")),
    }
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, AiError> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| AiError::new("ai_network", format!("failed to build HTTP client: {e}")))
}

fn map_transport_error(e: reqwest::Error) -> AiError {
    if e.is_timeout() {
        AiError::new("ai_timeout", "provider request timed out")
    } else {
        AiError::new("ai_network", format!("provider request failed: {e}"))
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max { text.to_string() } else { text.chars().take(max).collect() }
}

fn status_error(status: reqwest::StatusCode, body: &str) -> AiError {
    let code = match status.as_u16() {
        401 | 403 => "ai_auth",
        408 | 504 => "ai_timeout",
        429 => "ai_rate_limited",
        _ => "ai_upstream",
    };
    let snippet = truncate_chars(body.trim(), 300);
    let message = if snippet.is_empty() {
        format!("provider returned HTTP {status}")
    } else {
        format!("provider returned HTTP {status}: {snippet}")
    };
    AiError::new(code, message)
}

async fn read_capped(mut response: reqwest::Response, max: usize) -> Result<String, AiError> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(map_transport_error)? {
        if buf.len() + chunk.len() > max {
            return Err(AiError::new("ai_upstream", "provider response exceeds size limit"));
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf)
        .map_err(|_| AiError::new("ai_upstream", "provider response is not valid UTF-8"))
}

fn parse_models(provider: Provider, body: &str) -> Result<ModelList, AiError> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| AiError::new("ai_upstream", "provider returned invalid model list JSON"))?;
    let data = value
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| AiError::new("ai_upstream", "provider model list has no data array"))?;

    let mut models = Vec::new();
    let mut truncated = false;
    for item in data {
        if models.len() >= MAX_MODELS {
            truncated = true;
            break;
        }
        let Some(id) = item.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
            continue;
        };
        let label = item.get("display_name").and_then(|v| v.as_str()).unwrap_or(id);
        models.push(ModelInfo { id: id.to_string(), label: label.to_string() });
    }
    if provider == Provider::Openai {
        models.sort_by(|a, b| a.id.cmp(&b.id));
    }
    Ok(ModelList { models, truncated })
}

/// Fetch the provider model list. No key is required so local OpenAI-compatible
/// servers (Ollama/LM Studio) work; auth headers are only sent when configured.
pub async fn list_models(
    provider: Provider,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<ModelList, AiError> {
    validate_endpoint(provider, base_url).map_err(|msg| AiError::new("ai_not_configured", msg))?;
    let url = models_url(provider, base_url)
        .ok_or_else(|| AiError::new("ai_not_configured", "provider is off"))?;
    let client = http_client(MODELS_TIMEOUT)?;
    let mut request = client.get(url);
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        request = match provider {
            Provider::Openai => request.bearer_auth(key.trim()),
            Provider::Anthropic => request
                .header("x-api-key", key.trim())
                .header("anthropic-version", ANTHROPIC_VERSION),
            Provider::Off => request,
        };
    } else if provider == Provider::Anthropic {
        request = request.header("anthropic-version", ANTHROPIC_VERSION);
    }

    let response = request.send().await.map_err(map_transport_error)?;
    let status = response.status();
    let body = read_capped(response, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(status_error(status, &body));
    }
    parse_models(provider, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, http::HeaderMap, routing::get};

    fn config(provider: Provider, base_url: &str, model: &str) -> AiCommitConfig {
        AiCommitConfig { provider, base_url: base_url.into(), model: model.into() }
    }

    #[test]
    fn provider_roundtrip_strings() {
        for (raw, provider) in [
            ("off", Provider::Off),
            ("openai", Provider::Openai),
            ("anthropic", Provider::Anthropic),
        ] {
            assert_eq!(Provider::parse(raw), Some(provider));
            assert_eq!(provider.as_str(), raw);
        }
        assert_eq!(Provider::parse("acp"), None);
    }

    #[test]
    fn validate_requires_endpoint_and_model_when_enabled() {
        assert!(validate_config(&config(Provider::Off, "", "")).is_ok());
        assert!(validate_config(&config(Provider::Openai, "", "gpt")).is_err());
        assert!(validate_config(&config(Provider::Openai, "ftp://x", "gpt")).is_err());
        assert!(validate_config(&config(Provider::Openai, "https://x/v1", "")).is_err());
        assert!(validate_config(&config(Provider::Openai, "https://x/v1", "gpt")).is_ok());
    }

    #[test]
    fn url_builders_handle_version_prefixes() {
        assert_eq!(
            models_url(Provider::Openai, "https://api.openai.com/v1/").as_deref(),
            Some("https://api.openai.com/v1/models")
        );
        assert_eq!(
            models_url(Provider::Anthropic, "https://api.anthropic.com").as_deref(),
            Some("https://api.anthropic.com/v1/models?limit=1000")
        );
        assert_eq!(
            models_url(Provider::Anthropic, "https://proxy.example/anthropic/v1").as_deref(),
            Some("https://proxy.example/anthropic/v1/models?limit=1000")
        );
        assert_eq!(models_url(Provider::Off, "https://x"), None);
    }

    #[test]
    fn parse_models_handles_both_shapes_and_caps() {
        let openai = r#"{"data":[{"id":"gpt-b"},{"id":"gpt-a"}]}"#;
        let list = parse_models(Provider::Openai, openai).unwrap();
        assert_eq!(
            list.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["gpt-a", "gpt-b"]
        );

        let anthropic = r#"{"data":[{"id":"claude-x","display_name":"Claude X"}]}"#;
        let list = parse_models(Provider::Anthropic, anthropic).unwrap();
        assert_eq!(list.models[0].label, "Claude X");

        let many: Vec<String> =
            (0..MAX_MODELS + 1).map(|i| format!(r#"{{"id":"m{i}"}}"#)).collect();
        let body = format!(r#"{{"data":[{}]}}"#, many.join(","));
        let list = parse_models(Provider::Openai, &body).unwrap();
        assert_eq!(list.models.len(), MAX_MODELS);
        assert!(list.truncated);
    }

    #[test]
    fn api_key_file_roundtrip_and_clear() {
        let dir = std::env::temp_dir().join(format!("omniterm-ai-key-{}", uuid::Uuid::new_v4()));
        let path = dir.join("key");
        assert_eq!(read_api_key(&path), None);
        write_api_key(&path, "  sk-test  ").unwrap();
        assert_eq!(read_api_key(&path).as_deref(), Some("sk-test"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        clear_api_key(&path).unwrap();
        assert_eq!(read_api_key(&path), None);
        clear_api_key(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn config_roundtrip_in_settings_table() {
        let state = crate::test_utils::test_state().await;
        let db = state.db;
        assert_eq!(load_config(&db).await, AiCommitConfig::default());
        let cfg = config(Provider::Anthropic, "https://api.anthropic.com", "claude-sonnet");
        save_config(&db, &cfg).await.unwrap();
        assert_eq!(load_config(&db).await, cfg);
    }

    async fn serve(router: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn list_models_sends_provider_auth_headers() {
        async fn openai(headers: HeaderMap) -> &'static str {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer sk-openai");
            r#"{"data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"}]}"#
        }
        async fn anthropic(headers: HeaderMap) -> &'static str {
            assert_eq!(headers.get("x-api-key").unwrap(), "sk-anthropic");
            assert_eq!(headers.get("anthropic-version").unwrap(), ANTHROPIC_VERSION);
            r#"{"data":[{"id":"claude-x","display_name":"Claude X"}]}"#
        }
        let router = Router::new()
            .route("/openai/v1/models", get(openai))
            .route("/anthropic/v1/models", get(anthropic));
        let base = serve(router).await;

        let list = list_models(Provider::Openai, &format!("{base}/openai/v1"), Some("sk-openai"))
            .await
            .unwrap();
        assert_eq!(list.models.len(), 2);

        let list =
            list_models(Provider::Anthropic, &format!("{base}/anthropic"), Some("sk-anthropic"))
                .await
                .unwrap();
        assert_eq!(list.models[0].id, "claude-x");
    }

    #[tokio::test]
    async fn list_models_maps_auth_and_rate_limit_errors() {
        async fn unauthorized() -> (axum::http::StatusCode, &'static str) {
            (axum::http::StatusCode::UNAUTHORIZED, r#"{"error":"bad key"}"#)
        }
        async fn limited() -> (axum::http::StatusCode, &'static str) {
            (axum::http::StatusCode::TOO_MANY_REQUESTS, r#"{"error":"slow down"}"#)
        }
        let router = Router::new()
            .route("/v1/models", get(unauthorized))
            .route("/limited/v1/models", get(limited));
        let base = serve(router).await;

        let err =
            list_models(Provider::Openai, &format!("{base}/v1"), Some("k")).await.unwrap_err();
        assert_eq!(err.code, "ai_auth");

        let err = list_models(Provider::Openai, &format!("{base}/limited/v1"), Some("k"))
            .await
            .unwrap_err();
        assert_eq!(err.code, "ai_rate_limited");
    }
}
