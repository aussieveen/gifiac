use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug)]
pub enum AppError {
    NotFound,
    BadRequest(String),
    /// The request is well-formed but conflicts with existing state (e.g.
    /// deleting a video that GIFs still depend on) — 409, distinct from a
    /// malformed request (400).
    Conflict(String),
    /// No valid session (SPEC-CLOUD.md §2) — missing, unknown, or expired
    /// session cookie.
    Unauthorized,
    /// A signed-in caller who isn't the resource's creator — used only for
    /// template overwrite/visibility endpoints (SPEC-CLOUD.md §4), where
    /// existence isn't secret the way a private gif/video's is, so 404
    /// would be the wrong signal. Every other ownership violation in this
    /// app still 404s.
    Forbidden,
    Internal(anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "not signed in".to_string()),
            AppError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_string()),
            AppError::Internal(err) => {
                tracing::error!(error = ?err, "internal error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal server error".to_string(),
                )
            }
        };
        (status, message).into_response()
    }
}

impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        AppError::Internal(err.into())
    }
}
