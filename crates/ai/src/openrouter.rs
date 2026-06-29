use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::model::ModelConfig;

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
            let body = response.text().await.unwrap_or_default();
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

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{bearer_token, method, path},
    };

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
