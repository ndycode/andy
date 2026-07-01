use std::env;
use thiserror::Error;

use crate::time::{AppTimeConfig, APP_TIMEZONE_DEFAULT, MANILA_OFFSET_MINUTES};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Env {
    pub database_url: String,
    pub sendblue_api_key: String,
    pub sendblue_api_secret: String,
    pub sendblue_from_number: String,
    pub webhook_url_token: String,
    /// Optional lowercase hex SHA-256 of the webhook token. When set, the
    /// inbound webhook verifies `sha256(query token)` against this instead of
    /// comparing the raw token, so the plaintext token need not live in env.
    pub webhook_url_token_sha256: Option<String>,
    pub cron_secret: String,
    pub allowed_phone: String,
    pub openrouter_api_key: Option<String>,
    pub openrouter_model: Option<String>,
    /// Optional base URL for an OpenRouter-compatible endpoint (proxy or
    /// self-host). Defaults to the public OpenRouter API when unset. Kept here
    /// so tests can redirect model traffic to a local mock without env reads
    /// buried in helpers.
    pub openrouter_base_url: Option<String>,
    pub app_timezone: String,
    pub app_timezone_offset_minutes: i32,
    /// Writes at or above this centavo amount require explicit user
    /// confirmation before they are committed. `None` falls back to the
    /// policy default.
    pub confirm_amount_threshold_centavos: Option<i64>,
    /// Max inbound webhook requests per window before returning 429. `None`
    /// falls back to the durable limiter default.
    pub inbound_rate_limit: Option<i64>,
    /// Inbound rate-limit window length in seconds. `None` falls back to the
    /// durable limiter default.
    pub inbound_rate_window_seconds: Option<i64>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EnvError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("APP_TIMEZONE_OFFSET_MINUTES must be an integer between -840 and 840")]
    InvalidOffset,
    #[error("WEBHOOK_URL_TOKEN_SHA256 must be a 64-character lowercase hex SHA-256 digest")]
    InvalidTokenHash,
}

impl Env {
    pub fn from_process() -> Result<Self, EnvError> {
        Self::from_getter(|key| env::var(key).ok())
    }

    pub fn from_getter(mut get: impl FnMut(&str) -> Option<String>) -> Result<Self, EnvError> {
        let app_timezone = get("APP_TIMEZONE")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| APP_TIMEZONE_DEFAULT.to_string());
        let app_timezone_offset_minutes = match get("APP_TIMEZONE_OFFSET_MINUTES") {
            Some(raw) if !raw.trim().is_empty() => raw
                .trim()
                .parse::<i32>()
                .ok()
                .filter(|mins| mins.abs() <= 14 * 60)
                .ok_or(EnvError::InvalidOffset)?,
            _ => MANILA_OFFSET_MINUTES,
        };

        let webhook_url_token_sha256 = match optional(&mut get, "WEBHOOK_URL_TOKEN_SHA256") {
            Some(raw) => Some(normalize_token_hash(&raw)?),
            None => None,
        };
        // When a hash is configured the raw token is optional; otherwise it
        // stays required so a misconfiguration can never silently disable auth.
        let webhook_url_token = match optional(&mut get, "WEBHOOK_URL_TOKEN") {
            Some(token) => token,
            None if webhook_url_token_sha256.is_some() => String::new(),
            None => return Err(EnvError::Missing("WEBHOOK_URL_TOKEN")),
        };

        let confirm_amount_threshold_centavos =
            optional_i64(&mut get, "ANDY_CONFIRM_AMOUNT_THRESHOLD_CENTAVOS");
        let inbound_rate_limit = optional_i64(&mut get, "ANDY_INBOUND_RATE_LIMIT");
        let inbound_rate_window_seconds =
            optional_i64(&mut get, "ANDY_INBOUND_RATE_WINDOW_SECONDS");

        Ok(Self {
            database_url: required(&mut get, "DATABASE_URL")?,
            sendblue_api_key: required(&mut get, "SENDBLUE_API_KEY")?,
            sendblue_api_secret: required(&mut get, "SENDBLUE_API_SECRET")?,
            sendblue_from_number: required(&mut get, "SENDBLUE_FROM_NUMBER")?,
            webhook_url_token,
            webhook_url_token_sha256,
            cron_secret: required(&mut get, "CRON_SECRET")?,
            allowed_phone: required(&mut get, "ALLOWED_PHONE")?,
            openrouter_api_key: optional(&mut get, "OPENROUTER_API_KEY"),
            openrouter_model: optional(&mut get, "OPENROUTER_MODEL"),
            openrouter_base_url: optional(&mut get, "OPENROUTER_BASE_URL"),
            app_timezone,
            app_timezone_offset_minutes,
            confirm_amount_threshold_centavos,
            inbound_rate_limit,
            inbound_rate_window_seconds,
        })
    }

    /// The app clock built from the already-validated timezone fields. This is
    /// the single source of truth for date math config — callers holding an
    /// [`Env`] should use this instead of re-reading process env.
    #[must_use]
    pub fn time_config(&self) -> AppTimeConfig {
        AppTimeConfig::new(self.app_timezone.clone(), self.app_timezone_offset_minutes)
    }
}

fn required(
    get: &mut impl FnMut(&str) -> Option<String>,
    key: &'static str,
) -> Result<String, EnvError> {
    optional(get, key).ok_or(EnvError::Missing(key))
}

