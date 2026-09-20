use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

mod common;
use common::{authed, login_as, spawn_app};

#[tokio::test]
async fn set_handle_succeeds_and_a_second_attempt_409s() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PUT")
                .uri("/api/users/me/handle")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "handle": "simon" }).to_string()))
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
    assert_eq!(body["handle"], "simon");

    let second_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PUT")
                .uri("/api/users/me/handle")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "handle": "someone-else" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second_response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn set_handle_rejects_an_invalid_format() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PUT")
                .uri("/api/users/me/handle")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "handle": "Not Valid!" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn set_handle_409s_when_taken_by_a_different_user() {
    let test_app = spawn_app().await;
    let other_cookie = login_as(&test_app, "other@example.com").await;

    let first_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PUT")
                .uri("/api/users/me/handle")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "handle": "popular" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first_response.status(), StatusCode::OK);

    let second_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/users/me/handle")
                .header("content-type", "application/json")
                .header("cookie", &other_cookie)
                .body(Body::from(json!({ "handle": "popular" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second_response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn get_profile_returns_404_for_an_unknown_handle() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/profiles/nobody")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// No auth required — a profile page is public, and (with nothing public
/// yet — the sharing toggle is M5b) shows an empty gif list.
#[tokio::test]
async fn get_profile_requires_no_auth_and_returns_an_empty_gif_list() {
    let test_app = spawn_app().await;
    let set_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PUT")
                .uri("/api/users/me/handle")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "handle": "simon" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(set_response.status(), StatusCode::OK);

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/profiles/simon")
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
    assert_eq!(body["handle"], "simon");
    assert_eq!(body["gifs"], json!([]));
}
