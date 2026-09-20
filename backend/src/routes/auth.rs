use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Redirect};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::Utc;
use cookie::time::Duration as CookieMaxAge;
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::{self, CurrentUser, OptionalCurrentUser, STATE_COOKIE_NAME, SESSION_COOKIE_NAME};
use crate::db;
use crate::error::AppError;
use crate::models::CurrentUserView;
use crate::state::AppState;

pub async fn login(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let csrf_state = Uuid::new_v4().to_string();
    let authorize_url = auth::authorize_url(&state.google_auth, &csrf_state);

    let state_cookie = Cookie::build((STATE_COOKIE_NAME, csrf_state))
        .http_only(true)
        .secure(state.google_auth.cookies_require_https())
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(CookieMaxAge::minutes(5));

    let jar = CookieJar::new().add(state_cookie);
    (jar, Redirect::to(&authorize_url))
}

#[derive(Debug, Deserialize)]
pub struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

pub async fn callback(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Query(params): Query<CallbackParams>,
) -> Result<impl IntoResponse, AppError> {
    if let Some(error) = params.error {
        return Err(AppError::BadRequest(format!("google sign-in failed: {error}")));
    }
    let code = params
        .code
        .ok_or_else(|| AppError::BadRequest("missing code".to_string()))?;
    let returned_state = params
        .state
        .ok_or_else(|| AppError::BadRequest("missing state".to_string()))?;
    let expected_state = jar
        .get(STATE_COOKIE_NAME)
        .map(|cookie| cookie.value().to_string())
        .ok_or_else(|| AppError::BadRequest("missing oauth state cookie".to_string()))?;
    if returned_state != expected_state {
        return Err(AppError::BadRequest("oauth state mismatch".to_string()));
    }

    let token = auth::exchange_code(&state.http_client, &state.google_auth, &code).await?;
    let info = auth::fetch_userinfo(&state.http_client, &token.access_token).await?;

    let now = Utc::now().to_rfc3339();
    let user = match db::find_user_by_identity(&state.pool, "google", &info.sub).await? {
        Some(existing) => {
            db::update_user_profile_fields(
                &state.pool,
                &existing.id,
                info.email.as_deref(),
                info.picture.as_deref(),
            )
            .await?;
            existing
        }
        None => {
            let user_id = Uuid::new_v4().to_string();
            db::create_user_with_identity(
                &state.pool,
                &user_id,
                &now,
                "google",
                &info.sub,
                info.email.as_deref(),
                info.picture.as_deref(),
            )
            .await?
        }
    };

    let session_id = Uuid::new_v4().to_string();
    db::create_session(&state.pool, &session_id, &user.id, &now).await?;

    let session_cookie = Cookie::build((SESSION_COOKIE_NAME, session_id))
        .http_only(true)
        .secure(state.google_auth.cookies_require_https())
        .same_site(SameSite::Lax)
        .path("/")
        .max_age(CookieMaxAge::days(auth::SESSION_TTL_DAYS));

    let jar = jar
        .add(session_cookie)
        .remove(Cookie::build(STATE_COOKIE_NAME).path("/"));

    Ok((jar, Redirect::to(&format!("{}/", state.google_auth.app_base_url))))
}

pub async fn logout(State(state): State<Arc<AppState>>, jar: CookieJar) -> Result<impl IntoResponse, AppError> {
    if let Some(cookie) = jar.get(SESSION_COOKIE_NAME) {
        db::delete_session(&state.pool, cookie.value()).await?;
    }
    let jar = jar.remove(Cookie::build(SESSION_COOKIE_NAME).path("/"));
    Ok((jar, StatusCode::NO_CONTENT))
}

pub async fn me(OptionalCurrentUser(current_user): OptionalCurrentUser) -> Json<Option<CurrentUserView>> {
    Json(current_user.map(|CurrentUser(user)| user.into()))
}
