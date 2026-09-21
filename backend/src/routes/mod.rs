mod auth;
mod exports;
pub(crate) mod gifs;
mod profiles;
mod videos;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post, put};

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
        .route("/exports", post(exports::create_export))
        .route("/exports/{id}/progress", get(exports::export_progress))
        .route("/gifs", get(gifs::list_gifs))
        .route("/gifs/import", post(gifs::import_gifs))
        .route("/gifs/link", post(gifs::link_gif))
        .route(
            "/gifs/{id}",
            get(gifs::get_gif).patch(gifs::rename_gif).delete(gifs::delete_gif),
        )
}
