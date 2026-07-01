#![forbid(unsafe_code)]

use tower::Layer;

#[tokio::main]
async fn main() -> Result<(), vercel_runtime::Error> {
    andy_api::init_tracing();
    let app = andy_api::router(andy_api::AppState::production_lazy());
    let service = vercel_runtime::axum::VercelLayer::new().layer(app);
    vercel_runtime::run(service).await
}
