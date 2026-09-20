use axum::body::Body;
use axum::http::{Request, StatusCode};
use tempfile::TempDir;
use tower::ServiceExt;

mod common;
use common::{authed, make_test_gif, multipart_body, multipart_body_multi, spawn_app};

#[tokio::test]
async fn import_creates_a_gif_row_with_all_three_formats_and_no_source_video() {
    let test_app = spawn_app().await;
    let fixture_dir = TempDir::new().unwrap();
    let gif_path = make_test_gif(fixture_dir.path(), 1.0);
    let gif_bytes = std::fs::read(&gif_path).unwrap();
    let (boundary, body) = multipart_body("files", "my-import.gif", "image/gif", gif_bytes);

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/import")
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
    let created: Vec<serde_json::Value> = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(created.len(), 1);
    let gif = &created[0];

    // Filename extension stripped, per SPEC.md §7.
    assert_eq!(gif["name"], "my-import");
    assert!(gif["video_id"].is_null());
    assert!(gif["captions_json"].is_null());
    assert_eq!(gif["caption_text"], "");
    assert!(gif["width"].as_i64().unwrap() > 0);
    assert!(gif["height"].as_i64().unwrap() > 0);
    let id = gif["id"].as_str().unwrap();

    // Every format got filled in, uploaded to the same key convention as
    // a real export — actually fetchable from MinIO, not just claimed.
    let gif_bytes = reqwest::get(test_app.storage.public_url(&format!("gifs/{id}.gif")))
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert!(gif_bytes.starts_with(b"GIF89a") || gif_bytes.starts_with(b"GIF87a"));

    let mp4_status = reqwest::get(test_app.storage.public_url(&format!("clips/{id}.mp4")))
        .await
        .unwrap()
        .status();
    assert!(mp4_status.is_success());

    let webm_status = reqwest::get(test_app.storage.public_url(&format!("clips/{id}.webm")))
        .await
        .unwrap()
        .status();
    assert!(webm_status.is_success());

    // And the archive endpoints see it like any other gif.
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
}

#[tokio::test]
async fn import_accepts_multiple_files_in_one_request() {
    let test_app = spawn_app().await;
    let fixture_dir = TempDir::new().unwrap();
    let gif_path = make_test_gif(fixture_dir.path(), 1.0);
    let gif_bytes = std::fs::read(&gif_path).unwrap();

    let (boundary, body) = multipart_body_multi(&[
        ("files", "first.gif", "image/gif", gif_bytes.clone()),
        ("files", "second.gif", "image/gif", gif_bytes),
    ]);

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/import")
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
    let created: Vec<serde_json::Value> = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let names: Vec<&str> = created.iter().map(|g| g["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["first", "second"]);
}

#[tokio::test]
async fn import_of_an_unparseable_file_is_rejected() {
    let test_app = spawn_app().await;
    let (boundary, body) = multipart_body(
        "files",
        "junk.gif",
        "image/gif",
        b"not a real gif".to_vec(),
    );

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/import")
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
async fn import_with_no_files_is_rejected() {
    let test_app = spawn_app().await;
    let (boundary, body) = multipart_body_multi(&[]);

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/gifs/import")
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
