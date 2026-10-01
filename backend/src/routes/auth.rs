use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use cookie::time::Duration as CookieMaxAge;
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::{self, CurrentUser, OptionalCurrentUser, STATE_COOKIE_NAME, SESSION_COOKIE_NAME};
use crate::db;
use crate::email_auth;
use crate::error::AppError;
use crate::models::{CurrentUserView, EmailStartRequest, EmailVerifyRequest};
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
    let verified_email = info
        .email_verified
        .then(|| info.email.as_deref().map(email_auth::normalize_email))
        .flatten();

    let user = match db::find_user_by_identity(&state.pool, "google", &info.sub).await? {
        Some(existing) => {
            // SPEC-CLOUD.md §7: disabling "blocks further login" — a
            // brand-new user (the `None` branch below) can't be disabled
            // yet, so this only ever applies to an existing account.
            if existing.disabled {
                return Err(AppError::Forbidden("account disabled".to_string()));
            }
            db::update_user_profile_fields(
                &state.pool,
                &existing.id,
                info.email.as_deref(),
                info.picture.as_deref(),
                info.name.as_deref(),
            )
            .await?;
            existing
        }
        None => {
            // SPEC-EMAIL-AUTH.md §5: a first-time Google login whose
            // verified email already belongs to an email-login account
            // links to that account instead of creating a second one.
            // Unverified emails never link — only proof of address
            // control justifies merging two providers onto one user.
            let linked_existing = match &verified_email {
                Some(email) => db::find_user_by_email(&state.pool, email).await?,
                None => None,
            };
            match linked_existing {
                Some(existing) => {
                    if existing.disabled {
                        return Err(AppError::Forbidden("account disabled".to_string()));
                    }
                    db::add_identity(&state.pool, "google", &info.sub, &existing.id).await?;
                    db::update_user_profile_fields(
                        &state.pool,
                        &existing.id,
                        info.email.as_deref(),
                        info.picture.as_deref(),
                        info.name.as_deref(),
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
                        info.name.as_deref(),
                    )
                    .await?
                }
            }
        }
    };

    let jar = auth::create_session_and_set_cookie(&state.pool, state.google_auth.cookies_require_https(), jar, &user.id)
        .await?;
    let jar = jar.remove(Cookie::build(STATE_COOKIE_NAME).path("/"));

    Ok((jar, Redirect::to(&format!("{}/", state.google_auth.app_base_url))))
}

// TEMPORARY, local-review-only: bypasses real Google OAuth (which can't
// run against localhost) so the public-templates work can be clicked
// through in a real browser. Not wired into any persistent config flag —
// remove this before committing anything. Reuses the exact same
// find-or-create-user + create-session + set-cookie shape `callback`
// above does, just skipped the token exchange/userinfo fetch.
#[derive(Debug, Deserialize)]
pub struct DevLoginParams {
    email: String,
}

pub async fn dev_login(
    State(state): State<Arc<AppState>>,
    Query(params): Query<DevLoginParams>,
) -> Result<impl IntoResponse, AppError> {
    let now = Utc::now().to_rfc3339();
    let user = match db::find_user_by_identity(&state.pool, "dev", &params.email).await? {
        Some(existing) => existing,
        None => {
            let user_id = Uuid::new_v4().to_string();
            db::create_user_with_identity(
                &state.pool,
                &user_id,
                &now,
                "dev",
                &params.email,
                Some(&params.email),
                None,
                Some("Local Dev User"),
            )
            .await?
        }
    };

    let jar = auth::create_session_and_set_cookie(
        &state.pool,
        state.google_auth.cookies_require_https(),
        CookieJar::new(),
        &user.id,
    )
    .await?;
    Ok((jar, Redirect::to(&format!("{}/", state.google_auth.app_base_url))))
}

pub async fn logout(State(state): State<Arc<AppState>>, jar: CookieJar) -> Result<impl IntoResponse, AppError> {
    if let Some(cookie) = jar.get(SESSION_COOKIE_NAME) {
        db::delete_session(&state.pool, cookie.value()).await?;
    }
    let jar = jar.remove(Cookie::build(SESSION_COOKIE_NAME).path("/"));
    Ok((jar, StatusCode::NO_CONTENT))
}

