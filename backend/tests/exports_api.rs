use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tempfile::TempDir;
use tower::ServiceExt;

mod common;
use common::{authed, login_as, make_test_video, multipart_body, spawn_app};

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
            authed(test_app, Request::builder())
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

/// Doubles as the export pipeline's coverage of SPEC-CLOUD.md §6's local
/// cache: `upload_video` already deletes the source video's local copy
/// right after upload (M4), so this test only passes if `run_pipeline`'s
/// `source_video::ensure_on_disk` successfully re-fetches it from object
/// storage before burning in captions — the real regression case that
/// milestone exists to prevent.
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
            authed(&test_app, Request::builder())
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
            authed(&test_app, Request::builder())
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

    // The `gifs` row `run_pipeline` inserted is owned by whoever created
    // the export (SPEC-CLOUD.md §3) — provable end-to-end via the API
    // surface even though `GifResponse` never exposes `user_id` directly:
    // the exporting user can fetch it, a second user gets a 404.
    let other_cookie = login_as(&test_app, "other@example.com").await;
    let other_users_view = test_app
        .app
        .oneshot(
            Request::builder()
                .uri(format!("/api/gifs/{gif_id}"))
                .header("cookie", &other_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(other_users_view.status(), StatusCode::NOT_FOUND);
}

/// Regression test for a real bug in the interaction between two other
/// fixes: a video not turned into a template is cleaned up automatically
/// right after a gif's made from it (see videos_api.rs's
/// `making_a_gif_from_an_untemplated_video_cleans_it_up_automatically`),
/// but the "Create template" checkbox used to save its template via a
/// *separate* `PUT .../template` call made only after the export
/// completed — racing that cleanup, and losing every time, since cleanup
/// runs synchronously inside the same export request while the follow-up
/// call couldn't even be sent yet. `save_as_template` on the export
/// request itself is the fix: the template is saved *before* cleanup
/// decides whether the video survives, in the same request.
#[tokio::test]
async fn save_as_template_during_export_preserves_the_video_and_creates_a_working_template() {
    let test_app = spawn_app().await;
    let video = upload_video(&test_app, 6.0).await;
    let video_id = video["id"].as_str().unwrap().to_string();

    let request_body = json!({
        "video_id": video_id,
        "name": "with a template",
        "save_as_template": true,
        "captions": [],
        "gif_range_start": 0.0,
        "gif_range_end": 3.0
    });
    let create_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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

    let progress_response = tokio::time::timeout(
        Duration::from_secs(60),
        test_app.app.clone().oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/exports/{export_id}/progress"))
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .expect("SSE stream did not close within the timeout")
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(60),
        axum::body::to_bytes(progress_response.into_body(), usize::MAX),
    )
    .await
    .expect("reading the SSE body did not finish within the timeout")
    .unwrap();

    // The video survived — save_as_template beat the auto-cleanup, not
    // the other way around.
    let video_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/videos/{video_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(video_response.status(), StatusCode::OK);

    // And a real, usable template was actually created — not just a
    // surviving video with nothing attached.
    let template_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/videos/{video_id}/template"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(template_response.status(), StatusCode::OK);
}

/// Regression test for a real bug: `encode_gif`'s ffmpeg invocation has a
/// *second* input (the generated palette image) after the video one, and
/// the shared `-t <duration>` arg was landing between the two `-i`s —
/// which ffmpeg treats as an option for whichever `-i` comes next (the
/// palette, not the video), so the video input silently got no duration
/// limit at all and read to EOF. The GIF came out full source length
/// regardless of the requested range; MP4/WebM (only one input each, so
/// the same positional bug couldn't reach them) came out correctly
/// trimmed — which is exactly why this needs its own duration assertion
/// per format, not just "did all three upload".
#[tokio::test]
async fn export_output_duration_matches_the_requested_range_not_the_source_video() {
    let test_app = spawn_app().await;
    // A source clearly longer than the requested range, so a regression
    // (falling back to full source length) is unmistakable rather than
    // hidden by a source that's already close to the range.
    let video = upload_video(&test_app, 10.0).await;
    let video_id = video["id"].as_str().unwrap();

    let request_body = json!({
        "video_id": video_id,
        "name": "duration check",
        "captions": [],
        "gif_range_start": 1.0,
        "gif_range_end": 3.5
    });
    let create_response = test_app
        .app
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .method("POST")
                .uri("/api/exports")
                .header("content-type", "application/json")
                .body(Body::from(request_body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let accepted: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let export_id = accepted["export_id"].as_str().unwrap().to_string();

    let progress_response = tokio::time::timeout(
        Duration::from_secs(60),
        test_app.app.clone().oneshot(
            authed(&test_app, Request::builder())
                .uri(format!("/api/exports/{export_id}/progress"))
                .body(Body::empty())
                .unwrap(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let body_text = String::from_utf8(
        axum::body::to_bytes(progress_response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let events = parse_sse_events(&body_text);
    let (_, last_data) = events.last().unwrap();
    let gif: serde_json::Value = serde_json::from_str(last_data).unwrap();
    let gif_id = gif["id"].as_str().unwrap();

    let tmp_dir = TempDir::new().unwrap();
    for (key, filename) in [
        (format!("gifs/{gif_id}.gif"), "out.gif"),
        (format!("clips/{gif_id}.mp4"), "out.mp4"),
        (format!("clips/{gif_id}.webm"), "out.webm"),
    ] {
        let bytes = reqwest::get(test_app.storage.public_url(&key))
            .await
            .unwrap()
            .bytes()
            .await
            .unwrap();
        let path = tmp_dir.path().join(filename);
        std::fs::write(&path, &bytes).unwrap();

        let probe = gifiac_backend::ffmpeg::probe_video(&path).unwrap();
        assert!(
            probe.duration_seconds < 5.0,
            "{key} duration was {}s — expected close to the requested 2.5s range, \
             not anywhere near the source's full 10s (the full-length-fallback bug)",
            probe.duration_seconds
        );
    }
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
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
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

/// SPEC-CLOUD.md §3: exporting from a video you don't own 404s exactly
/// like exporting from a nonexistent video — `create_export`'s lookup is
/// scoped to the caller, so another user's video simply isn't there.
#[tokio::test]
async fn export_from_another_users_video_returns_404() {
    let test_app = spawn_app().await;
    let video = upload_video(&test_app, 3.0).await;
    let other_cookie = login_as(&test_app, "other@example.com").await;

    let request_body = json!({
        "video_id": video["id"],
        "name": "not mine to export",
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
                .header("cookie", &other_cookie)
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
        .clone()
        .oneshot(
            authed(&test_app, Request::builder())
                .uri("/api/exports/00000000-0000-0000-0000-000000000000/progress")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
