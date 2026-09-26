//! `PUT /api/preferences` — the Preferences page's one write endpoint.
//! Reads are bundled onto `GET /api/auth/me` instead (see
//! `models::CurrentUserView`) rather than a separate `GET /api/preferences`
//! — every place that already fetches the current user (e.g. a gif grid
//! deciding whether to render hover-preview mode) gets the preference for
//! free, no second round-trip.

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use chrono::Utc;

use crate::auth::CurrentUser;
use crate::db;
use crate::error::AppError;
use crate::models::{PreferencesView, UpdatePreferencesRequest};
use crate::state::AppState;

pub async fn update_preferences(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Json(request): Json<UpdatePreferencesRequest>,
) -> Result<Json<PreferencesView>, AppError> {
    let updated = db::update_preferences(&state.pool, &user.id, &request, &Utc::now().to_rfc3339()).await?;
    Ok(Json(updated))
}
