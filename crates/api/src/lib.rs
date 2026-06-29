#![forbid(unsafe_code)]

pub mod cron;
pub mod inbound;
pub mod outbound;
pub mod routes;

pub use routes::{AppState, router};
