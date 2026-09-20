use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

mod common;
use common::{authed, spawn_app};

/// A long-standing, stable Wikimedia Commons asset — real network access,
/// same testing philosophy this suite already uses for MinIO/FFmpeg (real
/// infra, not mocks). `POST /api/gifs/link` per SPEC.md §13 is inherently
/// about talking to a real third-party host, so there's no meaningful way
/// to exercise the full happy path without one.
const STABLE_TEST_GIF_URL: &str = "https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth_%28large%29.gif";

#[tokio::test]
async fn link_gif_creates_a_row_with_the_external_url_and_no_r2_objects() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/link")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "url": STABLE_TEST_GIF_URL, "name": "earth" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
    let gif: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();

    assert_eq!(gif["name"], "earth");
    assert_eq!(gif["external_url"], STABLE_TEST_GIF_URL);
    assert_eq!(gif["gif_url"], STABLE_TEST_GIF_URL);
    assert!(gif["mp4_url"].is_null());
    assert!(gif["webm_url"].is_null());
    assert!(gif["video_id"].is_null());
    assert!(gif["captions_json"].is_null());
    assert!(gif["width"].is_null());
    assert!(gif["gif_range_start"].is_null());
}

#[tokio::test]
async fn link_gif_appears_in_the_archive_list_and_can_be_fetched_by_id() {
    let test_app = spawn_app().await;
    let create_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/link")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "url": STABLE_TEST_GIF_URL, "name": "earth" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let created: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let id = created["id"].as_str().unwrap();

    let get_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/gifs/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);

    let list_response = test_app
        .app
        .clone()
        .oneshot(authed(&test_app, Request::builder()).uri("/api/gifs").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let gifs: Vec<serde_json::Value> = serde_json::from_slice(
        &axum::body::to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(gifs.iter().any(|g| g["id"] == id));
}

/// Deleting a linked GIF only removes the row — there's nothing in R2 to
/// clean up (SPEC.md §13). This mainly proves the delete path doesn't try
/// (and fail) to delete R2 objects that were never created.
#[tokio::test]
async fn deleting_a_linked_gif_only_removes_the_row() {
    let test_app = spawn_app().await;
    let create_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/link")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "url": STABLE_TEST_GIF_URL, "name": "earth" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let created: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let id = created["id"].as_str().unwrap();

    let delete_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri(format!("/api/gifs/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);

    let get_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/gifs/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn link_gif_with_an_empty_name_is_rejected() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/link")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "url": STABLE_TEST_GIF_URL, "name": "   " }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn link_gif_with_an_unparseable_url_is_rejected() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/link")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "url": "not a url", "name": "x" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

/// SPEC.md §13's SSRF guard: a URL that resolves to a private/loopback
/// address is rejected before any request is made, end-to-end through the
/// real route (not just the link_check unit tests).
#[tokio::test]
async fn link_gif_pointed_at_a_loopback_address_is_rejected() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/link")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "url": "http://127.0.0.1:1/a.gif", "name": "x" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

/// A URL that resolves fine but doesn't look like an image (SPEC.md §13's
/// content-type sanity check) is also rejected.
#[tokio::test]
async fn link_gif_pointed_at_a_non_image_url_is_rejected() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/link")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "url": "https://en.wikipedia.org/wiki/Main_Page", "name": "x" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}
