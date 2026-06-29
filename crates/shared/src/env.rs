use std::env;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Env {
    pub database_url: String,
    pub sendblue_api_key: String,
    pub sendblue_api_secret: String,
    pub sendblue_from_number: String,
    pub webhook_url_token: String,
    pub cron_secret: String,
    pub allowed_phone: String,
    pub openrouter_api_key: Option<String>,
    pub openrouter_model: Option<String>,
    pub app_timezone: String,
    pub app_timezone_offset_minutes: i32,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EnvError {
    #[error("{0} is required")]
    Missing(&'static str),
    #[error("APP_TIMEZONE_OFFSET_MINUTES must be an integer between -840 and 840")]
    InvalidOffset,
}

impl Env {
    pub fn from_process() -> Result<Self, EnvError> {
        Self::from_getter(|key| env::var(key).ok())
    }

    pub fn from_getter(mut get: impl FnMut(&str) -> Option<String>) -> Result<Self, EnvError> {
        let app_timezone = get("APP_TIMEZONE")
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Asia/Manila".to_string());
        let app_timezone_offset_minutes = match get("APP_TIMEZONE_OFFSET_MINUTES") {
            Some(raw) if !raw.trim().is_empty() => raw
                .trim()
                .parse::<i32>()
                .ok()
                .filter(|mins| mins.abs() <= 14 * 60)
                .ok_or(EnvError::InvalidOffset)?,
            _ => 480,
        };

        Ok(Self {
            database_url: required(&mut get, "DATABASE_URL")?,
            sendblue_api_key: required(&mut get, "SENDBLUE_API_KEY")?,
            sendblue_api_secret: required(&mut get, "SENDBLUE_API_SECRET")?,
            sendblue_from_number: required(&mut get, "SENDBLUE_FROM_NUMBER")?,
            webhook_url_token: required(&mut get, "WEBHOOK_URL_TOKEN")?,
            cron_secret: required(&mut get, "CRON_SECRET")?,
            allowed_phone: required(&mut get, "ALLOWED_PHONE")?,
            openrouter_api_key: optional(&mut get, "OPENROUTER_API_KEY"),
            openrouter_model: optional(&mut get, "OPENROUTER_MODEL"),
            app_timezone,
            app_timezone_offset_minutes,
        })
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
    }
}
