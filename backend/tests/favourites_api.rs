//! SPEC-CLOUD.md §14: favourites / personal saved library.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

mod common;
use common::{authed, create_gif, login_as, spawn_app};

async fn patch_is_public(test_app: &common::TestApp, id: &str, is_public: bool) {
    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_public": is_public }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

async fn favourite(test_app: &common::TestApp, cookie: &str, id: &str) -> axum::response::Response {
    test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/gifs/{id}/favourite"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn unfavourite(test_app: &common::TestApp, cookie: &str, id: &str) -> axum::response::Response {
    test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/gifs/{id}/favourite"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn list_favourites(test_app: &common::TestApp, cookie: &str) -> serde_json::Value {
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/favourites")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

#[tokio::test]
async fn favouriting_a_public_gif_makes_it_appear_in_favourites() {
    let test_app = spawn_app().await;
    let owner_gif = create_gif(&test_app, "someone else's gif", "").await;
    let id = owner_gif["id"].as_str().unwrap();
    patch_is_public(&test_app, id, true).await;

    let saver_cookie = login_as(&test_app, "saver@example.com").await;

    let response = favourite(&test_app, &saver_cookie, id).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["is_favourited"], true);

    let saved = list_favourites(&test_app, &saver_cookie).await;
    let ids: Vec<&str> = saved.as_array().unwrap().iter().map(|g| g["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![id]);
}

#[tokio::test]
async fn favouriting_your_own_gif_is_allowed_even_when_private() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "my own private gif", "").await;
    let id = gif["id"].as_str().unwrap();
    assert_eq!(gif["is_public"], false);

    let response = favourite(&test_app, &test_app.owner_cookie, id).await;
    assert_eq!(response.status(), StatusCode::OK);

    let saved = list_favourites(&test_app, &test_app.owner_cookie).await;
    let ids: Vec<&str> = saved.as_array().unwrap().iter().map(|g| g["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![id]);
}

#[tokio::test]
async fn favouriting_another_users_private_gif_returns_404() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "not yours", "").await;
    let id = gif["id"].as_str().unwrap();
    assert_eq!(gif["is_public"], false);

    let other_cookie = login_as(&test_app, "other@example.com").await;
    let response = favourite(&test_app, &other_cookie, id).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    let saved = list_favourites(&test_app, &other_cookie).await;
    assert!(saved.as_array().unwrap().is_empty());
}

/// Regression guard: `DELETE /api/gifs/{id}/favourite` must apply the same
/// visibility rule as `POST` when the caller never favourited the gif in
/// the first place — otherwise it's a no-op unfavourite that leaks another
/// user's private gif's existence and details via a 200 instead of 404.
#[tokio::test]
async fn unfavouriting_a_private_gif_you_never_favourited_returns_404() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "not yours, never saved", "").await;
    let id = gif["id"].as_str().unwrap();
    assert_eq!(gif["is_public"], false);

    let other_cookie = login_as(&test_app, "other@example.com").await;
    let response = unfavourite(&test_app, &other_cookie, id).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn favourite_endpoint_requires_auth() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "a gif", "").await;
    let id = gif["id"].as_str().unwrap();
    patch_is_public(&test_app, id, true).await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/gifs/{id}/favourite"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn favouriting_an_unknown_gif_returns_404() {
    let test_app = spawn_app().await;
    let response = favourite(
        &test_app,
        &test_app.owner_cookie,
        "00000000-0000-0000-0000-000000000000",
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn favouriting_twice_is_idempotent() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "a gif", "").await;
    let id = gif["id"].as_str().unwrap();
    patch_is_public(&test_app, id, true).await;
    let saver_cookie = login_as(&test_app, "saver@example.com").await;

    assert_eq!(favourite(&test_app, &saver_cookie, id).await.status(), StatusCode::OK);
    assert_eq!(favourite(&test_app, &saver_cookie, id).await.status(), StatusCode::OK);

    let saved = list_favourites(&test_app, &saver_cookie).await;
    assert_eq!(saved.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn unfavouriting_removes_it_from_saved_and_is_idempotent() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "a gif", "").await;
    let id = gif["id"].as_str().unwrap();
    patch_is_public(&test_app, id, true).await;
    let saver_cookie = login_as(&test_app, "saver@example.com").await;

    favourite(&test_app, &saver_cookie, id).await;
    let saved = list_favourites(&test_app, &saver_cookie).await;
    assert_eq!(saved.as_array().unwrap().len(), 1);

    let response = unfavourite(&test_app, &saver_cookie, id).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["is_favourited"], false);

    let saved = list_favourites(&test_app, &saver_cookie).await;
    assert!(saved.as_array().unwrap().is_empty());

    // Removing it again (already gone) is a no-op, not an error.
    let response = unfavourite(&test_app, &saver_cookie, id).await;
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn unpublishing_hides_a_favourite_and_republishing_brings_it_back() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "here today", "").await;
    let id = gif["id"].as_str().unwrap();
    patch_is_public(&test_app, id, true).await;
    let saver_cookie = login_as(&test_app, "saver@example.com").await;
    favourite(&test_app, &saver_cookie, id).await;

    patch_is_public(&test_app, id, false).await;
    let saved = list_favourites(&test_app, &saver_cookie).await;
    assert!(
        saved.as_array().unwrap().is_empty(),
        "an unpublished gif must disappear from another user's Saved list"
    );

    patch_is_public(&test_app, id, true).await;
    let saved = list_favourites(&test_app, &saver_cookie).await;
    let ids: Vec<&str> = saved.as_array().unwrap().iter().map(|g| g["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        vec![id],
        "re-publishing must silently bring the favourite back, with no need to re-save it"
    );
}

