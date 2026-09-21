use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

mod common;
use common::{authed, create_gif, login_as, spawn_app};

#[tokio::test]
async fn list_gifs_returns_everything_newest_first_with_no_query() {
    let test_app = spawn_app().await;
    create_gif(&test_app, "first", "").await;
    create_gif(&test_app, "second", "").await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri("/api/gifs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let gifs: Vec<serde_json::Value> = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let names: Vec<&str> = gifs.iter().map(|g| g.get("name").unwrap().as_str().unwrap()).collect();
    assert_eq!(names, vec!["second", "first"]);
}

#[tokio::test]
async fn list_gifs_filters_by_the_q_param_against_name_and_caption_text() {
    let test_app = spawn_app().await;
    create_gif(&test_app, "cat jumping", "").await;
    create_gif(&test_app, "dog running", "a cat meows").await;
    create_gif(&test_app, "bird flying", "").await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri("/api/gifs?q=cat")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let gifs: Vec<serde_json::Value> = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let names: Vec<&str> = gifs.iter().map(|g| g.get("name").unwrap().as_str().unwrap()).collect();
    assert_eq!(names, vec!["dog running", "cat jumping"]);
}

#[tokio::test]
async fn get_gif_returns_the_full_row_including_captions_json() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "my gif", "hello there").await;
    let id = gif["id"].as_str().unwrap();

    let response = test_app
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
    assert_eq!(response.status(), StatusCode::OK);

    let fetched: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(fetched["id"], id);
    assert_eq!(fetched["caption_text"], "hello there");
    assert!(!fetched["captions_json"].is_null());
    assert_eq!(
        fetched["gif_url"],
        test_app.storage.public_url(&format!("gifs/{id}.gif"))
    );
    assert_eq!(
        fetched["mp4_url"],
        test_app.storage.public_url(&format!("clips/{id}.mp4"))
    );
    assert_eq!(
        fetched["webm_url"],
        test_app.storage.public_url(&format!("clips/{id}.webm"))
    );
}

#[tokio::test]
async fn get_unknown_gif_returns_404() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri("/api/gifs/00000000-0000-0000-0000-000000000000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn rename_gif_updates_the_name_without_a_re_export() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "old name", "").await;
    let id = gif["id"].as_str().unwrap();

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "name": "new name" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let renamed: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(renamed["name"], "new name");
}

#[tokio::test]
async fn rename_gif_with_an_empty_name_is_rejected() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "old name", "").await;
    let id = gif["id"].as_str().unwrap();

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "name": "   " }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rename_unknown_gif_returns_404() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri("/api/gifs/00000000-0000-0000-0000-000000000000")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "name": "x" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn patch_gif_with_neither_field_is_rejected() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "old name", "").await;
    let id = gif["id"].as_str().unwrap();

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn patch_gif_toggles_is_one_off_and_back() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "a one-off gif", "").await;
    let id = gif["id"].as_str().unwrap();
    assert_eq!(gif["is_one_off"], false);

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_one_off": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let marked: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(marked["is_one_off"], true);

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_one_off": false }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let unmarked: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(unmarked["is_one_off"], false);
}

#[tokio::test]
async fn list_gifs_sorts_one_off_gifs_after_reusable_gifs() {
    let test_app = spawn_app().await;
    let reusable = create_gif(&test_app, "reusable", "").await;
    let one_off = create_gif(&test_app, "one-off", "").await;
    let one_off_id = one_off["id"].as_str().unwrap();

    test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{one_off_id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_one_off": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri("/api/gifs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let gifs: Vec<serde_json::Value> = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    // "one-off" was created after "reusable" (newer), but the one-off
    // flag still sorts it last, after all reusable GIFs (SPEC.md §8).
    let ids: Vec<&str> = gifs.iter().map(|g| g.get("id").unwrap().as_str().unwrap()).collect();
    assert_eq!(ids, vec![reusable["id"].as_str().unwrap(), one_off_id]);
}

#[tokio::test]
async fn delete_gif_removes_the_row_and_all_three_r2_objects() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "to delete", "").await;
    let id = gif["id"].as_str().unwrap().to_string();

    // Confirm the objects actually exist first, so the post-delete checks
    // below prove something real was removed.
    let gif_url = test_app.storage.public_url(&format!("gifs/{id}.gif"));
    assert!(reqwest::get(&gif_url).await.unwrap().status().is_success());

    let response = test_app
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
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

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

    assert!(!reqwest::get(&gif_url).await.unwrap().status().is_success());
    let mp4_url = test_app.storage.public_url(&format!("clips/{id}.mp4"));
    assert!(!reqwest::get(&mp4_url).await.unwrap().status().is_success());
    let webm_url = test_app.storage.public_url(&format!("clips/{id}.webm"));
    assert!(!reqwest::get(&webm_url).await.unwrap().status().is_success());
}

