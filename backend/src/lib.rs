pub mod ass;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod exports;
pub mod ffmpeg;
pub mod filmstrip_layout;
pub mod handle;
pub mod link_check;
pub mod models;
pub mod paths;
pub mod routes;
pub mod scale;
pub mod source_video;
pub mod state;
pub mod storage;
pub mod thumbnails;

use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use config::Config;
use state::AppState;

/// Where the built frontend (`frontend/dist`, per SPEC.md §1: "built to
/// static files ... served by the same Axum binary") lives at runtime —
/// relative to the process's working directory, which the Dockerfile fixes
/// by `WORKDIR`ing to the same place it copies the built assets into. In
/// local dev this directory just doesn't exist (the frontend is served by
/// Vite on :5173 instead, proxying `/api` back to this server — see
/// frontend/vite.config.ts) — `ServeDir` 404s per-request rather than
/// failing at startup, so that's harmless.
const STATIC_DIR: &str = "static";

/// Axum's `Multipart` extractor otherwise caps request bodies at 2MB, far
/// too small for a video upload — 200MB comfortably covers "at least
/// 100MB, even though that's unlikely" per the user's ask.
const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024;

pub async fn build_state() -> anyhow::Result<Arc<AppState>> {
    let config = Config::from_env();
    std::fs::create_dir_all(&config.video_dir)?;

    let pool = db::create_pool(&config.database_url).await?;
    db::run_migrations(&pool).await?;

    let r2 = storage::R2Config::from_env()?;
    let storage = storage::Storage::new(
        &r2.endpoint_url(),
        &r2.bucket_name,
        Some(&r2.public_base_url),
        &r2.access_key_id,
        &r2.secret_access_key,
    );

    let source_videos = storage::SourceStorageConfig::from_env()?;
    let source_storage = storage::Storage::new_for_source_bucket(&source_videos).await;

    let http_client = link_check::build_client()?;
    let google_auth = auth::GoogleAuthConfig::from_env()?;

    Ok(Arc::new(AppState {
        pool,
        config,
        storage,
        source_storage,
        http_client,
        google_auth,
        export_jobs: Default::default(),
    }))
}

pub fn build_app(state: Arc<AppState>) -> Router {
    Router::new()
        .nest("/api", routes::api_router())
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
        // Anything not under /api. `ServeDir` alone only serves index.html
        // for a directory-root request (`/`) — since the frontend is now a
        // real client-side router (multiple paths, not one view-switching
        // page), a deep link like `/library` or a refresh on one 404s
        // without this: `not_found_service` falls back to index.html for
        // any path ServeDir can't match to a real static file, letting the
        // client-side router take over from there.
        .fallback_service(
            ServeDir::new(STATIC_DIR).not_found_service(ServeFile::new(format!("{STATIC_DIR}/index.html"))),
        )
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
