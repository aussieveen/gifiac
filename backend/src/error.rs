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
    /// A signed-in caller who isn't allowed to do this — template
    /// overwrite/visibility endpoints for a non-creator (SPEC-CLOUD.md §4,
    /// where existence isn't secret the way a private gif/video's is, so
    /// 404 would be the wrong signal), and admin-only routes for a
    /// non-admin (SPEC-CLOUD.md §7). Every other ownership violation in
    /// this app still 404s.
    Forbidden(String),
    /// A rate limit was exceeded (SPEC-EMAIL-AUTH.md §6) — 429 with a
    /// standard `Retry-After` header carrying the seconds to wait, rather
    /// than inventing a JSON field for the same information.
    TooManyRequests(i64),
    Internal(anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        match self {
            AppError::TooManyRequests(retry_after_seconds) => {
                let body = format!("Please wait {retry_after_seconds} seconds before requesting another code.");
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    [(axum::http::header::RETRY_AFTER, retry_after_seconds.to_string())],
                    body,
                )
                    .into_response()
            }
            other => {
                let (status, message) = match other {
                    AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
                    AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
                    AppError::Conflict(msg) => (StatusCode::CONFLICT, msg),
                    AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "not signed in".to_string()),
                    AppError::Forbidden(msg) => (StatusCode::FORBIDDEN, msg),
                    AppError::Internal(err) => {
                        tracing::error!(error = ?err, "internal error");
                        (
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "internal server error".to_string(),
                        )
                    }
                    AppError::TooManyRequests(_) => unreachable!("handled above"),
                };
                (status, message).into_response()
            }
        }
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
