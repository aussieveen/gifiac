//! `GET /api/config` — the small set of public, non-secret runtime values
//! the frontend needs before it's signed in (SPEC-EMAIL-AUTH.md §6/§9):
//! today, just the Cloudflare Turnstile site key. Read from env at
//! startup and served at runtime rather than baked into the frontend
//! bundle at build time — the Docker image builds the frontend once and
//! ships it to every deploy, so a build-time value would need a new image
//! build to rotate; this way rotating the key is just an env var change.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;

use crate::models::PublicConfig;
use crate::state::AppState;

pub async fn get_config(State(state): State<Arc<AppState>>) -> Json<PublicConfig> {
    Json(PublicConfig {
        turnstile_site_key: state.email_auth.turnstile_site_key.clone(),
        max_gif_bytes: crate::MAX_GIF_BYTES as u64,
    })
}
