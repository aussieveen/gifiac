use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

mod common;
use common::{create_gif, spawn_app};

#[tokio::test]
async fn list_gifs_returns_everything_newest_first_with_no_query() {
    let test_app = spawn_app().await;
    create_gif(&test_app, "first", "").await;
    create_gif(&test_app, "second", "").await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
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
            Request::builder()
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
            Request::builder()
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
        .oneshot(
            Request::builder()
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
            Request::builder()
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
        .oneshot(
            Request::builder()
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
        .oneshot(
            Request::builder()
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
            Request::builder()
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
        .oneshot(
            Request::builder()
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
async fn delete_unknown_gif_returns_404() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/gifs/00000000-0000-0000-0000-000000000000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
