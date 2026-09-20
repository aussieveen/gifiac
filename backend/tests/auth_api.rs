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
