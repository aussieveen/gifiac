mod admin;
mod auth;
mod exports;
pub(crate) mod gifs;
mod profiles;
mod templates;
pub(crate) mod videos;

use std::sync::Arc;

use axum::Router;
use axum::routing::{delete, get, patch, post, put};

use crate::state::AppState;

pub fn api_router() -> Router<Arc<AppState>> {
    Router::new()
        .route("/auth/login", get(auth::login))
        .route("/auth/callback", get(auth::callback))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
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
        .route("/videos/{id}/template/meta", get(videos::get_template_meta))
        .route("/exports", post(exports::create_export))
        .route("/exports/{id}/progress", get(exports::export_progress))
        .route("/gifs", get(gifs::list_gifs))
        .route("/gifs/import", post(gifs::import_gifs))
        .route("/gifs/link", post(gifs::link_gif))
        .route(
            "/gifs/{id}",
            get(gifs::get_gif).patch(gifs::rename_gif).delete(gifs::delete_gif),
        )
        .route("/gifs/{id}/use", post(gifs::use_gif))
        .route("/templates", get(templates::list_templates))
        .route(
            "/templates/{id}",
            get(templates::get_template).patch(templates::set_template_public),
        )
        .route("/templates/{id}/clip", get(templates::get_template_clip))
        .route("/templates/{id}/thumbnail", get(templates::get_template_thumbnail))
        .route("/templates/{id}/filmstrip", get(templates::get_template_filmstrip_meta))
        .route(
            "/templates/{id}/filmstrip.jpg",
            get(templates::get_template_filmstrip_image),
        )
        .route("/admin/users", get(admin::list_users))
        .route("/admin/users/{id}", patch(admin::set_user_disabled))
        .route("/admin/users/{id}/gifs", get(admin::list_user_gifs))
        .route("/admin/users/{id}/templates", get(admin::list_user_templates))
        .route("/admin/gifs/{id}", delete(admin::delete_gif))
        .route("/admin/gifs/{id}/unpublish", post(admin::unpublish_gif))
        .route("/admin/templates/{id}", delete(admin::delete_template))
        .route("/admin/templates/{id}/unpublish", post(admin::unpublish_template))
}
