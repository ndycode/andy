#![forbid(unsafe_code)]

pub mod cron;
pub mod inbound;
pub mod outbound;
pub mod routes;
pub mod service;

pub use routes::{AppState, router};

/// Install the process-wide JSON tracing subscriber, honoring `RUST_LOG` via
/// `EnvFilter` (defaulting to `info`). `vercel_runtime` does not install one,
/// so without this every `error!`/`warn!` on the money failure paths is
/// silently dropped in production. Uses `try_init` so it is a no-op if a
/// subscriber is already set (e.g. across tests or repeated cold starts).
pub fn init_tracing() {
    use tracing_subscriber::{EnvFilter, fmt};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().json().with_env_filter(filter).try_init();
}
