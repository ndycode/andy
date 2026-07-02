use andy_db::{
    OutboundMessageRow, claim_due_outbound_messages, claim_outbound_by_dedup_key,
    mark_outbound_failed, mark_outbound_sent,
};
use andy_shared::env::Env;
use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use serde::Serialize;
use sqlx::PgPool;
use thiserror::Error;
use tracing::error;

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
    #[error("Sendblue {path} {status}: {class}")]
    Http {
        path: String,
        status: StatusCode,
        /// Safe classification only. The raw provider body is never stored
        /// here so it cannot leak into logs or the DB.
        class: ErrorClass,
    },
    #[error(transparent)]
    Request(#[from] reqwest::Error),
}

/// Coarse, secret-free classification of a provider failure. Used in logs,
/// `outbound_messages.last_error`, and retry decisions — never the raw body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    Timeout,
    Auth,
    RateLimited,
    ServerError,
    ClientError,
    Unknown,
}

impl ErrorClass {
    #[must_use]
    pub fn from_status(status: StatusCode) -> Self {
        match status.as_u16() {
            401 | 403 => Self::Auth,
            429 => Self::RateLimited,
            500..=599 => Self::ServerError,
            400..=499 => Self::ClientError,
            _ => Self::Unknown,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Timeout => "timeout",
            Self::Auth => "auth",
            Self::RateLimited => "rate_limited",
            Self::ServerError => "server_error",
            Self::ClientError => "client_error",
            Self::Unknown => "unknown",
        }
    }

    /// Whether a failure of this class is worth retrying. Auth and other 4xx
    /// client errors are terminal; timeouts, 429, and 5xx are transient.
    #[must_use]
    pub const fn is_retryable(self) -> bool {
        matches!(self, Self::Timeout | Self::RateLimited | Self::ServerError)
    }
}

impl std::fmt::Display for ErrorClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl SendblueError {
    /// Safe, secret-free one-line summary for storage/logging.
    #[must_use]
    pub fn safe_summary(&self) -> String {
        match self {
            Self::Timeout { .. } => "timeout".to_string(),
            Self::Http { status, class, .. } => format!("{class}:{}", status.as_u16()),
            Self::Request(_) => "request_error".to_string(),
        }
    }

    /// Classify for retry decisions without exposing any body.
    #[must_use]
    pub fn class(&self) -> ErrorClass {
        match self {
            Self::Timeout { .. } => ErrorClass::Timeout,
            Self::Http { class, .. } => *class,
            Self::Request(err) if err.is_timeout() => ErrorClass::Timeout,
            Self::Request(_) => ErrorClass::Unknown,
        }
    }
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
        // Drain and discard the body. We deliberately do not read or store it:
        // provider error bodies can echo request content or secrets.
        let _ = response.bytes().await;
        Err(SendblueError::Http {
            path: path.into(),
            status,
            class: ErrorClass::from_status(status),
        })
    }
}

pub async fn deliver_outbound_by_dedup_key(
    pool: &PgPool,
    sendblue: &SendblueClient,
    dedup_key: &str,
) -> Result<Option<bool>, sqlx::Error> {
    let Some(message) = claim_outbound_by_dedup_key(pool, dedup_key).await? else {
        return Ok(None);
    };
    deliver_outbound_message(pool, sendblue, message)
        .await
        .map(Some)
}

pub async fn deliver_due_outbound(
    pool: &PgPool,
    sendblue: &SendblueClient,
    now: DateTime<Utc>,
    limit: i64,
) -> Result<(i64, i64), sqlx::Error> {
    let messages = claim_due_outbound_messages(pool, now, limit).await?;
    let mut sent = 0;
    let mut failed = 0;
    for message in messages {
        if deliver_outbound_message(pool, sendblue, message).await? {
            sent += 1;
        } else {
            failed += 1;
        }
    }
    Ok((sent, failed))
}

async fn deliver_outbound_message(
    pool: &PgPool,
    sendblue: &SendblueClient,
    message: OutboundMessageRow,
) -> Result<bool, sqlx::Error> {
    match sendblue
        .send_message(&message.phone, &message.content)
        .await
    {
        Ok(()) => {
            mark_outbound_sent(pool, message.id).await?;
            Ok(true)
        }
        Err(err) => {
            error!(
                event = "sendblue.outbound.error",
                outbound_id = %message.id,
                attempt = message.attempt_count,
                class = %err.class(),
                summary = %err.safe_summary()
            );
            mark_outbound_failed(
                pool,
                message.id,
                &err.safe_summary(),
                err.class().is_retryable(),
            )
            .await?;
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::{
        Mock, MockServer, ResponseTemplate,
        matchers::{method, path},
    };

    fn client(base_url: &str) -> SendblueClient {
        let env = Env {
            database_url: "postgres://x".into(),
            sendblue_api_key: "k".into(),
            sendblue_api_secret: "s".into(),
            sendblue_from_number: "+1".into(),
            webhook_url_token: "t".into(),
            webhook_url_token_sha256: None,
            sendblue_signing_secret: None,
            cron_secret: "c".into(),
            allowed_phone: "+1".into(),
            openrouter_api_key: None,
            openrouter_model: None,
            openrouter_base_url: None,
            app_timezone: "Asia/Manila".into(),
            app_timezone_offset_minutes: 480,
            confirm_amount_threshold_centavos: None,
            inbound_rate_limit: None,
            inbound_rate_window_seconds: None,
        };
        SendblueClient::with_base_url(&env, base_url)
    }

    async fn mock_status(status: u16) -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/send-message"))
            .respond_with(
                ResponseTemplate::new(status)
                    .set_body_json(serde_json::json!({ "error": "boom sk-LEAKED0123456789abcd" })),
            )
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn sendblue_success() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/send-message"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({ "ok": true })),
            )
            .mount(&server)
            .await;
        assert!(client(&server.uri()).send_message("+1", "hi").await.is_ok());
    }

    #[tokio::test]
    async fn sendblue_classifies_and_redacts_errors() {
        for (status, class) in [
            (401, ErrorClass::Auth),
            (403, ErrorClass::Auth),
            (429, ErrorClass::RateLimited),
            (500, ErrorClass::ServerError),
            (418, ErrorClass::ClientError),
        ] {
            let server = mock_status(status).await;
            let err = client(&server.uri())
                .send_message("+1", "hi")
                .await
                .unwrap_err();
            assert_eq!(err.class(), class, "status {status}");
            let summary = err.safe_summary();
            // Safe summary carries only class:status — never the raw body.
            assert!(!summary.contains("sk-LEAKED"), "leaked in {summary}");
            assert!(!summary.contains("boom"), "raw body in {summary}");
            assert!(summary.contains(class.as_str()));
        }
    }

    #[test]
    fn retryability_matches_class() {
        assert!(ErrorClass::Timeout.is_retryable());
        assert!(ErrorClass::RateLimited.is_retryable());
        assert!(ErrorClass::ServerError.is_retryable());
        assert!(!ErrorClass::Auth.is_retryable());
        assert!(!ErrorClass::ClientError.is_retryable());
    }
}
