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