pub async fn me(
    State(state): State<Arc<AppState>>,
    OptionalCurrentUser(current_user): OptionalCurrentUser,
) -> Result<Json<Option<CurrentUserView>>, AppError> {
    let Some(CurrentUser(user)) = current_user else {
        return Ok(Json(None));
    };
    let preferences = db::get_preferences(&state.pool, &user.id).await?;
    Ok(Json(Some(CurrentUserView::from_user_and_preferences(user, preferences))))
}

// --- Email one-time-passcode login (SPEC-EMAIL-AUTH.md) ---

const LOGIN_ATTEMPT_COOKIE_NAME: &str = "login_attempt";
const LOGIN_ATTEMPT_COOKIE_PATH: &str = "/api/auth/email";

/// SPEC-EMAIL-AUTH.md §6: only trust `CF-Connecting-IP` when the deploy
/// explicitly says every request actually comes through Cloudflare —
/// otherwise it's a client-spoofable header. There's no other reliable
/// client-IP source here: this app sits behind an ALB (`terraform/alb.tf`)
/// whose own peer address isn't the real client's either, so absent that
/// trusted header every request buckets into one shared "unknown" per-IP
/// counter — degraded to email-only rate limiting in that configuration,
/// same as if `TRUST_CF_CONNECTING_IP` were never set.
fn client_ip(state: &AppState, headers: &HeaderMap) -> String {
    if state.email_auth.trust_cf_connecting_ip
        && let Some(ip) = headers.get("CF-Connecting-IP").and_then(|v| v.to_str().ok())
    {
        return ip.to_string();
    }
    "unknown".to_string()
}

pub async fn email_start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<EmailStartRequest>,
) -> Result<impl IntoResponse, AppError> {
    let email = email_auth::normalize_email(&request.email);
    if !email_auth::is_plausible_email(&email) {
        return Err(AppError::BadRequest("not a valid email address".to_string()));
    }

    if let Some(secret_key) = &state.email_auth.turnstile_secret_key {
        let token = request.turnstile_token.as_deref().unwrap_or("");
        if token.is_empty() {
            return Err(AppError::BadRequest("missing security check token".to_string()));
        }
        let verified = email_auth::verify_turnstile(&state.http_client, secret_key, token).await?;
        if !verified {
            return Err(AppError::BadRequest("security check failed".to_string()));
        }
    } else {
        tracing::warn!("TURNSTILE_SECRET_KEY not set — skipping Turnstile verification on /api/auth/email/start");
    }

    let client_ip = client_ip(&state, &headers);
    let now = Utc::now();
    let now_str = now.to_rfc3339();

    if let Some(latest) = db::latest_login_code_for_email(&state.pool, &email).await?
        && let Ok(created) = DateTime::parse_from_rfc3339(&latest.created_at)
    {
        let elapsed = now.signed_duration_since(created.with_timezone(&Utc));
        if elapsed < ChronoDuration::seconds(email_auth::RESEND_COOLDOWN_SECONDS) {
            let retry_after = (email_auth::RESEND_COOLDOWN_SECONDS - elapsed.num_seconds()).max(1);
            return Err(AppError::TooManyRequests(retry_after));
        }
    }

    let hour_ago = (now - ChronoDuration::hours(1)).to_rfc3339();
    let email_count = db::count_login_codes_for_email_since(&state.pool, &email, &hour_ago).await?;
    if email_count >= email_auth::MAX_CODES_PER_EMAIL_PER_HOUR {
        return Err(AppError::TooManyRequests(3600));
    }
    let ip_count = db::count_login_codes_for_ip_since(&state.pool, &client_ip, &hour_ago).await?;
    if ip_count >= email_auth::MAX_CODES_PER_IP_PER_HOUR {
        return Err(AppError::TooManyRequests(3600));
    }

    db::invalidate_outstanding_login_codes(&state.pool, &email, &now_str).await?;

    // SPEC-EMAIL-AUTH.md §4 step 5: response, status, and cookie behavior
    // must be identical for a new, existing, and disabled email — only
    // whether the email actually gets sent differs.
    let existing_user = db::find_user_by_email(&state.pool, &email).await?;
    let should_send = !existing_user.is_some_and(|u| u.disabled);

    let code = email_auth::generate_code();
    let code_hash = email_auth::hash_code(&state.email_auth.login_code_hmac_key, &email, &code);
    let id = Uuid::new_v4().to_string();
    let expires_at = (now + ChronoDuration::minutes(email_auth::CODE_TTL_MINUTES)).to_rfc3339();
    db::insert_login_code(&state.pool, &id, &email, &code_hash, &client_ip, &now_str, &expires_at).await?;

    // Sent from a spawned task, not awaited, so a real SES round-trip
    // can't make the "disabled, nothing sent" branch respond measurably
    // faster than the "sent" branches — both return immediately either
    // way (SPEC-EMAIL-AUTH.md §4's timing-oracle note).
    if should_send {
        let mailer = state.mailer.clone();
        let to = email.clone();
        tokio::spawn(async move {
            if let Err(err) = mailer.send_login_code(&to, &code).await {
                tracing::error!(error = ?err, "failed to send login-code email");
            }
        });
    }

    let attempt_cookie = Cookie::build((LOGIN_ATTEMPT_COOKIE_NAME, id))
        .http_only(true)
        .secure(state.google_auth.cookies_require_https())
        .same_site(SameSite::Lax)
        .path(LOGIN_ATTEMPT_COOKIE_PATH)
        .max_age(CookieMaxAge::minutes(email_auth::CODE_TTL_MINUTES));
    let jar = CookieJar::new().add(attempt_cookie);

    Ok((jar, Json(serde_json::json!({ "ok": true }))))
}

