#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Local-dev-only — missing in production, where real env vars are
    // injected directly into the container (see backend/Cargo.toml).
    let _ = dotenvy::from_filename(".env.local");
    tracing_subscriber::fmt::init();
    gifiac_backend::run().await
}
