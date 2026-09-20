//! Google OAuth + session mechanics (SPEC-CLOUD.md §2). Mirrors the
//! `exports.rs`/`routes::exports` split used elsewhere: this module owns
//! "how to talk to Google and what a valid session is", `routes::auth`
//! owns the thin HTTP layer (cookies, redirects) built on top of it.
//!
//! No `oauth2` crate: Google is the only provider for now, and the flow
//! is three well-documented HTTP endpoints — implementing it directly
//! with the `reqwest::Client` already on `AppState` (used today for
//! `link_check`) is simpler and more auditable than a generic
//! multi-provider abstraction this app doesn't need yet.

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum_extra::extract::cookie::CookieJar;
use chrono::{DateTime, Utc};

use crate::db;
use crate::error::AppError;
use crate::models::{GoogleTokenResponse, GoogleUserInfo, User};
use crate::state::AppState;

pub const SESSION_COOKIE_NAME: &str = "gifiac_session";
pub const STATE_COOKIE_NAME: &str = "gifiac_oauth_state";
/// SPEC-CLOUD.md §2: "Sliding 30-day expiry, refreshed on each active
/// request." Enforced here, in `CurrentUser`'s extractor — not by the
/// cookie's own `Max-Age`, so revoking a session (logout, or an admin
/// disabling an account per §7) by deleting its row takes effect
/// immediately regardless of what the browser still holds.
pub const SESSION_TTL_DAYS: i64 = 30;

/// Required env vars, no defaults — mirrors `storage.rs`'s `R2Config`
/// exactly. `app_base_url` (e.g. `http://localhost:5173` in dev, the real
/// HTTPS domain in prod) is what both the Google redirect URI and the
/// post-login redirect target are built from.
#[derive(Debug, Clone)]
pub struct GoogleAuthConfig {
    pub client_id: String,
    pub client_secret: String,
    pub app_base_url: String,
}

impl GoogleAuthConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            client_id: require_env("GOOGLE_CLIENT_ID")?,
            client_secret: require_env("GOOGLE_CLIENT_SECRET")?,
            app_base_url: require_env("APP_BASE_URL")?
                .trim_end_matches('/')
                .to_string(),
        })
    }

    pub fn redirect_uri(&self) -> String {
        format!("{}/api/auth/callback", self.app_base_url)
    }

    /// `Secure` cookies are refused by browsers over plain HTTP, which
    /// local dev (`http://localhost`) still is — TLS is only mandatory in
    /// production (SPEC-CLOUD.md §2, since Google's redirect URI must be
    /// HTTPS there). Deriving this from `app_base_url` rather than a
    /// separate env var keeps the one already-required setting as the
    /// single source of truth for "are we running for real".
    pub fn cookies_require_https(&self) -> bool {
        self.app_base_url.starts_with("https://")
    }
}

fn require_env(key: &str) -> Result<String> {
    std::env::var(key).with_context(|| format!("missing required env var {key}"))
}

pub fn authorize_url(config: &GoogleAuthConfig, csrf_state: &str) -> String {
    let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .expect("static Google authorize URL must parse");
    url.query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", &config.redirect_uri())
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("state", csrf_state);
    url.into()
}

pub async fn exchange_code(
    http_client: &reqwest::Client,
    config: &GoogleAuthConfig,
    code: &str,
) -> Result<GoogleTokenResponse> {
    http_client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.as_str()),
            ("redirect_uri", config.redirect_uri().as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
        .context("exchanging code with google's token endpoint")?
        .error_for_status()
        .context("google token endpoint returned an error status")?
        .json()
        .await
        .context("parsing google token response")
}

pub async fn fetch_userinfo(http_client: &reqwest::Client, access_token: &str) -> Result<GoogleUserInfo> {
    http_client
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .context("fetching google userinfo")?
        .error_for_status()
        .context("google userinfo endpoint returned an error status")?
        .json()
        .await
        .context("parsing google userinfo response")
}

/// The signed-in user for a request — extracted from the session cookie,
/// with the sliding expiry (see `SESSION_TTL_DAYS`) checked and refreshed
/// as a side effect. Rejects with `AppError::Unauthorized` (401) if the
/// cookie is missing, the session doesn't exist, or it's expired.
pub struct CurrentUser(pub User);

impl std::ops::Deref for CurrentUser {
    type Target = User;
    fn deref(&self) -> &User {
        &self.0
    }
}

impl FromRequestParts<Arc<AppState>> for CurrentUser {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &Arc<AppState>) -> Result<Self, Self::Rejection> {
        let jar = CookieJar::from_headers(&parts.headers);
        let session_id = jar
            .get(SESSION_COOKIE_NAME)
            .map(|cookie| cookie.value().to_string())
            .ok_or(AppError::Unauthorized)?;

        let session = db::get_session(&state.pool, &session_id)
            .await?
            .ok_or(AppError::Unauthorized)?;

        let last_active_at = DateTime::parse_from_rfc3339(&session.last_active_at)
            .map_err(|_| AppError::Unauthorized)?
            .with_timezone(&Utc);
        if Utc::now().signed_duration_since(last_active_at) > chrono::Duration::days(SESSION_TTL_DAYS) {
            // Best-effort cleanup — an expired session is treated as
            // unauthorized either way, so a failure here isn't fatal to
            // the request.
            let _ = db::delete_session(&state.pool, &session_id).await;
            return Err(AppError::Unauthorized);
        }

        let user = db::get_user(&state.pool, &session.user_id)
            .await?
            .ok_or(AppError::Unauthorized)?;

        db::touch_session(&state.pool, &session_id, &Utc::now().to_rfc3339()).await?;

        Ok(CurrentUser(user))
    }
}

/// Same lookup as `CurrentUser`, but never rejects — `None` when logged
/// out. For endpoints like `/api/auth/me` that behave differently rather
/// than requiring login.
pub struct OptionalCurrentUser(pub Option<CurrentUser>);

impl FromRequestParts<Arc<AppState>> for OptionalCurrentUser {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &Arc<AppState>) -> Result<Self, Self::Rejection> {
        match CurrentUser::from_request_parts(parts, state).await {
            Ok(current_user) => Ok(OptionalCurrentUser(Some(current_user))),
            Err(_) => Ok(OptionalCurrentUser(None)),
        }
    }
}
