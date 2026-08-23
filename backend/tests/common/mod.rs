use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use axum::Router;
use gifiac_backend::config::Config;
use gifiac_backend::db;
use gifiac_backend::state::AppState;
use gifiac_backend::storage::Storage;
use tempfile::TempDir;

/// Points at the local MinIO instance this session set up as an
/// S3-compatible stand-in for R2 (real credentials aren't available in
/// this environment, and the whole point of testing against something
/// real is exercising the actual wire protocol rather than mocking the
/// SDK). Bucket `gifiac-test` is public-read, matching R2's bucket policy
/// per SPEC.md §9.
pub fn test_storage() -> Storage {
    Storage::new(
        "http://localhost:19000",
        "gifiac-test",
        "http://localhost:19000/gifiac-test",
        "gifiac",
        "gifiac-test-secret",
    )
}

/// Spins up the real router against a scratch video dir + throwaway sqlite
/// file + the MinIO test bucket, so tests exercise actual FFmpeg
/// probing/encoding and real object-storage uploads, not mocks.
///
/// `common` is compiled separately per integration-test binary, and not
/// every field is read by every binary — allow(dead_code) rather than
/// have each binary warn about the fields only its siblings use.
#[allow(dead_code)]
pub struct TestApp {
    pub app: Router,
    pub video_dir: PathBuf,
    pub storage: Storage,
    _tempdir: TempDir,
}

pub async fn spawn_app() -> TestApp {
    let tempdir = TempDir::new().unwrap();
    let video_dir = tempdir.path().join("videos");
    std::fs::create_dir_all(&video_dir).unwrap();
    let db_path = tempdir.path().join("gifiac.db");

    let config = Config {
        video_dir: video_dir.clone(),
        db_path,
        port: 0,
    };

    let pool = db::create_pool(&config.db_path).await.unwrap();
    db::run_migrations(&pool).await.unwrap();

    let storage = test_storage();
    let state = Arc::new(AppState {
        pool,
        config,
        storage: storage.clone(),
        export_jobs: Default::default(),
    });
    let app = gifiac_backend::build_app(state);

    TestApp {
        app,
        video_dir,
        storage,
        _tempdir: tempdir,
    }
}

/// Generates a synthetic test clip deliberately too large to fit under
/// axum's default 2MB multipart body limit — high-entropy noise (rather
/// than `make_test_video`'s solid color, which compresses to near-nothing
/// regardless of duration) at a high target bitrate, so a test can prove
/// the raised `DefaultBodyLimit` is actually in effect rather than passing
/// vacuously against a tiny fixture.
#[allow(dead_code)]
pub fn make_large_test_video(dir: &std::path::Path) -> PathBuf {
    let path = dir.join("large_source.mp4");
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x480:duration=4:rate=30",
            "-c:v",
            "libx264",
            "-b:v",
            "24M",
            "-maxrate",
            "24M",
            "-bufsize",
            "4M",
            "-pix_fmt",
            "yuv420p",
            path.to_str().unwrap(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("failed to run ffmpeg to build large test fixture");
    assert!(status.success(), "ffmpeg large fixture generation failed");
    path
}

/// Generates a tiny synthetic test clip (solid color, no audio) with the
/// system `ffmpeg` binary so tests don't need to ship a fixture video file.
pub fn make_test_video(dir: &std::path::Path, duration_seconds: f64) -> PathBuf {
    let path = dir.join("source.mp4");
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("color=c=blue:s=320x240:d={duration_seconds}"),
            "-pix_fmt",
            "yuv420p",
            path.to_str().unwrap(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("failed to run ffmpeg to build test fixture");
    assert!(status.success(), "ffmpeg fixture generation failed");
    path
}

/// Parses a raw SSE response body (`event: X\ndata: Y\n\n` blocks) into
/// `(event, data)` pairs, in the order they were sent. Shared by any test
/// that needs to drive an export job to completion, not just the export
/// pipeline's own tests.
pub fn parse_sse_events(body: &str) -> Vec<(String, String)> {
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

/// Uploads a synthetic test video, then runs a real export job to
/// completion (draining its SSE stream) and returns the resulting `gifs`
/// row — a real GIF with real R2 objects, for tests that need a GIF to
/// already exist (archive listing/rename/delete) rather than testing the
/// export pipeline itself.
#[allow(dead_code)]
pub async fn create_gif(test_app: &TestApp, name: &str, caption_text: &str) -> serde_json::Value {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_test_video(fixture_dir.path(), 3.0);
    let video_bytes = std::fs::read(&video_path).unwrap();
    let (boundary, body) = multipart_body("file", "clip.mp4", "video/mp4", video_bytes);
    let upload_response = test_app
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
    assert_eq!(upload_response.status(), StatusCode::CREATED);
    let video: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(upload_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();

    let captions = if caption_text.is_empty() {
        serde_json::json!([])
    } else {
        serde_json::json!([{
            "id": "c1",
            "startTime": 0.0,
            "endTime": 1.0,
            "text": caption_text,
            "fontFamily": "Impact, sans-serif",
            "fontSize": 28,
            "color": "#ffffff",
            "align": "center",
            "x": 0.5,
            "y": 0.88
        }])
    };
    let request_body = serde_json::json!({
        "video_id": video["id"],
        "name": name,
        "captions": captions,
        "gif_range_start": 0.0,
        "gif_range_end": 1.0
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

    let progress_response = tokio::time::timeout(
        std::time::Duration::from_secs(60),
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
    let body_bytes = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        axum::body::to_bytes(progress_response.into_body(), usize::MAX),
    )
    .await
    .expect("reading the SSE body did not finish within the timeout")
    .unwrap();
    let body_text = String::from_utf8(body_bytes.to_vec()).unwrap();
    let events = parse_sse_events(&body_text);
    let (last_event, last_data) = events.last().expect("expected at least one SSE event");
    assert_eq!(last_event, "complete", "export did not complete: {events:?}");
    serde_json::from_str(last_data).unwrap()
}

pub fn multipart_body(
    field_name: &str,
    filename: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> (String, Vec<u8>) {
    let boundary = "----gifiac-test-boundary".to_string();
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"{field_name}\"; filename=\"{filename}\"\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (boundary, body)
}
