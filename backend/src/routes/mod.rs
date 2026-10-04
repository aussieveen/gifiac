mod admin;
mod auth;
mod config;
mod exports;
pub(crate) mod gifs;
mod internal;
mod preferences;
mod profiles;
mod templates;
pub(crate) mod videos;

use std::sync::Arc;

use axum::Router;
use axum::routing::{delete, get, patch, post, put};

use crate::state::AppState;

pub fn api_router() -> Router<Arc<AppState>> {
    Router::new()
        // TEMPORARY, local-review-only — see routes::auth::dev_login's doc
        // comment. Remove before committing anything.
        .route("/auth/dev-login", get(auth::dev_login))
        .route("/auth/login", get(auth::login))
        .route("/auth/callback", get(auth::callback))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/auth/email/start", post(auth::email_start))
        .route("/auth/email/verify", post(auth::email_verify))
        .route("/config", get(config::get_config))
        .route("/users/me/handle", put(profiles::set_handle))
        .route("/profiles/{handle}", get(profiles::get_profile))
        .route("/library", get(gifs::list_library))
        .route(
            "/videos",
            get(videos::list_videos).post(videos::upload_video),
        )
        .route(
            "/videos/{id}",
            get(videos::get_video).delete(videos::delete_video),
        )
        .route("/videos/{job_id}/ingest-progress", get(videos::ingest_progress))
        .route("/videos/{id}/file", get(videos::get_video_file))
        .route("/videos/{id}/thumbnail", get(videos::get_thumbnail))
        .route("/videos/{id}/filmstrip", get(videos::get_filmstrip_meta))
        .route(
            "/videos/{id}/filmstrip.jpg",
            get(videos::get_filmstrip_image),
        )
        .route(
            "/videos/{id}/template",
            get(videos::get_template)
                .put(videos::put_template)
                .delete(videos::delete_template),
        )
        .route("/exports", post(exports::create_export))
        .route("/exports/{id}/progress", get(exports::export_progress))
        .route("/internal/callbacks/ingest", post(internal::ingest_callback))
        .route("/internal/callbacks/export", post(internal::export_callback))
        .route("/templates/mine", get(templates::list_mine))
        .route("/templates/others", get(templates::list_others))
        .route(
            "/templates/{id}",
            get(templates::get_one).patch(templates::patch_one).delete(templates::delete_one),
        )
        .route("/templates/{id}/clip", get(templates::get_clip))
        .route("/templates/{id}/thumbnail", get(templates::get_thumbnail))
        .route("/templates/{id}/filmstrip.jpg", get(templates::get_filmstrip_image))
        .route("/templates/{id}/meta", get(templates::get_filmstrip_meta))
        .route("/templates/{id}/exports", post(exports::create_template_export))
        .route("/gifs", get(gifs::list_gifs))
        .route("/gifs/import", post(gifs::import_gifs))
        .route("/gifs/link", post(gifs::link_gif))
        .route(
            "/gifs/{id}",
            get(gifs::get_gif).patch(gifs::rename_gif).delete(gifs::delete_gif),
        )
        .route("/gifs/{id}/use", post(gifs::use_gif))
        .route(
            "/gifs/{id}/favourite",
            post(gifs::favourite_gif).delete(gifs::unfavourite_gif),
        )
        .route("/favourites", get(gifs::list_favourites))
        .route("/preferences", put(preferences::update_preferences))
        .route("/admin/users", get(admin::list_users))
        .route("/admin/users/{id}", patch(admin::set_user_disabled).delete(admin::delete_user))
        .route("/admin/users/{id}/gifs", get(admin::list_user_gifs))
        .route("/admin/users/{id}/templates", get(admin::list_user_templates))
        .route("/admin/gifs/{id}", delete(admin::delete_gif))
        .route("/admin/gifs/{id}/unpublish", post(admin::unpublish_gif))
        .route("/admin/templates/{id}", delete(admin::delete_template))
        .route("/admin/actions", get(admin::list_actions))
}
