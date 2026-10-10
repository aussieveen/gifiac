use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt;

mod common;
use common::{login_as, spawn_app};

#[tokio::test]
async fn me_returns_null_when_logged_out() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(Request::builder().uri("/api/auth/me").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(body.is_null());
}

#[tokio::test]
async fn me_returns_the_user_after_login_as() {
    let test_app = spawn_app().await;
    let cookie = login_as(&test_app, "a@example.com").await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(body["role"], "user");
    assert!(body["handle"].is_null());
}

#[tokio::test]
async fn me_returns_null_for_an_unknown_session_cookie() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header("cookie", "gifiac_session=does-not-exist")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(body.is_null());
}

#[tokio::test]
async fn logout_clears_the_session_so_me_goes_back_to_logged_out() {
    let test_app = spawn_app().await;
    let cookie = login_as(&test_app, "a@example.com").await;

    let logout_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/logout")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(logout_response.status(), StatusCode::NO_CONTENT);

    let me_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(me_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(body.is_null());
}

#[tokio::test]
async fn callback_rejects_a_mismatched_oauth_state() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/callback?code=abc&state=wrong")
                .header("cookie", "gifiac_oauth_state=expected")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn callback_rejects_a_missing_oauth_state_cookie() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/callback?code=abc&state=whatever")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn login_redirects_to_google_with_a_state_param_and_sets_the_state_cookie() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(Request::builder().uri("/api/auth/login").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SEE_OTHER);

    let location = response
        .headers()
        .get("location")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(location.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
    assert!(location.contains("state="));

    let set_cookie = response
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(set_cookie.starts_with("gifiac_oauth_state="));
}

/// `CurrentUser`'s `touch_session` write is debounced (`TOUCH_DEBOUNCE_MINUTES`
/// in auth.rs) — a session touched moments ago shouldn't get a fresh
/// `UPDATE` on every subsequent request, since that write was the
/// dominant cost of an authenticated request under concurrent load.
#[tokio::test]
async fn an_authenticated_request_does_not_touch_a_recently_active_session() {
    let test_app = spawn_app().await;
    let cookie = login_as(&test_app, "a@example.com").await;
    let session_id = cookie.strip_prefix("gifiac_session=").unwrap();

    let before: String = sqlx::query_scalar("SELECT last_active_at FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap();

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let after: String = sqlx::query_scalar("SELECT last_active_at FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap();
    assert_eq!(before, after, "a session touched moments ago shouldn't be re-touched");
}

/// The other half of the debounce: once a session's `last_active_at` is
/// stale enough, the next authenticated request does refresh it — the
/// sliding expiry (SPEC-CLOUD.md §2) still works, just not on every
/// single request.
#[tokio::test]
async fn an_authenticated_request_touches_a_stale_session() {
    let test_app = spawn_app().await;
    let cookie = login_as(&test_app, "a@example.com").await;
    let session_id = cookie.strip_prefix("gifiac_session=").unwrap();

    let stale = (chrono::Utc::now() - chrono::Duration::minutes(10)).to_rfc3339();
    sqlx::query("UPDATE sessions SET last_active_at = $1 WHERE id = $2")
        .bind(&stale)
        .bind(session_id)
        .execute(&test_app.pool)
        .await
        .unwrap();

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/auth/me")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let after: String = sqlx::query_scalar("SELECT last_active_at FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap();
    assert_ne!(stale, after, "a stale session should be touched on the next request");
}
