pub mod config;
pub mod db;
pub mod error;
pub mod ffmpeg;
pub mod filmstrip_layout;
pub mod models;
pub mod paths;
pub mod routes;
pub mod state;

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

    Ok(Arc::new(AppState { pool, config }))
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
