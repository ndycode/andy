use andy_shared::env::Env;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::model::{ModelConfig, ModelConfigError, resolve_model_config};

/// Build an [`OpenRouterClient`] from process [`Env`] for serverless lazy
/// initialization.
///
/// Returns `Ok(None)` when no `OPENROUTER_API_KEY` is configured (the caller
/// then surfaces a safe "model not configured" failure), and an error only when
/// `OPENROUTER_MODEL` is invalid. It never panics and never performs a network
/// call, so it is safe to invoke on every inbound request.
pub fn openrouter_from_env(env: &Env) -> Result<Option<OpenRouterClient>, ModelConfigError> {
    let Some(api_key) = env.openrouter_api_key.clone() else {
        return Ok(None);
    };
    let model_config = resolve_model_config(env.openrouter_model.as_deref(), None)?;
    let client = match env.openrouter_base_url.as_deref() {
        Some(base_url) => OpenRouterClient::with_base_url(api_key, model_config, base_url),
        None => OpenRouterClient::new(api_key, model_config),
    };
    Ok(Some(client))
}

#[derive(Debug, Clone)]
pub struct OpenRouterClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    config: ModelConfig,
}

#[derive(Debug, Error)]
pub enum OpenRouterError {
    #[error("OPENROUTER_API_KEY is required for a live model run")]
    MissingApiKey,
    #[error("OpenRouter {status}: {body}")]
    Http { status: StatusCode, body: String },
    #[error(transparent)]
    Request(#[from] reqwest::Error),
    #[error("OpenRouter response had no assistant message")]
    EmptyResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
}

impl ChatMessage {
    #[must_use]
    pub fn text(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    #[must_use]
    pub fn assistant_tool_calls(tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: "assistant".into(),
            content: String::new(),
            tool_call_id: None,
            tool_calls,
        }
    }

    #[must_use]
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: content.into(),
            tool_call_id: Some(tool_call_id.into()),
            tool_calls: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolSpec {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub function: ToolFunctionSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolFunctionSpec {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssistantTurn {
    pub content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    reasoning: ReasoningSettings,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<&'a [ToolSpec]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
}

#[derive(Debug, Serialize)]
struct ReasoningSettings {
    effort: &'static str,
    exclude: bool,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: AssistantMessage,
}

#[derive(Debug, Deserialize)]
struct AssistantMessage {
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCall>,
}

impl OpenRouterClient {
    #[must_use]
    pub fn new(api_key: String, config: ModelConfig) -> Self {
        Self::with_base_url(api_key, config, "https://openrouter.ai/api/v1")
    }

    #[must_use]
    pub fn with_base_url(
        api_key: String,
        config: ModelConfig,
        base_url: impl Into<String>,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
            config,
        }
    }

    pub async fn chat(&self, messages: &[ChatMessage]) -> Result<String, OpenRouterError> {
        let turn = self.chat_turn(messages, None).await?;
        turn.content
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .ok_or(OpenRouterError::EmptyResponse)
    }

    pub async fn chat_turn(
        &self,
        messages: &[ChatMessage],
        tools: Option<&[ToolSpec]>,
    ) -> Result<AssistantTurn, OpenRouterError> {
        if self.api_key.trim().is_empty() {
            return Err(OpenRouterError::MissingApiKey);
        }

        let request = ChatRequest {
            model: &self.config.model_id,
            messages,
            reasoning: ReasoningSettings {
                effort: "low",
                exclude: true,
            },
            tools,
            temperature: Some(0.0),
        };
        let response = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&request)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            // Keep only a short, redacted excerpt of the provider body. The
            // full body can echo request content; failure handling keys off the
            // status code, not the body, and user replies never include it.
            let raw = response.text().await.unwrap_or_default();
            let body = redact_excerpt(&raw);
            return Err(OpenRouterError::Http { status, body });
        }

        let payload: ChatResponse = response.json().await?;
        let message = payload
            .choices
            .into_iter()
            .next()
            .map(|choice| choice.message)
            .ok_or(OpenRouterError::EmptyResponse)?;
        Ok(AssistantTurn {
            content: message
                .content
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty()),
            tool_calls: message.tool_calls,
        })
    }
}

/// Reduce a provider error body to a short, redacted excerpt safe to store and
/// log: collapse whitespace, drop anything that looks like a key/token, and
/// clip to a small length.
fn redact_excerpt(body: &str) -> String {
    const MAX: usize = 120;
    let collapsed = body
        .split_whitespace()
        .filter(|tok| !looks_secret(tok))
        .collect::<Vec<_>>()
        .join(" ");
    collapsed.chars().take(MAX).collect()
}

