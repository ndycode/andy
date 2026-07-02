#![forbid(unsafe_code)]

pub mod allowlist;
pub mod analytics;
pub mod budget;
pub mod categories;
pub mod date_validation;
pub mod dedup;
pub mod domain;
pub mod env;
pub mod errors;
pub mod expense_category;
pub mod goals;
pub mod memory;
pub mod money;
pub mod percent;
pub mod security;
pub mod time;

pub use categories::{Category, coerce_category};
