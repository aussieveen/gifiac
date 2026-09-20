//! Handle assignment and public profile pages (SPEC-CLOUD.md §5).

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as AxPath, State};
use serde::{Deserialize, Serialize};

use crate::auth::CurrentUser;
use crate::db;
use crate::error::AppError;
use crate::handle;
use crate::models::CurrentUserView;
use crate::routes::gifs::{GifResponse, with_urls};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct SetHandleRequest {
    handle: String,
}

/// `PUT /api/users/me/handle` — a handle can only ever be set once
/// (SPEC-CLOUD.md §5: "locked permanently once set"); a second attempt,
/// or one that collides with someone else's, both 409.
pub async fn set_handle(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Json(request): Json<SetHandleRequest>,
) -> Result<Json<CurrentUserView>, AppError> {
    let requested = request.handle.trim().to_lowercase();
    if !handle::is_valid(&requested) {
        return Err(AppError::BadRequest(
            "handle must be 2-30 lowercase letters, digits, or single hyphens".to_string(),
        ));
    }

    if !db::set_handle(&state.pool, &user.id, &requested).await? {
        return Err(AppError::Conflict(
            "handle already set, or already taken".to_string(),
        ));
    }

    let updated = db::get_user(&state.pool, &user.id)
        .await?
        .ok_or(AppError::NotFound)?;
    Ok(Json(updated.into()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileResponse {
    handle: String,
    avatar_url: Option<String>,
    gifs: Vec<GifResponse>,
}

/// `GET /api/profiles/{handle}` — public, no auth required. Only a
/// user's public gifs show here (SPEC-CLOUD.md §5) — templates join once
/// they're servable independently of video ownership (M5d).
pub async fn get_profile(
    State(state): State<Arc<AppState>>,
    AxPath(handle): AxPath<String>,
) -> Result<Json<ProfileResponse>, AppError> {
    let user = db::get_user_by_handle(&state.pool, &handle)
        .await?
        .ok_or(AppError::NotFound)?;

    let gifs = db::list_public_gifs_by_user(&state.pool, &user.id)
        .await?
        .into_iter()
        .map(|gif| with_urls(gif, &state.storage))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(ProfileResponse {
        handle,
        avatar_url: user.avatar_url,
        gifs,
    }))
}
