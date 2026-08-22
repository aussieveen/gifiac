mod exports;
mod gifs;
mod videos;

use std::sync::Arc;

use axum::Router;
use axum::routing::{get, post};

use crate::state::AppState;

pub fn api_router() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/videos",
            get(videos::list_videos).post(videos::upload_video),
        )
        .route("/videos/{id}", get(videos::get_video))
        .route("/videos/{id}/file", get(videos::get_video_file))
        .route("/videos/{id}/thumbnail", get(videos::get_thumbnail))
        .route("/videos/{id}/filmstrip", get(videos::get_filmstrip_meta))
        .route(
            "/videos/{id}/filmstrip.jpg",
            get(videos::get_filmstrip_image),
        )
        .route("/exports", post(exports::create_export))
        .route("/exports/{id}/progress", get(exports::export_progress))
        .route("/gifs", get(gifs::list_gifs))
        .route(
            "/gifs/{id}",
            get(gifs::get_gif).patch(gifs::rename_gif).delete(gifs::delete_gif),
        )
}
