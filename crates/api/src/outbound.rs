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
                error = %err
            );
            mark_outbound_failed(pool, message.id, &err.to_string()).await?;
            Ok(false)
        }
    }
}
