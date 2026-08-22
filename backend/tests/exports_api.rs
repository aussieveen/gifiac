use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tempfile::TempDir;
use tower::ServiceExt;

mod common;
use common::{make_test_video, multipart_body, spawn_app};

/// Parses a raw SSE response body (`event: X\ndata: Y\n\n` blocks) into
/// `(event, data)` pairs, in the order they were sent.
fn parse_sse_events(body: &str) -> Vec<(String, String)> {
    body.split("\n\n")
        .filter(|block| !block.trim().is_empty())
        .map(|block| {
            let mut event = String::new();
            let mut data = String::new();
            for line in block.lines() {
                if let Some(rest) = line.strip_prefix("event: ") {
                    event = rest.to_string();
                } else if let Some(rest) = line.strip_prefix("data: ") {
                    data = rest.to_string();
                }
            }
            (event, data)
        })
        .collect()
}

async fn upload_video(test_app: &common::TestApp, duration_seconds: f64) -> serde_json::Value {
    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_test_video(fixture_dir.path(), duration_seconds);
    let video_bytes = std::fs::read(&video_path).unwrap();
    let (boundary, body) = multipart_body("file", "clip.mp4", "video/mp4", video_bytes);

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
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn export_pipeline_produces_a_gif_and_uploads_all_three_formats() {
    let test_app = spawn_app().await;
    let video = upload_video(&test_app, 6.0).await;
    let video_id = video["id"].as_str().unwrap();

    let request_body = json!({
        "video_id": video_id,
        "name": "  test export  ",
        "captions": [{
            "id": "c1",
            "startTime": 0.5,
            "endTime": 2.0,
            "text": "Just testing.",
            "fontFamily": "Impact, sans-serif",
            "fontSize": 28,
            "color": "#ffffff",
            "align": "center",
            "x": 0.5,
            "y": 0.88
        }],
        "gif_range_start": 0.0,
        "gif_range_end": 3.0
    });

    let create_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/exports")
                .header("content-type", "application/json")
                .body(Body::from(request_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create_response.status(), StatusCode::ACCEPTED);
    let accepted: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let export_id = accepted["export_id"].as_str().unwrap().to_string();

    // Drive the SSE stream to completion (it closes once the job's
    // broadcast sender is dropped) with a generous timeout so a real bug
    // that hangs the pipeline fails the test instead of the suite.
    let progress_response = tokio::time::timeout(
        Duration::from_secs(60),
        test_app.app.clone().oneshot(
            Request::builder()
                .uri(format!("/api/exports/{export_id}/progress"))
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .expect("SSE stream did not close within the timeout")
    .unwrap();
    assert_eq!(progress_response.status(), StatusCode::OK);

    let body_bytes = tokio::time::timeout(
        Duration::from_secs(60),
        axum::body::to_bytes(progress_response.into_body(), usize::MAX),
    )
    .await
    .expect("reading the SSE body did not finish within the timeout")
    .unwrap();
    let body_text = String::from_utf8(body_bytes.to_vec()).unwrap();
    let events = parse_sse_events(&body_text);

    assert!(!events.is_empty(), "expected at least one SSE event");
    let stage_names: Vec<&str> = events.iter().map(|(event, _)| event.as_str()).collect();
    for expected_stage in [
        "palette_gen",
        "encoding_gif",
        "encoding_mp4",
        "encoding_webm",
        "uploading",
    ] {
        assert!(
            stage_names.contains(&expected_stage),
            "expected a {expected_stage} event among {stage_names:?}"
        );
    }

    let (last_event, last_data) = events.last().unwrap();
    assert_eq!(
        last_event, "complete",
        "last SSE event should be `complete`, got {events:?}"
    );
    let gif: serde_json::Value = serde_json::from_str(last_data).unwrap();
    assert_eq!(gif["name"], "test export"); // trimmed
    assert_eq!(gif["video_id"], video_id);
    assert_eq!(gif["caption_text"], "Just testing.");
    assert!(gif["width"].as_i64().unwrap() > 0);
    assert!(gif["height"].as_i64().unwrap() > 0);
    let gif_id = gif["id"].as_str().unwrap().to_string();

    // The three output objects were actually uploaded and are fetchable —
    // this is the point of testing against real MinIO rather than mocking
    // the S3 client.
    let gif_bytes = reqwest::get(test_app.storage.public_url(&format!("gifs/{gif_id}.gif")))
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert!(gif_bytes.starts_with(b"GIF89a") || gif_bytes.starts_with(b"GIF87a"));

    let mp4_status = reqwest::get(test_app.storage.public_url(&format!("clips/{gif_id}.mp4")))
        .await
        .unwrap()
        .status();
    assert!(mp4_status.is_success());

    let webm_status = reqwest::get(test_app.storage.public_url(&format!("clips/{gif_id}.webm")))
        .await
        .unwrap()
        .status();
    assert!(webm_status.is_success());
}

#[tokio::test]
async fn export_with_empty_name_is_rejected() {
    let test_app = spawn_app().await;
    let video = upload_video(&test_app, 3.0).await;

    let request_body = json!({
        "video_id": video["id"],
        "name": "   ",
        "captions": [],
        "gif_range_start": 0.0,
        "gif_range_end": 1.0
    });

    let response = test_app
        .app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/exports")
                .header("content-type", "application/json")
                .body(Body::from(request_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn export_for_unknown_video_returns_404() {
    let test_app = spawn_app().await;

    let request_body = json!({
        "video_id": "00000000-0000-0000-0000-000000000000",
        "name": "whatever",
        "captions": [],
        "gif_range_start": 0.0,
        "gif_range_end": 1.0
    });

    let response = test_app
        .app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/exports")
                .header("content-type", "application/json")
                .body(Body::from(request_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn progress_for_unknown_export_returns_404() {
    let test_app = spawn_app().await;

    let response = test_app
        .app
        .oneshot(
            Request::builder()
                .uri("/api/exports/00000000-0000-0000-0000-000000000000/progress")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