pub async fn email_verify(
    State(state): State<Arc<AppState>>,
    jar: CookieJar,
    Json(request): Json<EmailVerifyRequest>,
) -> Result<Response, AppError> {
    let email = email_auth::normalize_email(&request.email);
    let code: String = request.code.chars().filter(|c| !c.is_whitespace()).collect();
    if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Ok((StatusCode::BAD_REQUEST, "invalid_or_expired").into_response());
    }

    let Some(attempt_id) = jar.get(LOGIN_ATTEMPT_COOKIE_NAME).map(|c| c.value().to_string()) else {
        return Ok((StatusCode::BAD_REQUEST, "invalid_or_expired").into_response());
    };

    let now = Utc::now().to_rfc3339();
    let Some(login_code) = db::increment_login_code_attempts(&state.pool, &attempt_id, &email, &now).await? else {
        return Ok((StatusCode::BAD_REQUEST, "invalid_or_expired").into_response());
    };

    if login_code.attempts > email_auth::MAX_VERIFY_ATTEMPTS {
        db::consume_login_code(&state.pool, &attempt_id, &now).await?;
        return Ok((StatusCode::BAD_REQUEST, "too_many_attempts").into_response());
    }

    if !email_auth::code_matches(&state.email_auth.login_code_hmac_key, &email, &code, &login_code.code_hash) {
        let remaining = (email_auth::MAX_VERIFY_ATTEMPTS - login_code.attempts).max(0);
        return Ok((
            StatusCode::BAD_REQUEST,
            [("X-Attempts-Remaining", remaining.to_string())],
            "invalid_or_expired",
        )
            .into_response());
    }

    if !db::consume_login_code(&state.pool, &attempt_id, &now).await? {
        // Lost a race with a concurrent verify of the same code.
        return Ok((StatusCode::BAD_REQUEST, "invalid_or_expired").into_response());
    }

    let user = match db::find_user_by_identity(&state.pool, "email", &email).await? {
        Some(existing) => existing,
        None => match db::find_user_by_email(&state.pool, &email).await? {
            // SPEC-EMAIL-AUTH.md §5: a Google user with this verified
            // email signing in with email/code for the first time links
            // rather than duplicating.
            Some(existing) => {
                db::add_identity(&state.pool, "email", &email, &existing.id).await?;
                existing
            }
            None => {
                let user_id = Uuid::new_v4().to_string();
                db::create_user_with_identity(&state.pool, &user_id, &now, "email", &email, Some(&email), None, None)
                    .await?
            }
        },
    };

    if user.disabled {
        // Generic error — never reveal that the account exists but is
        // disabled (SPEC-EMAIL-AUTH.md §4 step 7).
        return Ok((StatusCode::BAD_REQUEST, "invalid_or_expired").into_response());
    }

    let jar = auth::create_session_and_set_cookie(&state.pool, state.google_auth.cookies_require_https(), jar, &user.id)
        .await?;
    let jar = jar.remove(Cookie::build(LOGIN_ATTEMPT_COOKIE_NAME).path(LOGIN_ATTEMPT_COOKIE_PATH));

    let preferences = db::get_preferences(&state.pool, &user.id).await?;
    let view = CurrentUserView::from_user_and_preferences(user, preferences);
    Ok((jar, Json(view)).into_response())
}
