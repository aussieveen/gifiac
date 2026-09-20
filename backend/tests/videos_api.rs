use axum::body::Body;
use axum::http::{Request, StatusCode};
use tempfile::TempDir;
use tower::ServiceExt;

mod common;
use common::{authed, create_gif, login_as, make_large_test_video, make_test_video, multipart_body, spawn_app};

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
            authed(&test_app, Request::builder())
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
            authed(&test_app, Request::builder())
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
            authed(&test_app, Request::builder())
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
            authed(&test_app, Request::builder())
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
            authed(&test_app, Request::builder())
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
            authed(&test_app, Request::builder())
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
async fn upload_accepts_a_file_well_over_axums_default_2mb_body_limit() {
    let test_app = spawn_app().await;
    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_large_test_video(fixture_dir.path());
    let video_bytes = std::fs::read(&video_path).unwrap();
    assert!(
        video_bytes.len() > 2 * 1024 * 1024,
        "fixture is only {} bytes, not actually over the old 2MB default",
        video_bytes.len()
    );

    let (boundary, body) = multipart_body("file", "large-clip.mp4", "video/mp4", video_bytes);

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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
}

#[tokio::test]
async fn video_file_serves_full_content_and_honors_range_requests() {
    let test_app = spawn_app().await;
    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_test_video(fixture_dir.path(), 2.0);
    let video_bytes = std::fs::read(&video_path).unwrap();
    let (boundary, body) = multipart_body("file", "clip.mp4", "video/mp4", video_bytes.clone());

    let upload_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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
    assert_eq!(upload_response.status(), StatusCode::CREATED);
    let uploaded: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(upload_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let id = uploaded["id"].as_str().unwrap();

    // No Range header -> the whole file, 200.
    let full_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/videos/{id}/file"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(full_response.status(), StatusCode::OK);
    assert_eq!(
        full_response.headers().get("accept-ranges").unwrap(),
        "bytes"
    );
    let full_bytes = axum::body::to_bytes(full_response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(full_bytes.len(), video_bytes.len());

    // A byte-range request -> 206 Partial Content with just that slice —
    // this is what makes `<video>` seeking fast/smooth instead of
    // re-downloading the whole file on every seek.
    let range_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/videos/{id}/file"))
                .header("range", "bytes=0-99")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(range_response.status(), StatusCode::PARTIAL_CONTENT);
    let range_bytes = axum::body::to_bytes(range_response.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(range_bytes.len(), 100);
    assert_eq!(&range_bytes[..], &video_bytes[0..100]);
}

#[tokio::test]
async fn video_file_for_unknown_video_returns_404() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri("/api/videos/00000000-0000-0000-0000-000000000000/file")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn get_unknown_video_returns_404() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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

#[tokio::test]
async fn delete_video_removes_the_row_and_its_files() {
    let test_app = spawn_app().await;
    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_test_video(fixture_dir.path(), 2.0);
    let video_bytes = std::fs::read(&video_path).unwrap();
    let (boundary, body) = multipart_body("file", "clip.mp4", "video/mp4", video_bytes);
    let upload_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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
    let video: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(upload_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let id = video["id"].as_str().unwrap();

    // Touch the filmstrip endpoint so a sprite file actually exists on
    // disk to verify gets cleaned up too (it's generated on demand, per
    // SPEC.md §3, not at upload time).
    test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/videos/{id}/filmstrip.jpg"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri(format!("/api/videos/{id}"))
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
                .uri(format!("/api/videos/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::NOT_FOUND);

    let leftover: Vec<_> = std::fs::read_dir(&test_app.video_dir).unwrap().collect();
    assert!(
        leftover.is_empty(),
        "expected the video/thumbnail/filmstrip files to be removed, found: {leftover:?}"
    );
}

/// SPEC.md §12 replaced the old "no GIFs were made from it" guard
/// entirely — a video with GIFs made from it is now fine to delete. The
/// dependent GIF's `video_id` becomes NULL (ON DELETE SET NULL), which is
/// exactly the existing "no source video" case the archive UI already
/// treats as un-re-editable.
#[tokio::test]
async fn delete_video_succeeds_even_when_a_gif_was_made_from_it() {
    let test_app = spawn_app().await;
    let gif = create_gif(&test_app, "depends on this video", "").await;
    let video_id = gif["video_id"].as_str().unwrap().to_string();
    let gif_id = gif["id"].as_str().unwrap().to_string();

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri(format!("/api/videos/{video_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    let gif_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/gifs/{gif_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(gif_response.status(), StatusCode::OK);
    let gif_after: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(gif_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert!(gif_after["video_id"].is_null());
}

#[tokio::test]
async fn delete_video_is_rejected_with_409_when_it_has_a_template() {
    let test_app = spawn_app().await;
    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_test_video(fixture_dir.path(), 2.0);
    let video_bytes = std::fs::read(&video_path).unwrap();
    let (boundary, body) = multipart_body("file", "clip.mp4", "video/mp4", video_bytes);
    let upload_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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
    let video: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(upload_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let id = video["id"].as_str().unwrap();

    let template_body = serde_json::json!({
        "captions": [],
        "gif_range_start": 0.0,
        "gif_range_end": 1.0,
        "width": 480,
        "height": 270
    });
    let put_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PUT")
                .uri(format!("/api/videos/{id}/template"))
                .header("content-type", "application/json")
                .body(Body::from(template_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(put_response.status(), StatusCode::OK);

    let delete_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri(format!("/api/videos/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::CONFLICT);

    // Removing the template first clears the way to delete the video.
    let delete_template_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri(format!("/api/videos/{id}/template"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_template_response.status(), StatusCode::NO_CONTENT);

    let delete_response2 = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri(format!("/api/videos/{id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_response2.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn get_template_returns_404_when_none_is_saved() {
    let test_app = spawn_app().await;
    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_test_video(fixture_dir.path(), 2.0);
    let video_bytes = std::fs::read(&video_path).unwrap();
    let (boundary, body) = multipart_body("file", "clip.mp4", "video/mp4", video_bytes);
    let upload_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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
    let video: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(upload_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let id = video["id"].as_str().unwrap();

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/videos/{id}/template"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// `PUT .../template` upserts (creates, then overwrites) and `GET
/// /api/videos` surfaces `has_template` for the video-picker badge.
#[tokio::test]
async fn put_template_upserts_and_list_videos_reports_has_template() {
    let test_app = spawn_app().await;
    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_test_video(fixture_dir.path(), 2.0);
    let video_bytes = std::fs::read(&video_path).unwrap();
    let (boundary, body) = multipart_body("file", "clip.mp4", "video/mp4", video_bytes);
    let upload_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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
    let video: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(upload_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let id = video["id"].as_str().unwrap();

    let list_before = test_app
        .app
        .clone()
        .oneshot(authed(&test_app, Request::builder()).uri("/api/videos").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let list_before: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(list_before.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(list_before[0]["has_template"], false);

    let template_body = serde_json::json!({
        "captions": [{
            "id": "c1", "startTime": 0.0, "endTime": 1.0, "text": "hi",
            "fontFamily": "Impact, sans-serif", "fontSize": 28, "color": "#ffffff",
            "align": "center", "x": 0.5, "y": 0.88
        }],
        "gif_range_start": 0.0,
        "gif_range_end": 1.5,
        "width": 480,
        "height": 270
    });
    let put_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PUT")
                .uri(format!("/api/videos/{id}/template"))
                .header("content-type", "application/json")
                .body(Body::from(template_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(put_response.status(), StatusCode::OK);

    let get_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/videos/{id}/template"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);
    let fetched: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(get_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(fetched["gif_range_end"], 1.5);
    assert_eq!(fetched["captions"][0]["text"], "hi");

    let list_after = test_app
        .app
        .clone()
        .oneshot(authed(&test_app, Request::builder()).uri("/api/videos").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let list_after: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(list_after.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(list_after[0]["has_template"], true);

    // SPEC-CLOUD.md §4: saving a template trims the source video into its
    // own independent clip file + a first-frame thumbnail, on disk right
    // alongside the source video/thumbnail files.
    let (clip_path, thumb_path) = template_asset_paths(&test_app);
    assert!(clip_path.exists(), "expected a template clip file on disk");
    assert!(thumb_path.exists(), "expected a template thumbnail file on disk");
    let first_probe = gifiac_backend::ffmpeg::probe_video(&clip_path).unwrap();
    assert!(
        first_probe.duration_seconds < 2.0,
        "template clip should be trimmed to ~1.5s, not the 2.0s source, got {}",
        first_probe.duration_seconds
    );

    // Overwriting with a different range regenerates the same files in
    // place (same template id — reused via `db::get_template_id`) rather
    // than orphaning the previous save's.
    let overwrite_body = serde_json::json!({
        "captions": [],
        "gif_range_start": 0.0,
        "gif_range_end": 0.5,
        "width": 480,
        "height": 270
    });
    let overwrite_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("PUT")
                .uri(format!("/api/videos/{id}/template"))
                .header("content-type", "application/json")
                .body(Body::from(overwrite_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(overwrite_response.status(), StatusCode::OK);
    let (clip_path_after_overwrite, _) = template_asset_paths(&test_app);
    assert_eq!(
        clip_path, clip_path_after_overwrite,
        "overwrite should reuse the same template id/file, not create a second one"
    );
    let second_probe = gifiac_backend::ffmpeg::probe_video(&clip_path).unwrap();
    assert!(
        second_probe.duration_seconds < first_probe.duration_seconds,
        "overwrite should have regenerated the clip to the new, shorter range"
    );

    let delete_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri(format!("/api/videos/{id}/template"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
    assert!(!clip_path.exists(), "expected the template clip file to be removed");
    assert!(!thumb_path.exists(), "expected the template thumbnail file to be removed");
}

/// Locates the template clip/thumbnail files written to `test_app`'s
/// video dir by filename suffix — the API never exposes the template's
/// internal id, so tests find the files the same way a human debugging
/// this on a real box would.
fn template_asset_paths(test_app: &common::TestApp) -> (std::path::PathBuf, std::path::PathBuf) {
    let entries: Vec<_> = std::fs::read_dir(&test_app.video_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    let clip = entries
        .iter()
        .find(|e| e.file_name().to_string_lossy().ends_with("_template.mp4"))
        .expect("expected a template clip file")
        .path();
    let thumb = entries
        .iter()
        .find(|e| e.file_name().to_string_lossy().ends_with("_template_thumb.jpg"))
        .expect("expected a template thumbnail file")
        .path();
    (clip, thumb)
}

#[tokio::test]
async fn delete_template_for_unknown_video_returns_404() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri("/api/videos/00000000-0000-0000-0000-000000000000/template")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn list_and_get_video_with_no_session_cookie_is_rejected() {
    let test_app = spawn_app().await;

    let list_response = test_app
        .app
        .clone()
        .oneshot(Request::builder().uri("/api/videos").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(list_response.status(), StatusCode::UNAUTHORIZED);

    let get_response = test_app
        .app
        .oneshot(
            Request::builder()
                .uri("/api/videos/00000000-0000-0000-0000-000000000000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::UNAUTHORIZED);
}

/// SPEC-CLOUD.md §3: another user's video simply doesn't resolve — same
/// 404 as a nonexistent id, and it's absent from their own `GET
/// /api/videos` list entirely, not just blocked from direct access.
#[tokio::test]
async fn a_second_user_cannot_see_or_fetch_the_first_users_video() {
    let test_app = spawn_app().await;
    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_test_video(fixture_dir.path(), 2.0);
    let video_bytes = std::fs::read(&video_path).unwrap();
    let (boundary, body) = multipart_body("file", "clip.mp4", "video/mp4", video_bytes);
    let upload_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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
    let video: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(upload_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let id = video["id"].as_str().unwrap();

    let other_cookie = login_as(&test_app, "other@example.com").await;

    let get_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/videos/{id}"))
                .header("cookie", &other_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::NOT_FOUND);

    let list_response = test_app
        .app
        .oneshot(
            Request::builder()
                .uri("/api/videos")
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
}

#[tokio::test]
async fn delete_unknown_video_returns_404() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("DELETE")
                .uri("/api/videos/00000000-0000-0000-0000-000000000000")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