fn optional(get: &mut impl FnMut(&str) -> Option<String>, key: &str) -> Option<String> {
    get(key).filter(|value| !value.trim().is_empty())
}

fn optional_i64(get: &mut impl FnMut(&str) -> Option<String>, key: &str) -> Option<i64> {
    optional(get, key).and_then(|raw| raw.trim().parse::<i64>().ok())
}

/// Validate and normalize a hex SHA-256 digest to lowercase. Rejects anything
/// that is not exactly 64 hex characters so a malformed value cannot silently
/// become an unmatchable (and therefore auth-disabling) hash.
fn normalize_token_hash(raw: &str) -> Result<String, EnvError> {
    let trimmed = raw.trim();
    if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(trimmed.to_ascii_lowercase())
    } else {
        Err(EnvError::InvalidTokenHash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn requires_production_secrets_but_keeps_openrouter_optional() {
        let values = HashMap::from([
            ("DATABASE_URL", "postgres://x"),
            ("SENDBLUE_API_KEY", "k"),
            ("SENDBLUE_API_SECRET", "s"),
            ("SENDBLUE_FROM_NUMBER", "+1"),
            ("WEBHOOK_URL_TOKEN", "t"),
            ("CRON_SECRET", "c"),
            ("ALLOWED_PHONE", "+1"),
        ]);
        let env = Env::from_getter(|key| values.get(key).map(ToString::to_string)).unwrap();
        assert_eq!(env.openrouter_api_key, None);
        assert_eq!(env.app_timezone, "Asia/Manila");
        assert_eq!(env.app_timezone_offset_minutes, 480);
        assert_eq!(env.webhook_url_token_sha256, None);
        assert_eq!(env.confirm_amount_threshold_centavos, None);
    }

    fn base() -> HashMap<&'static str, String> {
        HashMap::from([
            ("DATABASE_URL", "postgres://x".to_string()),
            ("SENDBLUE_API_KEY", "k".to_string()),
            ("SENDBLUE_API_SECRET", "s".to_string()),
            ("SENDBLUE_FROM_NUMBER", "+1".to_string()),
            ("CRON_SECRET", "c".to_string()),
            ("ALLOWED_PHONE", "+1".to_string()),
        ])
    }

    #[test]
    fn raw_token_required_without_hash() {
        let env = Env::from_getter(|key| base().get(key).cloned());
        assert_eq!(env, Err(EnvError::Missing("WEBHOOK_URL_TOKEN")));
    }

    #[test]
    fn hash_alone_satisfies_token_requirement() {
        let mut values = base();
        let hash = "a".repeat(64);
        values.insert("WEBHOOK_URL_TOKEN_SHA256", hash.clone());
        let env = Env::from_getter(|key| values.get(key).cloned()).unwrap();
        assert_eq!(env.webhook_url_token, "");
        assert_eq!(env.webhook_url_token_sha256, Some(hash));
    }

    #[test]
    fn malformed_token_hash_is_rejected() {
        let mut values = base();
        values.insert("WEBHOOK_URL_TOKEN", "t".to_string());
        values.insert("WEBHOOK_URL_TOKEN_SHA256", "not-a-hash".to_string());
        let env = Env::from_getter(|key| values.get(key).cloned());
        assert_eq!(env, Err(EnvError::InvalidTokenHash));
    }

    #[test]
    fn parses_optional_numeric_thresholds() {
        let mut values = base();
        values.insert("WEBHOOK_URL_TOKEN", "t".to_string());
        values.insert(
            "ANDY_CONFIRM_AMOUNT_THRESHOLD_CENTAVOS",
            "5000000".to_string(),
        );
        values.insert("ANDY_INBOUND_RATE_LIMIT", "120".to_string());
        values.insert("ANDY_INBOUND_RATE_WINDOW_SECONDS", "30".to_string());
        let env = Env::from_getter(|key| values.get(key).cloned()).unwrap();
        assert_eq!(env.confirm_amount_threshold_centavos, Some(5_000_000));
        assert_eq!(env.inbound_rate_limit, Some(120));
        assert_eq!(env.inbound_rate_window_seconds, Some(30));
    }

    #[test]
    fn invalid_offset_fails_once_at_env() {
        // The offset is validated exactly once, at Env construction — a bad
        // value is a hard error rather than a silent fallback parsed twice.
        let mut values = base();
        values.insert("WEBHOOK_URL_TOKEN", "t".to_string());
        values.insert("APP_TIMEZONE_OFFSET_MINUTES", "not-a-number".to_string());
        let env = Env::from_getter(|key| values.get(key).cloned());
        assert_eq!(env, Err(EnvError::InvalidOffset));
    }

    #[test]
    fn time_config_reflects_validated_fields() {
        let mut values = base();
        values.insert("WEBHOOK_URL_TOKEN", "t".to_string());
        values.insert("APP_TIMEZONE", "UTC".to_string());
        values.insert("APP_TIMEZONE_OFFSET_MINUTES", "0".to_string());
        let env = Env::from_getter(|key| values.get(key).cloned()).unwrap();
        let cfg = env.time_config();
        assert_eq!(cfg.label, "UTC");
        assert_eq!(cfg.offset_minutes, 0);
    }
}
