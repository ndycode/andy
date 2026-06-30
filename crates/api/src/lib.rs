#![forbid(unsafe_code)]

pub mod cron;
pub mod inbound;
pub mod outbound;
pub mod routes;
pub mod service;

pub use routes::{AppState, router};
