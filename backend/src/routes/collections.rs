//! Collections endpoints (collections-design/COLLECTIONS.md): named,
//! unordered groupings of gifs. Every user has exactly one `kind =
//! "favourites"` collection (reserved name, can't be renamed or deleted)
//! plus however many custom ones they create. The dedicated
//! `/gifs/{id}/favourite` star endpoints (`routes::gifs`) keep working
//! unchanged — they're a one-click shortcut onto this same mechanism.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::StatusCode;
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::auth::CurrentUser;
use crate::db;
use crate::error::AppError;
use crate::models::{Collection, CollectionWithCount};
use crate::routes::gifs::{LibraryEntry, with_urls};
use crate::state::AppState;

const MAX_NAME_LEN: usize = 40;
const RESERVED_NAME: &str = "favourites";

/// Shared by create/rename: trims, enforces the 1-40 char bound, and
/// rejects "Favourites" (case-insensitive) as a name for a *custom*
/// collection — the reserved word is only ever carried by the one row
/// `kind = 'favourites'` already owns.
fn validate_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("Name can't be empty.".to_string()));
    }
    if trimmed.chars().count() > MAX_NAME_LEN {
        return Err(AppError::BadRequest(format!(
            "Name can't be longer than {MAX_NAME_LEN} characters."
        )));
    }
    if trimmed.to_lowercase() == RESERVED_NAME {
        return Err(AppError::BadRequest("'Favourites' is reserved.".to_string()));
    }
    Ok(trimmed)
}

/// `GET /api/collections` — the caller's collections, Favourites first
/// then alphabetical, each with a count of its currently-visible gifs. A
/// caller who's never favourited or created anything gets an empty list
/// — the frontend renders the fixed "All GIFs"/"Favourites" sidebar rows
/// regardless (collections-design/COLLECTIONS.md §2); the Favourites row
/// in `collections` only springs into existence on first actual use
/// (`db::get_or_create_favourites_collection`, called from the
/// favourite/save-to-collection write paths, not from this read).
pub async fn list_collections(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
) -> Result<Json<Vec<CollectionWithCount>>, AppError> {
    let collections = db::list_collections(&state.pool, &user.id).await?;
    Ok(Json(collections))
}

#[derive(Debug, Deserialize)]
pub struct CreateCollectionRequest {
    name: String,
}

/// `POST /api/collections` (collections-design/COLLECTIONS.md §4).
pub async fn create_collection(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    Json(request): Json<CreateCollectionRequest>,
) -> Result<(StatusCode, Json<Collection>), AppError> {
    let name = validate_name(&request.name)?;
    let now = Utc::now().to_rfc3339();
    let collection = db::create_collection(&state.pool, &user.id, &name, &now)
        .await?
        .ok_or_else(|| AppError::Conflict(format!("You already have a collection called '{name}'.")))?;
    Ok((StatusCode::CREATED, Json(collection)))
}

#[derive(Debug, Deserialize)]
pub struct RenameCollectionRequest {
    name: String,
}

/// `PATCH /api/collections/{id}` — rejects the Favourites collection
/// outright (404-style ownership check passes, but it's not renameable),
/// same server-side enforcement style as template-sharing's
/// creator-only guard.
pub async fn rename_collection(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
    Json(request): Json<RenameCollectionRequest>,
) -> Result<Json<Collection>, AppError> {
    let collection = db::get_collection(&state.pool, &id, &user.id).await?.ok_or(AppError::NotFound)?;
    if collection.is_favourites() {
        return Err(AppError::Forbidden("Favourites can't be renamed.".to_string()));
    }
    let name = validate_name(&request.name)?;
    let now = Utc::now().to_rfc3339();
    let renamed = db::rename_collection(&state.pool, &id, &user.id, &name, &now)
        .await?
        .ok_or_else(|| AppError::Conflict(format!("You already have a collection called '{name}'.")))?;
    Ok(Json(renamed))
}