#[tokio::test]
async fn deleting_a_gif_removes_its_favourite_rows() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "will be deleted", "").await;
    let id = gif["id"].as_str().unwrap();
    patch_is_public(&test_app, id, true).await;
    let saver_cookie = login_as(&test_app, "saver@example.com").await;
    favourite(&test_app, &saver_cookie, id).await;

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

    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM favourites WHERE gif_id = $1")
        .bind(id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap();
    assert_eq!(remaining, 0, "deleting a gif must cascade away its favourite rows");
}

#[tokio::test]
async fn library_and_my_gifs_report_is_favourited_per_viewer() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "maybe favourited", "").await;
    let id = gif["id"].as_str().unwrap();
    patch_is_public(&test_app, id, true).await;
    let saver_cookie = login_as(&test_app, "saver@example.com").await;

    // Not yet favourited: false for both the owner and a logged-out
    // visitor to the global library.
    let library_before: serde_json::Value = {
        let response = test_app
            .app
            .clone()
            .oneshot(Request::builder().uri("/api/library").body(Body::empty()).unwrap())
            .await
            .unwrap();
        serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    };
    let entry_before = library_before.as_array().unwrap().iter().find(|e| e["id"] == id).unwrap();
    assert_eq!(entry_before["is_favourited"], false);

    favourite(&test_app, &saver_cookie, id).await;

    // The saver's own view of the library now shows it favourited...
    let library_after: serde_json::Value = {
        let response = test_app
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/library")
                    .header("cookie", &saver_cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    };
    let entry_after = library_after.as_array().unwrap().iter().find(|e| e["id"] == id).unwrap();
    assert_eq!(entry_after["is_favourited"], true);

    // ...but the owner's own My Library view, and a logged-out visitor's
    // library view, are unaffected by someone else's favourite.
    let my_gifs: serde_json::Value = {
        let response = test_app
            .app
            .clone()
            .oneshot(authed(&test_app, Request::builder()).uri("/api/gifs").body(Body::empty()).unwrap())
            .await
            .unwrap();
        serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    };
    let mine = my_gifs.as_array().unwrap().iter().find(|e| e["id"] == id).unwrap();
    assert_eq!(mine["is_favourited"], false);

    let library_logged_out: serde_json::Value = {
        let response = test_app
            .app
            .clone()
            .oneshot(Request::builder().uri("/api/library").body(Body::empty()).unwrap())
            .await
            .unwrap();
        serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    };
    let logged_out_entry = library_logged_out.as_array().unwrap().iter().find(|e| e["id"] == id).unwrap();
    assert_eq!(logged_out_entry["is_favourited"], false);
}
