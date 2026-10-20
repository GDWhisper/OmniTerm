//! One-shot commit-message generation for the two supported provider APIs.
//!
//! Exactly one HTTP request per user click; no retries, no provider fallback
//! (cost is user-controlled). Responses are size-capped and parsed tolerantly.

use std::time::Duration;

use serde_json::{Value, json};

use super::{
    ANTHROPIC_VERSION, AiCommitConfig, AiError, MAX_RESPONSE_BYTES, Provider, chat_url,
    http_client, map_transport_error, read_capped, status_error,
};

const GENERATION_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_OUTPUT_TOKENS: u32 = 400;
const MAX_COMMIT_MESSAGE_CHARS: usize = 4000;

const SYSTEM_PROMPT: &str = "You write git commit messages. You receive a staged diff and \
recent commit subjects. Follow the language, capitalization and prefix conventions of the \
recent subjects; if no subjects are given, use Conventional Commits in English. Return STRICT \
JSON only, with exactly one key: {\"message\": \"...\"}. No markdown fences, no explanations. \
Keep the subject under 72 characters; add a short body only if the diff requires it. Never \
mention the diff itself or that the message was generated.";

/// Build the system/user prompts. Truncation is stated explicitly so the model
/// does not claim to have reviewed changes it never saw.
pub fn build_prompts(
    diff: &str,
    subjects: &[String],
    omitted_files: usize,
    omitted_chars: usize,
) -> (String, String) {
    let mut user = String::from("Recent commit subjects:\n");
    if subjects.is_empty() {
        user.push_str("(none)\n");
    } else {
        for subject in subjects.iter().take(10) {
            user.push_str(&format!("- {subject}\n"));
        }
    }
    if omitted_files > 0 || omitted_chars > 0 {
        user.push_str(&format!(
            "\nThe staged diff was truncated: {omitted_files} file(s) and {omitted_chars} \
             character(s) omitted. Do not claim a complete inventory.\n"
        ));
    }
    user.push_str("\nStaged diff:\n```diff\n");
    user.push_str(diff);
    user.push_str("\n```\n");
    (SYSTEM_PROMPT.to_string(), user)
}

fn request_body(provider: Provider, model: &str, system: &str, user: &str) -> Value {
    match provider {
        Provider::Openai => json!({
            "model": model,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user },
            ],
            "temperature": 0.2,
            "max_tokens": MAX_OUTPUT_TOKENS,
        }),
        Provider::Anthropic => json!({
            "model": model,
            "max_tokens": MAX_OUTPUT_TOKENS,
            "temperature": 0.2,
            "system": system,
            "messages": [{ "role": "user", "content": user }],
        }),
        Provider::Off => Value::Null,
    }
}

fn json_message(input: &str) -> Option<String> {
    let value: Value = serde_json::from_str(input).ok()?;
    let message = value.get("message")?.as_str()?.trim();
    (!message.is_empty()).then(|| message.to_string())
}

fn strip_code_fence(input: &str) -> &str {
    let trimmed = input.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    let Some(newline) = rest.find('\n') else {
        return trimmed;
    };
    let body = &rest[newline + 1..];
    let end = body.rfind("```").unwrap_or(body.len());
    body[..end].trim()
}

fn accept_message(message: &str) -> Result<String, AiError> {
    let message = message.trim();
    if message.is_empty() {
        return Err(AiError::new("ai_invalid_response", "provider returned an empty message"));
    }
    if message.chars().count() > MAX_COMMIT_MESSAGE_CHARS {
        return Err(AiError::new("ai_invalid_response", "provider message is too long"));
    }
    Ok(message.to_string())
}

/// Tolerant parser: strict JSON → fenced JSON → first JSON object → first line.
pub fn parse_commit_message(raw: &str) -> Result<String, AiError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AiError::new("ai_invalid_response", "provider returned an empty response"));
    }
    if let Some(message) = json_message(trimmed) {
        return accept_message(&message);
    }
    let fenced = strip_code_fence(trimmed);
    if fenced != trimmed
        && let Some(message) = json_message(fenced)
    {
        return accept_message(&message);
    }
    let source = if fenced.is_empty() { trimmed } else { fenced };
    if let (Some(start), Some(end)) = (source.find('{'), source.rfind('}'))
        && start < end
        && let Some(message) = json_message(&source[start..=end])
    {
        return accept_message(&message);
    }

    let line = source.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or("");
    let line = line.trim_matches(|c| c == '"' || c == '`' || c == '\'').trim();
    accept_message(line)
}