fn looks_secret(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    lower.starts_with("sk-")
        || lower.starts_with("sk_")
        || lower.starts_with("bearer")
        || lower.contains("key")
        || lower.contains("token")
        || lower.contains("secret")
        // long unbroken alphanumeric runs are likely credentials
        || (token.len() >= 32 && token.chars().all(|c| c.is_ascii_alphanumeric()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{bearer_token, method, path},
    };

    fn env_with(api_key: Option<&str>, model: Option<&str>) -> Env {
        Env {
            database_url: "postgres://x".into(),
            sendblue_api_key: "k".into(),
            sendblue_api_secret: "s".into(),
            sendblue_from_number: "+1".into(),
            webhook_url_token: "t".into(),
            webhook_url_token_sha256: None,
            cron_secret: "c".into(),
            allowed_phone: "+1".into(),
            openrouter_api_key: api_key.map(ToString::to_string),
            openrouter_model: model.map(ToString::to_string),
            openrouter_base_url: None,
            app_timezone: "Asia/Manila".into(),
            app_timezone_offset_minutes: 480,
            confirm_amount_threshold_centavos: None,
            inbound_rate_limit: None,
            inbound_rate_window_seconds: None,
        }
    }

    #[test]
    fn openrouter_from_env_builds_client_when_key_present() {
        let env = env_with(Some("sk-test"), None);
        let client = openrouter_from_env(&env).expect("valid config");
        assert!(
            client.is_some(),
            "client should be built when key is present"
        );
    }

    #[test]
    fn openrouter_from_env_is_none_without_key() {
        let env = env_with(None, None);
        assert!(openrouter_from_env(&env).expect("ok").is_none());
    }

    #[test]
    fn openrouter_from_env_surfaces_bad_model_without_panicking() {
        let env = env_with(Some("sk-test"), Some("openai/gpt-4o"));
        let result = openrouter_from_env(&env);
        assert!(matches!(result, Err(ModelConfigError::NonFreeModel(_))));
    }

    #[test]
    fn redact_excerpt_drops_secret_looking_tokens() {
        let body = "error: invalid api key sk-abcdef0123456789 token=supersecret please retry";
        let excerpt = redact_excerpt(body);
        assert!(!excerpt.contains("sk-abcdef"));
        assert!(!excerpt.contains("supersecret"));
        assert!(excerpt.contains("error"));
        assert!(excerpt.chars().count() <= 120);
    }

    #[tokio::test]
    async fn http_error_body_is_sanitized() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_json(serde_json::json!({
                "error": "bad key sk-LEAKEDKEY0123456789abcdef",
            })))
            .mount(&server)
            .await;
        let client = OpenRouterClient::with_base_url(
            "sk-test".into(),
            ModelConfig {
                model_id: "openai/gpt-oss-120b:free".into(),
            },
            server.uri(),
        );
        let err = client
            .chat(&[ChatMessage::text("user", "hi")])
            .await
            .unwrap_err();
        let rendered = err.to_string();
        assert!(
            !rendered.contains("sk-LEAKEDKEY"),
            "raw key leaked: {rendered}"
        );
    }

    #[tokio::test]
    async fn sends_openrouter_chat_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .and(bearer_token("sk-test"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{ "message": { "content": " logged it " } }]
            })))
            .mount(&server)
            .await;

        let client = OpenRouterClient::with_base_url(
            "sk-test".into(),
            ModelConfig {
                model_id: "openai/gpt-oss-120b:free".into(),
            },
            server.uri(),
        );

        let reply = client
            .chat(&[ChatMessage::text("user", "hello")])
            .await
            .unwrap();
        assert_eq!(reply, "logged it");
    }

    #[tokio::test]
    async fn returns_tool_calls() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {
                        "content": null,
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "logExpense",
                                "arguments": "{\"amount\":\"180\",\"category\":\"Transport\"}"
                            }
                        }]
                    }
                }]
            })))
            .mount(&server)
            .await;

        let client = OpenRouterClient::with_base_url(
            "sk-test".into(),
            ModelConfig {
                model_id: "openai/gpt-oss-120b:free".into(),
            },
            server.uri(),
        );
        let turn = client
            .chat_turn(&[ChatMessage::text("user", "grab 180")], Some(&[]))
            .await
            .unwrap();

        assert_eq!(turn.tool_calls[0].function.name, "logExpense");
    }
}
