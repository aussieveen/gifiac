use axum::body::Body;
use axum::http::{Request, StatusCode};
use tempfile::TempDir;
use tower::ServiceExt;

mod common;
use common::{make_test_video, multipart_body, spawn_app};

#[tokio::test]
async fn upload_probes_generates_thumbnail_and_lists_the_video() {
    let test_app = spawn_app().await;
    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_test_video(fixture_dir.path(), 2.0);
    let video_bytes = std::fs::read(&video_path).unwrap();

    let (boundary, body) = multipart_body("file", "my-clip.mp4", "video/mp4", video_bytes);

    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/videos")
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::CREATED);
    let body_bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let video: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();

    assert_eq!(video["original_filename"], "my-clip.mp4");
    assert_eq!(video["extension"], "mp4");
    assert_eq!(video["width"], 320);
    assert_eq!(video["height"], 240);
    assert!(video["duration_seconds"].as_f64().unwrap() > 1.0);
    let id = video["id"].as_str().unwrap().to_string();

    // GET /api/videos lists it, newest first.
    let list_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/videos")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::OK);
    let list_bytes = axum::body::to_bytes(list_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let list: serde_json::Value = serde_json::from_slice(&list_bytes).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["id"], id);

    // GET /api/videos/{id}
    let get_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/videos/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);

    // GET /api/videos/{id}/thumbnail — poster frame generated synchronously at upload.
    let thumb_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/videos/{id}/thumbnail"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(thumb_response.status(), StatusCode::OK);
    let thumb_bytes = axum::body::to_bytes(thumb_response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(!thumb_bytes.is_empty());

    // GET /api/videos/{id}/filmstrip — metadata.
    let filmstrip_meta_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/videos/{id}/filmstrip"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(filmstrip_meta_response.status(), StatusCode::OK);
    let meta_bytes = axum::body::to_bytes(filmstrip_meta_response.into_body(), usize::MAX)
        .await
        .unwrap();
    let meta: serde_json::Value = serde_json::from_slice(&meta_bytes).unwrap();
    assert_eq!(meta["imageUrl"], format!("/api/videos/{id}/filmstrip.jpg"));
    assert!(meta["frameCount"].as_u64().unwrap() >= 1);

    // GET /api/videos/{id}/filmstrip.jpg — generated on demand.
    let filmstrip_image_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/videos/{id}/filmstrip.jpg"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(filmstrip_image_response.status(), StatusCode::OK);
    let sprite_bytes = axum::body::to_bytes(filmstrip_image_response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(!sprite_bytes.is_empty());
}

#[tokio::test]
async fn get_unknown_video_returns_404() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .oneshot(
            Request::builder()
                .uri("/api/videos/00000000-0000-0000-0000-000000000000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn upload_without_extension_is_rejected() {
    let test_app = spawn_app().await;
    let (boundary, body) = multipart_body("file", "no-extension", "video/mp4", vec![0u8; 16]);

    let response = test_app
        .app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/videos")
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn upload_of_unparseable_video_is_rejected_and_leaves_no_file_behind() {
    let test_app = spawn_app().await;
    let (boundary, body) = multipart_body(
        "file",
        "junk.mp4",
        "video/mp4",
        b"not a real video".to_vec(),
    );

    let response = test_app
        .app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/videos")
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);

    let leftover: Vec<_> = std::fs::read_dir(&test_app.video_dir).unwrap().collect();
    assert!(
        leftover.is_empty(),
        "expected no files left behind after a failed probe, found: {leftover:?}"
    );
}
