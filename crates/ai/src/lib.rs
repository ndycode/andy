#![forbid(unsafe_code)]

pub mod agent;
pub mod finance_tools;
pub mod model;
pub mod openrouter;
pub mod policy;

pub use agent::{RunAgentInput, RunAgentOutput, run_agent};
pub use finance_tools::AgentSnapshot;
pub use model::{DEFAULT_MODEL_ID, ModelConfig, resolve_model_config};
pub use openrouter::{OpenRouterClient, openrouter_from_env};
pub use policy::{ConfirmReply, PolicySettings, WriteRisk, classify_writes, confirm_reply};
