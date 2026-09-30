//! SPEC-EMAIL-AUTH.md — email one-time-passcode login. `callback`'s own
//! Google-side account-linking logic isn't covered here for the same
//! reason `auth_api.rs` never exercises `callback`'s success path: it
//! requires a real round-trip to Google's token/userinfo endpoints, which
//! nothing in this test harness can stand in for.

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use chrono::Utc;
use tower::ServiceExt;

mod common;
use common::spawn_app;

fn set_cookie_value(response: &axum::http::Response<Body>, name: &str) -> String {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap())
        .find(|v| v.starts_with(&format!("{name}=")))
        .unwrap_or_else(|| panic!("no {name} cookie in response"))
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

async fn start(test_app: &common::TestApp, email: &str) -> axum::http::Response<Body> {
    test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/email/start")
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({ "email": email }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn verify(test_app: &common::TestApp, cookie: &str, email: &str, code: &str) -> axum::http::Response<Body> {
    test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/email/verify")
                .header("content-type", "application/json")
                .header("cookie", cookie)
                .body(Body::from(serde_json::json!({ "email": email, "code": code }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

/// Drives `/start` then reads back the code the test `Mailer::capture()`
/// backend recorded — the equivalent of "check the inbox" for a test.
/// Sending happens on a spawned task (SPEC-EMAIL-AUTH.md §4's timing-
/// oracle note), so the response can return before it's landed — polls
/// briefly rather than assuming it's already there.
async fn start_and_get_code(test_app: &common::TestApp, email: &str) -> (String, String) {
    // A repeat `/start` for the same address (e.g. `returning_user_...`)
    // means `sent_codes` may already hold an earlier entry for it — track
    // the count beforehand so the poll below waits for a *new* entry
    // rather than racily returning the stale one before this call's
    // spawned send has actually landed.
    let baseline = test_app.sent_codes.lock().unwrap().len();
    let response = start(test_app, email).await;
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = set_cookie_value(&response, "login_attempt");
    // The mailer records the *normalized* address (trimmed + lowercased),
    // same as everywhere else the address is looked up — a caller testing
    // normalization passes a differently-cased/padded `email` here.
    let normalized = email.trim().to_lowercase();
    for _ in 0..50 {
        let found = {
            let sent = test_app.sent_codes.lock().unwrap();
            sent[baseline.min(sent.len())..].iter().find(|(to, _)| *to == normalized).map(|(_, code)| code.clone())
        };
        if let Some(code) = found {
            return (cookie, code);
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("no code sent for {email} within the timeout");
}

#[tokio::test]
async fn happy_path_new_email_creates_a_user_with_email_set_and_no_handle_yet() {
    let test_app = spawn_app().await;
    let (cookie, code) = start_and_get_code(&test_app, "new@example.com").await;

    let response = verify(&test_app, &cookie, "new@example.com", &code).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(set_cookie_value(&response, "gifiac_session").contains("gifiac_session="));

    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap(),
    )
    .unwrap();
    assert!(body["handle"].is_null());
    assert_eq!(body["suggestedHandle"], "new");

    let user: (Option<String>,) = sqlx::query_as("SELECT email FROM users WHERE id = $1")
        .bind(body["id"].as_str().unwrap())
        .fetch_one(&test_app.pool)
        .await
        .unwrap();
    assert_eq!(user.0.as_deref(), Some("new@example.com"));
}

#[tokio::test]
async fn returning_user_signs_in_and_gets_the_same_user_id() {
    let test_app = spawn_app().await;

    let (cookie1, code1) = start_and_get_code(&test_app, "returning@example.com").await;
    let first = verify(&test_app, &cookie1, "returning@example.com", &code1).await;
    let first_body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(first.into_body(), usize::MAX).await.unwrap()).unwrap();

    // Past the 60s resend cooldown, so this second `/start` isn't itself
    // rejected by the rate limiter under test.
    sqlx::query("UPDATE login_codes SET created_at = $1 WHERE email = $2")
        .bind((Utc::now() - chrono::Duration::seconds(120)).to_rfc3339())
        .bind("returning@example.com")
        .execute(&test_app.pool)
        .await
        .unwrap();

    let (cookie2, code2) = start_and_get_code(&test_app, "returning@example.com").await;
    let second = verify(&test_app, &cookie2, "returning@example.com", &code2).await;
    let second_body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(second.into_body(), usize::MAX).await.unwrap()).unwrap();

    assert_eq!(first_body["id"], second_body["id"]);
}

#[tokio::test]
async fn wrong_code_returns_invalid_or_expired_and_counts_down_remaining_attempts() {
    let test_app = spawn_app().await;
    let (cookie, _code) = start_and_get_code(&test_app, "wrong@example.com").await;

    let response = verify(&test_app, &cookie, "wrong@example.com", "000000").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(response.headers().get("x-attempts-remaining").unwrap(), "4");
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"invalid_or_expired");
}

#[tokio::test]
async fn sixth_attempt_locks_the_code_out_even_with_the_right_code_afterward() {
    let test_app = spawn_app().await;
    let (cookie, code) = start_and_get_code(&test_app, "lockout@example.com").await;

    for _ in 0..5 {
        let response = verify(&test_app, &cookie, "lockout@example.com", "000000").await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
    let sixth = verify(&test_app, &cookie, "lockout@example.com", "000000").await;
    assert_eq!(sixth.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(sixth.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"too_many_attempts");

    let with_right_code = verify(&test_app, &cookie, "lockout@example.com", &code).await;
    assert_eq!(with_right_code.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_code_cannot_be_reused_after_a_successful_verify() {
    let test_app = spawn_app().await;
    let (cookie, code) = start_and_get_code(&test_app, "reuse@example.com").await;

    let first = verify(&test_app, &cookie, "reuse@example.com", &code).await;
    assert_eq!(first.status(), StatusCode::OK);

    let second = verify(&test_app, &cookie, "reuse@example.com", &code).await;
    assert_eq!(second.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(second.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"invalid_or_expired");
}

#[tokio::test]
async fn requesting_a_new_code_invalidates_the_previous_one() {
    let test_app = spawn_app().await;
    let (cookie1, code1) = start_and_get_code(&test_app, "reissue@example.com").await;

    // Simulate the 60s cooldown having already elapsed so the second
    // `/start` isn't itself rejected by the rate limiter under test.
    sqlx::query("UPDATE login_codes SET created_at = $1 WHERE email = $2")
        .bind((Utc::now() - chrono::Duration::seconds(120)).to_rfc3339())
        .bind("reissue@example.com")
        .execute(&test_app.pool)
        .await
        .unwrap();

    let (_cookie2, _code2) = start_and_get_code(&test_app, "reissue@example.com").await;

    let response = verify(&test_app, &cookie1, "reissue@example.com", &code1).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"invalid_or_expired");
}

#[tokio::test]
async fn verify_without_the_login_attempt_cookie_fails() {
    let test_app = spawn_app().await;
    let (_cookie, code) = start_and_get_code(&test_app, "nocookie@example.com").await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/email/verify")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({ "email": "nocookie@example.com", "code": code }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn verify_with_another_attempts_cookie_fails() {
    let test_app = spawn_app().await;
    let (_cookie1, code1) = start_and_get_code(&test_app, "attempt-a@example.com").await;
    let (cookie2, _code2) = start_and_get_code(&test_app, "attempt-b@example.com").await;

    // cookie2 belongs to attempt-b's login_codes row, submitted against
    // attempt-a's email/code.
    let response = verify(&test_app, &cookie2, "attempt-a@example.com", &code1).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn start_responses_are_identical_for_new_existing_and_disabled_emails_and_disabled_gets_no_email() {
    let test_app = spawn_app().await;

    // An existing (non-disabled) user via the `login_as`-style direct DB
    // insert, and a disabled one, to compare against a brand-new address.
    common::login_as(&test_app, "existing@example.com").await;
    let disabled_cookie = common::login_as(&test_app, "disabled@example.com").await;
    let session_id = disabled_cookie.strip_prefix("gifiac_session=").unwrap();
    let user_id: String = sqlx::query_scalar("SELECT user_id FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET disabled = true WHERE id = $1")
        .bind(&user_id)
        .execute(&test_app.pool)
        .await
        .unwrap();

    let new_response = start(&test_app, "brand-new@example.com").await;
    let existing_response = start(&test_app, "existing@example.com").await;
    let disabled_response = start(&test_app, "disabled@example.com").await;

    assert_eq!(new_response.status(), StatusCode::OK);
    assert_eq!(existing_response.status(), StatusCode::OK);
    assert_eq!(disabled_response.status(), StatusCode::OK);

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let sent = test_app.sent_codes.lock().unwrap();
    assert!(sent.iter().any(|(to, _)| to == "brand-new@example.com"));
    assert!(sent.iter().any(|(to, _)| to == "existing@example.com"));
    assert!(!sent.iter().any(|(to, _)| to == "disabled@example.com"));
}

#[tokio::test]
async fn a_disabled_user_cannot_verify_even_with_a_valid_code() {
    let test_app = spawn_app().await;
    let cookie = common::login_as(&test_app, "will-be-disabled@example.com").await;
    let session_id = cookie.strip_prefix("gifiac_session=").unwrap();
    let user_id: String = sqlx::query_scalar("SELECT user_id FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET disabled = true WHERE id = $1")
        .bind(&user_id)
        .execute(&test_app.pool)
        .await
        .unwrap();

    let response = start(&test_app, "will-be-disabled@example.com").await;
    let start_cookie = set_cookie_value(&response, "login_attempt");
    // Disabled: nothing was actually sent, so insert a known code
    // directly, matching how `/start` would have hashed and stored it —
    // the point of this test is that *verify* refuses a disabled user
    // even with the objectively correct code, not that `/start` withheld
    // sending (covered by the test above).
    let known_code = "424242";
    let hash = gifiac_backend::email_auth::hash_code(
        b"01234567890123456789012345678901",
        "will-be-disabled@example.com",
        known_code,
    );
    let id = start_cookie.strip_prefix("login_attempt=").unwrap();
    sqlx::query("UPDATE login_codes SET code_hash = $1 WHERE id = $2")
        .bind(&hash)
        .bind(id)
        .execute(&test_app.pool)
        .await
        .unwrap();

    let verify_response = verify(&test_app, &start_cookie, "will-be-disabled@example.com", known_code).await;
    assert_eq!(verify_response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(verify_response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"invalid_or_expired");
}

#[tokio::test]
async fn a_second_start_within_the_cooldown_is_rate_limited() {
    let test_app = spawn_app().await;
    let first = start(&test_app, "cooldown@example.com").await;
    assert_eq!(first.status(), StatusCode::OK);

    let second = start(&test_app, "cooldown@example.com").await;
    assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(second.headers().get(header::RETRY_AFTER).is_some());
}

#[tokio::test]
async fn email_normalization_resolves_padded_and_differently_cased_addresses_to_the_same_identity() {
    let test_app = spawn_app().await;
    let (cookie, code) = start_and_get_code(&test_app, "foo@example.com").await;
    let first = verify(&test_app, &cookie, "  Foo@Example.COM ", &code).await;
    assert_eq!(first.status(), StatusCode::OK);
    let first_body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(first.into_body(), usize::MAX).await.unwrap()).unwrap();

    sqlx::query("UPDATE login_codes SET created_at = $1 WHERE email = $2")
        .bind((Utc::now() - chrono::Duration::seconds(120)).to_rfc3339())
        .bind("foo@example.com")
        .execute(&test_app.pool)
        .await
        .unwrap();
    let (cookie2, code2) = start_and_get_code(&test_app, "Foo@Example.com").await;
    let second = verify(&test_app, &cookie2, "foo@example.com", &code2).await;
    let second_body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(second.into_body(), usize::MAX).await.unwrap()).unwrap();

    assert_eq!(first_body["id"], second_body["id"]);
}

#[tokio::test]
async fn an_expired_code_fails() {
    let test_app = spawn_app().await;
    let response = start(&test_app, "expired@example.com").await;
    let cookie = set_cookie_value(&response, "login_attempt");
    let id = cookie.strip_prefix("login_attempt=").unwrap();

    sqlx::query("UPDATE login_codes SET expires_at = $1 WHERE id = $2")
        .bind((Utc::now() - chrono::Duration::minutes(1)).to_rfc3339())
        .bind(id)
        .execute(&test_app.pool)
        .await
        .unwrap();

    let code = {
        let sent = test_app.sent_codes.lock().unwrap();
        sent.iter().find(|(to, _)| to == "expired@example.com").unwrap().1.clone()
    };

    let verify_response = verify(&test_app, &cookie, "expired@example.com", &code).await;
    assert_eq!(verify_response.status(), StatusCode::BAD_REQUEST);
    let body = axum::body::to_bytes(verify_response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"invalid_or_expired");
}

#[tokio::test]
async fn no_plaintext_code_is_ever_persisted() {
    let test_app = spawn_app().await;
    let (_cookie, code) = start_and_get_code(&test_app, "noplain@example.com").await;

    let stored: (String,) = sqlx::query_as("SELECT code_hash FROM login_codes WHERE email = $1")
        .bind("noplain@example.com")
        .fetch_one(&test_app.pool)
        .await
        .unwrap();
    assert_ne!(stored.0, code);
    assert!(!stored.0.contains(&code));
}
