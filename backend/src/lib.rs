pub mod ass;
pub mod config;
pub mod db;
pub mod error;
pub mod exports;
pub mod ffmpeg;
pub mod filmstrip_layout;
pub mod models;
pub mod paths;
pub mod routes;
pub mod scale;
pub mod state;
pub mod storage;

use std::sync::Arc;

use axum::Router;
use tower_http::trace::TraceLayer;

use config::Config;
use state::AppState;

pub async fn build_state() -> anyhow::Result<Arc<AppState>> {
    let config = Config::from_env();
    std::fs::create_dir_all(&config.video_dir)?;

    let pool = db::create_pool(&config.db_path).await?;
    db::run_migrations(&pool).await?;

    let r2 = storage::R2Config::from_env()?;
    let storage = storage::Storage::new(
        &r2.endpoint_url(),
        &r2.bucket_name,
        &r2.public_base_url,
        &r2.access_key_id,
        &r2.secret_access_key,
    );

    Ok(Arc::new(AppState {
        pool,
        config,
        storage,
        export_jobs: Default::default(),
    }))
}

pub fn build_app(state: Arc<AppState>) -> Router {
    Router::new()
        .nest("/api", routes::api_router())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

pub async fn run() -> anyhow::Result<()> {
    let state = build_state().await?;
    let port = state.config.port;
    let app = build_app(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;

    Ok(())
}