/// `DELETE /api/collections/{id}` — drops only the collection and its
/// membership rows; the gifs stay in the library and in any other
/// collection they're also in. Favourites can't be deleted.
pub async fn delete_collection(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<StatusCode, AppError> {
    let collection = db::get_collection(&state.pool, &id, &user.id).await?.ok_or(AppError::NotFound)?;
    if collection.is_favourites() {
        return Err(AppError::Forbidden("Favourites can't be deleted.".to_string()));
    }
    db::delete_collection(&state.pool, &id, &user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
pub struct ListCollectionGifsQuery {
    q: Option<String>,
}

/// `GET /api/collections/{id}/gifs` — same attributed shape as `GET
/// /api/favourites`/`GET /api/library`, filtered to gifs still visible to
/// the caller.
pub async fn list_collection_gifs(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
    Query(query): Query<ListCollectionGifsQuery>,
) -> Result<Json<Vec<LibraryEntry>>, AppError> {
    db::get_collection(&state.pool, &id, &user.id).await?.ok_or(AppError::NotFound)?;
    let gifs = db::list_collection_gifs(&state.pool, &id, &user.id, query.q.as_deref()).await?;
    let template_ids: Vec<String> = gifs.iter().filter_map(|g| g.template_id.clone()).collect();
    let remixable = db::remixable_template_ids(&state.pool, &template_ids, Some(&user.id)).await?;
    let entries = gifs
        .into_iter()
        .map(|public_gif| {
            let owner_handle = public_gif.owner_handle.clone();
            let owner_slug = public_gif.owner_slug.clone();
            let template_remixable = public_gif.template_id.as_deref().is_some_and(|id| remixable.contains(id));
            // Every row here is, by definition, visible to the caller
            // right now (list_collection_gifs already filtered on that) —
            // is_favourited still needs its own lookup since membership
            // in *this* collection says nothing about Favourites.
            with_urls(public_gif.into(), &state.storage, true, template_remixable)
                .map(|gif| LibraryEntry::new(gif, owner_handle, owner_slug))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json(entries))
}

/// `POST /api/collections/{id}/gifs/{gifId}` (collections-design/
/// COLLECTIONS.md §3's "Save to collection" picker) — idempotent. Checks
/// the collection is the caller's, then that the gif is currently visible
/// to them (own, or public) — the same eligibility rule Favourites always
/// enforced, now shared across every collection.
pub async fn add_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath((id, gif_id)): AxPath<(String, String)>,
) -> Result<StatusCode, AppError> {
    db::get_collection(&state.pool, &id, &user.id).await?.ok_or(AppError::NotFound)?;
    db::get_favouritable_gif(&state.pool, &gif_id, &user.id).await?.ok_or(AppError::NotFound)?;
    db::add_gif_to_collection(&state.pool, &id, &gif_id, &Utc::now().to_rfc3339()).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/collections/{id}/gifs/{gifId}` — idempotent; always
/// allowed on a collection you own, even for a gif you can no longer see.
pub async fn remove_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath((id, gif_id)): AxPath<(String, String)>,
) -> Result<StatusCode, AppError> {
    db::get_collection(&state.pool, &id, &user.id).await?.ok_or(AppError::NotFound)?;
    db::remove_gif_from_collection(&state.pool, &id, &gif_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GifCollectionsResponse {
    collection_ids: Vec<String>,
}

/// `GET /api/gifs/{id}/collections` — which of the *caller's own*
/// collections this gif is in, for the detail panel's "In collections"
/// chips and the "Save to collection" picker's checked state.
pub async fn collections_for_gif(
    State(state): State<Arc<AppState>>,
    CurrentUser(user): CurrentUser,
    AxPath(id): AxPath<String>,
) -> Result<Json<GifCollectionsResponse>, AppError> {
    let collection_ids = db::collection_ids_for_gif(&state.pool, &user.id, &id).await?;
    Ok(Json(GifCollectionsResponse { collection_ids }))
}
