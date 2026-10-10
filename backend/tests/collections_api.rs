//! collections-design/COLLECTIONS.md: named, unordered groupings of gifs,
//! replacing the flat `favourites` table that `tests/favourites_api.rs`
//! still exercises via the unchanged `/gifs/{id}/favourite` shortcut.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Value, json};
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

async fn list_collections(test_app: &common::TestApp, cookie: &str) -> Value {
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/collections")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

async fn create_collection(test_app: &common::TestApp, cookie: &str, name: &str) -> axum::response::Response {
    test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/collections")
                .header("cookie", cookie)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "name": name }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn rename_collection(test_app: &common::TestApp, cookie: &str, id: &str, name: &str) -> axum::response::Response {
    test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/collections/{id}"))
                .header("cookie", cookie)
                .header("content-type", "application/json")
                .body(Body::from(json!({ "name": name }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn delete_collection(test_app: &common::TestApp, cookie: &str, id: &str) -> axum::response::Response {
    test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/collections/{id}"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn add_gif(test_app: &common::TestApp, cookie: &str, collection_id: &str, gif_id: &str) -> axum::response::Response {
    test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/collections/{collection_id}/gifs/{gif_id}"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn remove_gif(test_app: &common::TestApp, cookie: &str, collection_id: &str, gif_id: &str) -> axum::response::Response {
    test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/collections/{collection_id}/gifs/{gif_id}"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn list_collection_gifs(test_app: &common::TestApp, cookie: &str, collection_id: &str) -> axum::response::Response {
    test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/collections/{collection_id}/gifs"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn gif_collections(test_app: &common::TestApp, cookie: &str, gif_id: &str) -> Value {
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/gifs/{gif_id}/collections"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

fn find_by_name<'a>(collections: &'a Value, name: &str) -> Option<&'a Value> {
    collections.as_array().unwrap().iter().find(|c| c["name"] == name)
}

#[tokio::test]
async fn new_user_has_no_collections_until_first_use() {
    let test_app = spawn_app().await;
    let collections = list_collections(&test_app, &test_app.owner_cookie).await;
    assert!(collections.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn creating_a_collection_adds_it_alphabetically_after_favourites() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "a gif", "").await;
    let id = gif["id"].as_str().unwrap();

    // Create Favourites first, via the star shortcut, then two custom
    // collections out of alphabetical order.
    patch_is_public(&test_app, id, true).await;
    test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri(format!("/api/gifs/{id}/favourite"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(create_collection(&test_app, &test_app.owner_cookie, "Roadtrip").await.status(), StatusCode::CREATED);
    assert_eq!(create_collection(&test_app, &test_app.owner_cookie, "Avatars").await.status(), StatusCode::CREATED);

    let collections = list_collections(&test_app, &test_app.owner_cookie).await;
    let names: Vec<&str> = collections.as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Favourites", "Avatars", "Roadtrip"]);
}

#[tokio::test]
async fn collection_name_must_be_unique_per_owner_case_insensitively() {
    let test_app = spawn_app().await;
    assert_eq!(create_collection(&test_app, &test_app.owner_cookie, "Roadtrip").await.status(), StatusCode::CREATED);

    let response = create_collection(&test_app, &test_app.owner_cookie, "roadtrip").await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn favourites_is_a_reserved_name() {
    let test_app = spawn_app().await;
    let response = create_collection(&test_app, &test_app.owner_cookie, "Favourites").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let response = create_collection(&test_app, &test_app.owner_cookie, "FAVOURITES").await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn blank_and_overlong_names_are_rejected() {
    let test_app = spawn_app().await;
    assert_eq!(create_collection(&test_app, &test_app.owner_cookie, "   ").await.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        create_collection(&test_app, &test_app.owner_cookie, &"x".repeat(41)).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(create_collection(&test_app, &test_app.owner_cookie, &"x".repeat(40)).await.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn renaming_and_deleting_a_custom_collection_works() {
    let test_app = spawn_app().await;
    let response = create_collection(&test_app, &test_app.owner_cookie, "Roadtrip").await;
    let body: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let id = body["id"].as_str().unwrap();

    let response = rename_collection(&test_app, &test_app.owner_cookie, id, "2026 Roadtrip").await;
    assert_eq!(response.status(), StatusCode::OK);
    let collections = list_collections(&test_app, &test_app.owner_cookie).await;
    assert!(find_by_name(&collections, "2026 Roadtrip").is_some());

    assert_eq!(delete_collection(&test_app, &test_app.owner_cookie, id).await.status(), StatusCode::NO_CONTENT);
    let collections = list_collections(&test_app, &test_app.owner_cookie).await;
    assert!(collections.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn deleting_a_collection_does_not_delete_its_gifs_or_remove_them_from_other_collections() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "survives deletion", "").await;
    let gif_id = gif["id"].as_str().unwrap();

    let a = create_collection(&test_app, &test_app.owner_cookie, "A").await;
    let a_id = {
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(a.into_body(), usize::MAX).await.unwrap()).unwrap();
        body["id"].as_str().unwrap().to_string()
    };
    let b = create_collection(&test_app, &test_app.owner_cookie, "B").await;
    let b_id = {
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(b.into_body(), usize::MAX).await.unwrap()).unwrap();
        body["id"].as_str().unwrap().to_string()
    };

    assert_eq!(add_gif(&test_app, &test_app.owner_cookie, &a_id, gif_id).await.status(), StatusCode::NO_CONTENT);
    assert_eq!(add_gif(&test_app, &test_app.owner_cookie, &b_id, gif_id).await.status(), StatusCode::NO_CONTENT);

    assert_eq!(delete_collection(&test_app, &test_app.owner_cookie, &a_id).await.status(), StatusCode::NO_CONTENT);

    // The gif is still in the library...
    let my_gifs = test_app
        .app
        .clone()
        .oneshot(authed(&test_app, Request::builder()).uri("/api/gifs").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let my_gifs: Value = serde_json::from_slice(&axum::body::to_bytes(my_gifs.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(my_gifs["items"].as_array().unwrap().iter().any(|g| g["id"] == gif_id));

    // ...and still in collection B.
    let response = list_collection_gifs(&test_app, &test_app.owner_cookie, &b_id).await;
    assert_eq!(response.status(), StatusCode::OK);
    let gifs: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(gifs.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn favourites_collection_cannot_be_renamed_or_deleted() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "a gif", "").await;
    let id = gif["id"].as_str().unwrap();
    patch_is_public(&test_app, id, true).await;
    test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri(format!("/api/gifs/{id}/favourite"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let collections = list_collections(&test_app, &test_app.owner_cookie).await;
    let favourites_id = find_by_name(&collections, "Favourites").unwrap()["id"].as_str().unwrap();

    assert_eq!(
        rename_collection(&test_app, &test_app.owner_cookie, favourites_id, "Nope").await.status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(delete_collection(&test_app, &test_app.owner_cookie, favourites_id).await.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_collection_can_hold_your_own_and_others_public_gifs_but_not_others_private_gifs() {
    let test_app = spawn_app().await;
    let public_gif = create_gif(&test_app, "owner's public gif", "").await;
    patch_is_public(&test_app, public_gif["id"].as_str().unwrap(), true).await;
    let private_gif = create_gif(&test_app, "owner's private gif", "").await;

    let other_cookie = login_as(&test_app, "other@example.com").await;
    let collection = create_collection(&test_app, &other_cookie, "Faves from others").await;
    let collection_id = {
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(collection.into_body(), usize::MAX).await.unwrap()).unwrap();
        body["id"].as_str().unwrap().to_string()
    };

    assert_eq!(
        add_gif(&test_app, &other_cookie, &collection_id, public_gif["id"].as_str().unwrap()).await.status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        add_gif(&test_app, &other_cookie, &collection_id, private_gif["id"].as_str().unwrap()).await.status(),
        StatusCode::NOT_FOUND
    );

    let response = list_collection_gifs(&test_app, &other_cookie, &collection_id).await;
    let gifs: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    let ids: Vec<&str> = gifs.as_array().unwrap().iter().map(|g| g["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![public_gif["id"].as_str().unwrap()]);
}

#[tokio::test]
async fn a_collected_gif_disappears_when_made_private_and_reappears_when_republished() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "here today", "").await;
    let id = gif["id"].as_str().unwrap();
    patch_is_public(&test_app, id, true).await;

    let other_cookie = login_as(&test_app, "other@example.com").await;
    let collection = create_collection(&test_app, &other_cookie, "Collected").await;
    let collection_id = {
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(collection.into_body(), usize::MAX).await.unwrap()).unwrap();
        body["id"].as_str().unwrap().to_string()
    };
    add_gif(&test_app, &other_cookie, &collection_id, id).await;

    patch_is_public(&test_app, id, false).await;
    let response = list_collection_gifs(&test_app, &other_cookie, &collection_id).await;
    let gifs: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(gifs.as_array().unwrap().is_empty(), "a privated gif must disappear from someone else's collection");

    let collections = list_collections(&test_app, &other_cookie).await;
    assert_eq!(find_by_name(&collections, "Collected").unwrap()["gifCount"], 0);

    patch_is_public(&test_app, id, true).await;
    let response = list_collection_gifs(&test_app, &other_cookie, &collection_id).await;
    let gifs: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(gifs.as_array().unwrap().len(), 1, "re-publishing must silently bring it back");
}

#[tokio::test]
async fn removing_a_gif_from_a_collection_is_idempotent_and_leaves_other_collections_alone() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "a gif", "").await;
    let id = gif["id"].as_str().unwrap();

    let a = create_collection(&test_app, &test_app.owner_cookie, "A").await;
    let a_id = {
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(a.into_body(), usize::MAX).await.unwrap()).unwrap();
        body["id"].as_str().unwrap().to_string()
    };
    let b = create_collection(&test_app, &test_app.owner_cookie, "B").await;
    let b_id = {
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(b.into_body(), usize::MAX).await.unwrap()).unwrap();
        body["id"].as_str().unwrap().to_string()
    };
    add_gif(&test_app, &test_app.owner_cookie, &a_id, id).await;
    add_gif(&test_app, &test_app.owner_cookie, &b_id, id).await;

    assert_eq!(remove_gif(&test_app, &test_app.owner_cookie, &a_id, id).await.status(), StatusCode::NO_CONTENT);
    assert_eq!(remove_gif(&test_app, &test_app.owner_cookie, &a_id, id).await.status(), StatusCode::NO_CONTENT);

    let ids = gif_collections(&test_app, &test_app.owner_cookie, id).await;
    let ids: Vec<&str> = ids["collectionIds"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
    assert_eq!(ids, vec![b_id]);
}

#[tokio::test]
async fn a_user_cannot_see_or_modify_another_users_collection() {
    let test_app = spawn_app().await;
    let response = create_collection(&test_app, &test_app.owner_cookie, "Mine").await;
    let id = {
        let body: Value = serde_json::from_slice(&axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
        body["id"].as_str().unwrap().to_string()
    };

    let other_cookie = login_as(&test_app, "other@example.com").await;
    assert_eq!(rename_collection(&test_app, &other_cookie, &id, "Stolen").await.status(), StatusCode::NOT_FOUND);
    assert_eq!(delete_collection(&test_app, &other_cookie, &id).await.status(), StatusCode::NOT_FOUND);
    assert_eq!(list_collection_gifs(&test_app, &other_cookie, &id).await.status(), StatusCode::NOT_FOUND);
}
