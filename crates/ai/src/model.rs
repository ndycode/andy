use thiserror::Error;

pub const DEFAULT_MODEL_ID: &str = "openai/gpt-oss-120b:free";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelConfig {
    pub model_id: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ModelConfigError {
    #[error(
        "OPENROUTER_MODEL must be an OpenRouter free model id ending in \":free\"; got \"{0}\""
    )]
    NonFreeModel(String),
    #[error(
        "OPENROUTER_FALLBACK_MODELS is no longer supported; set one free OpenRouter model with OPENROUTER_MODEL."
    )]
    FallbackModelsUnsupported,
}

pub fn resolve_model_config(
    openrouter_model: Option<&str>,
    fallback_models: Option<&str>,
) -> Result<ModelConfig, ModelConfigError> {
    if let Some(raw) = fallback_models.map(str::trim)
        && !raw.is_empty()
        && !raw.eq_ignore_ascii_case("none")
        && !raw.eq_ignore_ascii_case("off")
    {
        return Err(ModelConfigError::FallbackModelsUnsupported);
    }

    let model_id = openrouter_model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_MODEL_ID)
        .to_string();

    if !model_id.ends_with(":free") {
        return Err(ModelConfigError::NonFreeModel(model_id));
    }

    Ok(ModelConfig { model_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_verified_free_model() {
        assert_eq!(
            resolve_model_config(None, None).unwrap(),
            ModelConfig {
                model_id: "openai/gpt-oss-120b:free".into()
            }
        );
    }

    #[test]
    fn rejects_paid_model_and_fallback_chain() {
        assert_eq!(
            resolve_model_config(Some("openai/gpt-oss-120b"), None),
            Err(ModelConfigError::NonFreeModel("openai/gpt-oss-120b".into()))
        );
        assert_eq!(
            resolve_model_config(None, Some("openai/gpt-oss-20b:free")),
            Err(ModelConfigError::FallbackModelsUnsupported)
        );
    }
}