fn extract_text(provider: Provider, body: &str) -> Result<String, AiError> {
    let value: Value = serde_json::from_str(body)
        .map_err(|_| AiError::new("ai_invalid_response", "provider returned invalid JSON"))?;
    let text = match provider {
        Provider::Openai => match value.pointer("/choices/0/message/content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        },
        Provider::Anthropic => value
            .get("content")
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default(),
        Provider::Off => String::new(),
    };
    if text.trim().is_empty() {
        Err(AiError::new("ai_invalid_response", "provider returned an empty message"))
    } else {
        Ok(text)
    }
}

pub async fn generate(
    cfg: &AiCommitConfig,
    api_key: Option<&str>,
    system: &str,
    user: &str,
) -> Result<String, AiError> {
    if cfg.provider == Provider::Off {
        return Err(AiError::new("ai_not_configured", "AI commit is off"));
    }
    super::validate_config(cfg).map_err(|msg| AiError::new("ai_not_configured", msg))?;
    let url = chat_url(cfg.provider, &cfg.base_url)
        .ok_or_else(|| AiError::new("ai_not_configured", "provider is off"))?;

    let client = http_client(GENERATION_TIMEOUT)?;
    let mut request = client.post(url).json(&request_body(cfg.provider, &cfg.model, system, user));
    let key = api_key.map(str::trim).filter(|key| !key.is_empty());
    request = match cfg.provider {
        Provider::Openai => {
            if let Some(key) = key {
                request.bearer_auth(key)
            } else {
                request
            }
        }
        Provider::Anthropic => {
            let request =
                if let Some(key) = key { request.header("x-api-key", key) } else { request };
            request.header("anthropic-version", ANTHROPIC_VERSION)
        }
        Provider::Off => request,
    };

    let response = request.send().await.map_err(map_transport_error)?;
    let status = response.status();
    let body = read_capped(response, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(status_error(status, &body));
    }
    let raw = extract_text(cfg.provider, &body)?;
    parse_commit_message(&raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_commit::test_http::serve;
    use axum::{Router, http::HeaderMap, routing::post};

    fn config(provider: Provider) -> AiCommitConfig {
        AiCommitConfig { provider, base_url: String::new(), model: "test-model".into() }
    }

    #[test]
    fn prompts_include_style_samples_and_explicit_truncation() {
        let subjects = vec!["feat: add git panel".to_string(), "fix: lock retry".to_string()];
        let (system, user) = build_prompts("diff --git a/x b/x\n+hello\n", &subjects, 2, 345);
        assert!(system.contains("STRICT JSON"));
        assert!(user.contains("- feat: add git panel"));
        assert!(user.contains("2 file(s) and 345 character(s) omitted"));
        assert!(user.contains("+hello"));
    }

    #[test]
    fn parses_json_fenced_json_and_plain_fallback() {
        assert_eq!(parse_commit_message(r#"{"message":"feat: x"}"#).unwrap(), "feat: x");
        assert_eq!(
            parse_commit_message("```json\n{\"message\":\"fix: y\"}\n```").unwrap(),
            "fix: y"
        );
        assert_eq!(
            parse_commit_message("Here you go: {\"message\":\"chore: z\"} thanks").unwrap(),
            "chore: z"
        );
        assert_eq!(parse_commit_message("docs: plain line\nbody").unwrap(), "docs: plain line");
        assert_eq!(parse_commit_message("\"quoted message\"").unwrap(), "quoted message");
    }

    #[test]
    fn rejects_empty_and_oversized_messages() {
        assert_eq!(parse_commit_message("   ").unwrap_err().code, "ai_invalid_response");
        let long = "x".repeat(MAX_COMMIT_MESSAGE_CHARS + 1);
        assert_eq!(parse_commit_message(&long).unwrap_err().code, "ai_invalid_response");
    }

    #[test]
    fn request_bodies_match_each_api_shape() {
        let openai = request_body(Provider::Openai, "gpt", "sys", "usr");
        assert_eq!(openai["messages"][0]["role"], "system");
        assert_eq!(openai["messages"][1]["content"], "usr");
        assert_eq!(openai["max_tokens"], MAX_OUTPUT_TOKENS);

        let anthropic = request_body(Provider::Anthropic, "claude", "sys", "usr");
        assert_eq!(anthropic["system"], "sys");
        assert_eq!(anthropic["messages"][0]["role"], "user");
        assert_eq!(anthropic["max_tokens"], MAX_OUTPUT_TOKENS);
        assert!(anthropic.get("messages").is_some());
    }

    #[test]
    fn extracts_text_from_each_api_response() {
        let openai = r#"{"choices":[{"message":{"content":"{\"message\":\"feat: a\"}"}}]}"#;
        assert_eq!(extract_text(Provider::Openai, openai).unwrap(), "{\"message\":\"feat: a\"}");

        let openai_parts =
            r#"{"choices":[{"message":{"content":[{"type":"text","text":"part one"}]}}]}"#;
        assert_eq!(extract_text(Provider::Openai, openai_parts).unwrap(), "part one");

        let anthropic = r#"{"content":[{"type":"text","text":"{\"message\":\"fix: b\"}"},{"type":"thinking","thinking":"x"}]}"#;
        assert_eq!(
            extract_text(Provider::Anthropic, anthropic).unwrap(),
            "{\"message\":\"fix: b\"}"
        );
    }

    #[tokio::test]
    async fn generate_calls_openai_with_bearer_auth() {
        async fn chat(headers: HeaderMap, body: axum::Json<Value>) -> &'static str {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer sk-openai");
            assert_eq!(body["model"], "test-model");
            assert_eq!(body["messages"][0]["content"], "system prompt");
            r#"{"choices":[{"message":{"content":"{\"message\":\"feat: generated\"}"}}]}"#
        }
        let base = serve(Router::new().route("/v1/chat/completions", post(chat))).await;
        let mut cfg = config(Provider::Openai);
        cfg.base_url = format!("{base}/v1");

        let message =
            generate(&cfg, Some("sk-openai"), "system prompt", "user prompt").await.unwrap();
        assert_eq!(message, "feat: generated");
    }

    #[tokio::test]
    async fn generate_calls_anthropic_with_native_headers_and_body() {
        async fn messages(headers: HeaderMap, body: axum::Json<Value>) -> &'static str {
            assert_eq!(headers.get("x-api-key").unwrap(), "sk-ant");
            assert_eq!(headers.get("anthropic-version").unwrap(), ANTHROPIC_VERSION);
            assert_eq!(body["system"], "system prompt");
            assert_eq!(body["messages"][0]["role"], "user");
            r#"{"content":[{"type":"text","text":"{\"message\":\"fix: anthropic\"}"}]}"#
        }
        let base = serve(Router::new().route("/v1/messages", post(messages))).await;
        let mut cfg = config(Provider::Anthropic);
        cfg.base_url = base;

        let message = generate(&cfg, Some("sk-ant"), "system prompt", "user prompt").await.unwrap();
        assert_eq!(message, "fix: anthropic");
    }

    #[tokio::test]
    async fn generate_maps_upstream_auth_errors_without_retry() {
        async fn unauthorized() -> (axum::http::StatusCode, &'static str) {
            (axum::http::StatusCode::UNAUTHORIZED, r#"{"error":"bad key"}"#)
        }
        let base = serve(Router::new().route("/v1/chat/completions", post(unauthorized))).await;
        let mut cfg = config(Provider::Openai);
        cfg.base_url = format!("{base}/v1");

        let err = generate(&cfg, Some("bad"), "sys", "usr").await.unwrap_err();
        assert_eq!(err.code, "ai_auth");
    }
}