#[tokio::test]
async fn list_gifs_with_no_session_cookie_is_rejected() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(Request::builder().uri("/api/gifs").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// SPEC-CLOUD.md §3: another user's gif simply doesn't resolve (same 404
/// as a nonexistent id), can't be renamed or deleted, and is absent from
/// their own `GET /api/gifs` list.
#[tokio::test]
async fn a_second_user_cannot_see_fetch_rename_or_delete_the_first_users_gif() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "mine", "").await;
    let id = gif["id"].as_str().unwrap();

    let other_cookie = login_as(&test_app, "other@example.com").await;

    let get_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/gifs/{id}"))
                .header("cookie", &other_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::NOT_FOUND);

    let list_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/gifs")
                .header("cookie", &other_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let list: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(list.as_array().unwrap().is_empty());

    let rename_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/api/gifs/{id}"))
                .header("content-type", "application/json")
                .header("cookie", &other_cookie)
                .body(Body::from(json!({ "name": "hijacked" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rename_response.status(), StatusCode::NOT_FOUND);

    let delete_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/gifs/{id}"))
                .header("cookie", &other_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_unknown_gif_returns_404() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri("/api/gifs/00000000-0000-0000-0000-000000000000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn patch_gif_toggles_is_public_and_back() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "a shareable gif", "").await;
    let id = gif["id"].as_str().unwrap();
    assert_eq!(gif["is_public"], false);

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_public": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let shared: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(shared["is_public"], true);

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_public": false }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let unshared: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(unshared["is_public"], false);
}

/// SPEC-CLOUD.md §8: the global library is public — reachable with no
/// session at all — and only ever shows what's actually been shared.
#[tokio::test]
async fn get_library_requires_no_auth_and_includes_only_public_gifs_with_attribution() {
    let test_app = spawn_app().await;

    let handle_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PUT")
                .uri("/api/users/me/handle")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "handle": "libtest" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(handle_response.status(), StatusCode::OK);

    let public_gif = create_gif(&test_app, "public one", "").await;
    let public_id = public_gif["id"].as_str().unwrap();
    let private_gif = create_gif(&test_app, "private one", "").await;
    let private_id = private_gif["id"].as_str().unwrap();

    let make_public = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PATCH")
                .uri(format!("/api/gifs/{public_id}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "is_public": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(make_public.status(), StatusCode::OK);

    // No cookie at all — the library is public.
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/library")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let entries: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let entries = entries.as_array().unwrap();
    assert!(entries.iter().any(|e| e["id"] == public_id));
    assert!(!entries.iter().any(|e| e["id"] == private_id));
    let entry = entries.iter().find(|e| e["id"] == public_id).unwrap();
    assert_eq!(entry["owner_handle"], "libtest");
}

#[tokio::test]
async fn get_library_filters_by_q() {
    let test_app = spawn_app().await;
    let cat_gif = create_gif(&test_app, "cat jumping", "").await;
    let dog_gif = create_gif(&test_app, "dog running", "").await;

    for id in [cat_gif["id"].as_str().unwrap(), dog_gif["id"].as_str().unwrap()] {
        let response = test_app
            .app
            .clone()
            .oneshot(
                authed(&test_app, Request::builder())
                    .method("PATCH")
                    .uri(format!("/api/gifs/{id}"))
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "is_public": true }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/library?q=cat")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let entries: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let entries = entries.as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["id"], cat_gif["id"]);
}
