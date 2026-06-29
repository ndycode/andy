use andy_shared::env::Env;
use reqwest::StatusCode;
use serde::Serialize;
use thiserror::Error;

const SENDBLUE_BASE: &str = "https://api.sendblue.com/api";

#[derive(Debug, Clone)]
pub struct SendblueClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
    api_secret: String,
    from_number: String,
}

#[derive(Debug, Error)]
pub enum SendblueError {
    #[error("Sendblue {path} timed out after 10s")]
    Timeout { path: String },
    #[error("Sendblue {path} {status}: {body}")]
    Http {
        path: String,
        status: StatusCode,
        body: String,
    },
    #[error(transparent)]
    Request(#[from] reqwest::Error),
}

#[derive(Debug, Serialize)]
struct MessagePayload<'a> {
    number: &'a str,
    from_number: &'a str,
    content: &'a str,
}

impl SendblueClient {
    #[must_use]
    pub fn from_env(env: &Env) -> Self {
        Self::with_base_url(env, SENDBLUE_BASE)
    }

    #[must_use]
    pub fn with_base_url(env: &Env, base_url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .expect("reqwest client builds"),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: env.sendblue_api_key.clone(),
            api_secret: env.sendblue_api_secret.clone(),
            from_number: env.sendblue_from_number.clone(),
        }
    }

    pub async fn send_message(&self, phone: &str, content: &str) -> Result<(), SendblueError> {
        self.post(
            "/send-message",
            &MessagePayload {
                number: phone,
                from_number: &self.from_number,
                content,
            },
        )
        .await
    }

    async fn post<T: Serialize>(&self, path: &str, payload: &T) -> Result<(), SendblueError> {
        let result = self
            .http
            .post(format!("{}{}", self.base_url, path))
            .header("content-type", "application/json")
            .header("sb-api-key-id", &self.api_key)
            .header("sb-api-secret-key", &self.api_secret)
            .json(payload)
            .send()
            .await;
        let response = match result {
            Ok(response) => response,
            Err(err) if err.is_timeout() => {
                return Err(SendblueError::Timeout { path: path.into() });
            }
            Err(err) => return Err(SendblueError::Request(err)),
        };

        if response.status().is_success() {
            return Ok(());
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        Err(SendblueError::Http {
            path: path.into(),
            status,
            body,
        })
    }
}
