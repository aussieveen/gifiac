use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use axum::Router;
use gifiac_backend::auth::{GoogleAuthConfig, SESSION_COOKIE_NAME};
use gifiac_backend::config::Config;
use gifiac_backend::db;
use gifiac_backend::email_auth::{EmailAuthConfig, MailerKind};
use gifiac_backend::lambda_jobs::LambdaConfig;
use gifiac_backend::mailer::Mailer;
use gifiac_backend::state::AppState;
use gifiac_backend::storage::{SourceStorageConfig, Storage, TemplateAssetsConfig};
use sqlx::PgPool;
use tempfile::TempDir;

/// The ingest/export Lambda functions never actually run in tests — a
/// real invocation would need real AWS infra. `AppState::export_jobs`'s
/// fire-and-forget `invoke_ingest`/`invoke_export` calls are allowed to
/// fail (logged, not propagated — see their call sites), so pointing the
/// client at a closed local port (nothing listens on `:1`) just makes
/// that failure fast instead of a real network timeout. Tests drive jobs
/// to completion themselves by POSTing directly to the internal callback
/// endpoints — see `simulate_ingest_callback`/`simulate_export_callback`
/// — exactly mirroring what the real Lambda functions would POST.
pub const TEST_CALLBACK_TOKEN: &str = "test-callback-token";

fn test_lambda_config() -> LambdaConfig {
    LambdaConfig {
        ingest_function_name: "test-ingest".to_string(),
        export_function_name: "test-export".to_string(),
        callback_base_url: "http://127.0.0.1:1".to_string(),
        callback_token: TEST_CALLBACK_TOKEN.to_string(),
    }
}

fn test_lambda_client() -> aws_sdk_lambda::Client {
    let config = aws_sdk_lambda::Config::builder()
        .behavior_version(aws_sdk_lambda::config::BehaviorVersion::latest())
        .credentials_provider(aws_sdk_lambda::config::Credentials::new("test", "test", None, None, "test"))
        .region(aws_sdk_lambda::config::Region::new("us-east-1"))
        .endpoint_url("http://127.0.0.1:1")
        .build();
    aws_sdk_lambda::Client::from_conf(config)
}

/// Never actually used to call Google — real OAuth can't run in tests, so
/// `login_as` bypasses the flow entirely by writing `users`/`sessions`
/// rows directly. Only exists so `AppState` has something to construct.
fn test_google_auth() -> GoogleAuthConfig {
    GoogleAuthConfig {
        client_id: "test-client-id".to_string(),
        client_secret: "test-client-secret".to_string(),
        app_base_url: "http://localhost:5173".to_string(),
    }
}

/// 32 bytes of fixed (not random — tests don't need real secrecy) key
/// material, base64-free since `EmailAuthConfig` here is built directly
/// rather than via `from_env`/its base64 decoding. No Turnstile secret —
/// tests exercise the "unset" skip path, same as local dev.
fn test_email_auth() -> EmailAuthConfig {
    EmailAuthConfig {
        login_code_hmac_key: b"01234567890123456789012345678901".to_vec(),
        mailer_kind: MailerKind::Log,
        email_from_address: None,
        ses_region: None,
        turnstile_secret_key: None,
        turnstile_site_key: None,
        trust_cf_connecting_ip: false,
    }
}

/// Points at the local MinIO instance from `docker-compose.dev.yml` as an
/// S3-compatible stand-in for R2 (real credentials aren't needed for
/// local dev/tests, and the whole point of testing against something real
/// is exercising the actual wire protocol rather than mocking the SDK).
/// Bucket `gifiac-test` is public-read, matching R2's bucket policy per
/// SPEC.md §9.
pub fn test_storage() -> Storage {
    Storage::new(
        "http://localhost:19000",
        "gifiac-test",
        Some("http://localhost:19000/gifiac-test"),
        "gifiac",
        "gifiac-test-secret",
    )
}

/// Same MinIO instance, standing in for the private source-video S3
/// bucket (SPEC-CLOUD.md §6) — a separate, non-public bucket so tests
/// exercise the real "no public URL" shape too (`public_base_url: None`).
/// Goes through `new_for_source_bucket` (not `Storage::new`) with explicit
/// credentials set — the same "creds present" branch local dev/test always
/// takes; production (no creds set) falls back to the EC2 instance role
/// instead (SPEC-CLOUD.md §10), a path this test fixture can't exercise
/// without a real instance.
#[allow(dead_code)]
pub async fn test_source_storage() -> Storage {
    Storage::new_for_source_bucket(&SourceStorageConfig {
        access_key_id: Some("gifiac".to_string()),
        secret_access_key: Some("gifiac-test-secret".to_string()),
        bucket_name: "gifiac-source-videos-test".to_string(),
        region: "us-east-1".to_string(),
        endpoint_url_override: Some("http://localhost:19000".to_string()),
    })
    .await
}

/// Same MinIO instance again, standing in for the private template-assets
/// S3 bucket (SPEC-CLOUD.md §10) — see `test_source_storage`'s own doc
/// comment, same reasoning, just a separate bucket.
#[allow(dead_code)]
pub async fn test_template_assets_storage() -> Storage {
    Storage::new_for_template_assets_bucket(&TemplateAssetsConfig {
        access_key_id: Some("gifiac".to_string()),
        secret_access_key: Some("gifiac-test-secret".to_string()),
        bucket_name: "gifiac-template-assets-test".to_string(),
        region: "us-east-1".to_string(),
        endpoint_url_override: Some("http://localhost:19000".to_string()),
    })
    .await
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
    /// The same `Arc<AppState>` the router was built from (cloning the
    /// `Arc`, not the state itself — `AppState` isn't `Clone`). No real
    /// ingest/export Lambda runs in tests; this is what lets a test call
    /// `exports::transcode_and_upload` directly to produce real encoded
    /// output at the real R2 keys, standing in for what the real export
    /// Lambda would have done, before simulating its "done" callback.
    pub state: std::sync::Arc<AppState>,
    pub video_dir: PathBuf,
    pub storage: Storage,
    pub source_storage: Storage,
    pub template_assets_storage: Storage,
    /// Kept alongside the copy moved into `AppState` so `login_as` can
    /// write `users`/`sessions` rows directly — `PgPool` is a cheap
    /// `Arc`-backed handle, so cloning it doesn't open a second pool.
    pub pool: PgPool,
    /// A ready-to-attach `Cookie` header value (`.header("cookie",
    /// &test_app.owner_cookie)`) for a default signed-in user, logged in
    /// once per `spawn_app()` call — SPEC-CLOUD.md §3 gates every
    /// video/gif/export route behind login now, so almost every test
    /// needs to authenticate as *someone* to reach the handler under
    /// test. Tests specifically about cross-user isolation call
    /// `login_as` again for a second, distinct user.
    pub owner_cookie: String,
    /// Every `(to, code)` pair sent through the test `Mailer::capture()`
    /// backend — lets a test assert on the exact code it needs to submit
    /// to `/api/auth/email/verify`, without a real inbox.
    pub sent_codes: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    _tempdir: TempDir,
}

pub async fn spawn_app() -> TestApp {
    let tempdir = TempDir::new().unwrap();
    let video_dir = tempdir.path().join("videos");
    std::fs::create_dir_all(&video_dir).unwrap();

    // A fresh, isolated Postgres database per test (see
    // `db::create_ephemeral_test_pool`) — video files still get a scratch
    // tempdir since those aren't part of what moved to Postgres.
    let pool = db::create_ephemeral_test_pool().await;
    let owner_cookie = create_session_cookie(&pool, "owner@example.com").await;

    let config = Config {
        video_dir: video_dir.clone(),
        database_url: String::new(),
        port: 0,
    };

    let storage = test_storage();
    let source_storage = test_source_storage().await;
    let template_assets_storage = test_template_assets_storage().await;
    let http_client = gifiac_backend::link_check::build_client().unwrap();
    let (mailer, sent_codes) = Mailer::capture();
    let state = Arc::new(AppState {
        pool: pool.clone(),
        config,
        storage: storage.clone(),
        source_storage: source_storage.clone(),
        template_assets_storage: template_assets_storage.clone(),
        http_client,
        google_auth: test_google_auth(),
        email_auth: test_email_auth(),
        mailer,
        export_jobs: Default::default(),
        ingest_jobs: Default::default(),
        lambda_client: test_lambda_client(),
        lambda_config: test_lambda_config(),
    });
    let app = gifiac_backend::build_app(state.clone());

    TestApp {
        state,
        app,
        video_dir,
        storage,
        source_storage,
        template_assets_storage,
        pool,
        owner_cookie,
        sent_codes,
        _tempdir: tempdir,
    }
}

/// Bypasses the real Google OAuth flow (which can't run in tests) by
/// writing `users`/`identities`/`sessions` rows directly — the same "skip
/// only what's truly external" spirit as `test_storage()` standing in for
/// R2. Returns a `Cookie` header value ready to attach to a request via
/// `.header("cookie", login_as(&test_app, "a@example.com").await)`.
#[allow(dead_code)]
pub async fn login_as(test_app: &TestApp, email: &str) -> String {
    create_session_cookie(&test_app.pool, email).await
}

/// Like `login_as`, but promotes the created user to `role = 'admin'`
/// first (SPEC-CLOUD.md §7) via a direct SQL update — there's no API to
/// become an admin (see the M6 plan's "admin bootstrapping" note), so this
/// is the same test-only bypass spirit `login_as` already applies to real
/// OAuth.
#[allow(dead_code)]
pub async fn login_as_admin(test_app: &TestApp, email: &str) -> String {
    let cookie = create_session_cookie(&test_app.pool, email).await;
    let session_id = cookie.strip_prefix(&format!("{SESSION_COOKIE_NAME}=")).unwrap();
    let user_id: String = sqlx::query_scalar("SELECT user_id FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_one(&test_app.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET role = 'admin' WHERE id = $1")
        .bind(&user_id)
        .execute(&test_app.pool)
        .await
        .unwrap();
    cookie
}

/// Attaches `test_app`'s default owner's session cookie to a request
/// builder — SPEC-CLOUD.md §3 gates every video/gif/export route behind
/// login now, so this is what almost every request in these suites needs.
/// A test specifically about being logged out, or about a second user,
/// builds its request directly instead (with no cookie, or a different
/// one from a second `login_as` call).
#[allow(dead_code)]
pub fn authed(test_app: &TestApp, builder: axum::http::request::Builder) -> axum::http::request::Builder {
    builder.header("cookie", &test_app.owner_cookie)
}

/// Shared by `login_as` and `spawn_app` (which needs a ready-to-use
/// `owner_cookie` before a `TestApp` exists to call `login_as` on).
async fn create_session_cookie(pool: &PgPool, email: &str) -> String {
    let now = chrono::Utc::now().to_rfc3339();
    let user_id = uuid::Uuid::new_v4().to_string();
    let provider_user_id = uuid::Uuid::new_v4().to_string();
    db::create_user_with_identity(pool, &user_id, &now, "google", &provider_user_id, Some(email), None, None)
        .await
        .unwrap();

    let session_id = uuid::Uuid::new_v4().to_string();
    db::create_session(pool, &session_id, &user_id, &now).await.unwrap();

    format!("{SESSION_COOKIE_NAME}={session_id}")
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

/// POSTs directly to `/api/internal/callbacks/ingest` with the shared
/// test bearer token — simulates what the real ingest Lambda
/// (`bin/ingest_lambda.rs`) would POST, since no real Lambda runs in
/// tests (see `TEST_CALLBACK_TOKEN`'s doc comment).
#[allow(dead_code)]
pub async fn simulate_ingest_callback(test_app: &TestApp, job_id: &str, body: serde_json::Value) {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    let mut body = body;
    body["job_id"] = serde_json::Value::String(job_id.to_string());
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/internal/callbacks/ingest")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {TEST_CALLBACK_TOKEN}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

/// Drives an ingest job all the way to `complete` with one `analyzing`
/// callback (carrying the probe the frontend/`gifs` row needs) followed
/// by a `complete` callback — the two stages every test that just needs a
/// finished video actually cares about; `building_filmstrip` is skipped
/// since nothing here asserts on it.
#[allow(dead_code)]
pub async fn complete_ingest_job(test_app: &TestApp, job_id: &str, duration_seconds: f64, width: i64, height: i64) {
    simulate_ingest_callback(
        test_app,
        job_id,
        serde_json::json!({
            "stage": "analyzing",
            "probe": { "duration_seconds": duration_seconds, "width": width, "height": height }
        }),
    )
    .await;
    simulate_ingest_callback(test_app, job_id, serde_json::json!({ "stage": "complete" })).await;
}

/// POSTs directly to `/api/internal/callbacks/export` — see
/// `simulate_ingest_callback`'s matching doc comment.
#[allow(dead_code)]
pub async fn simulate_export_callback(test_app: &TestApp, job_id: &str, body: serde_json::Value) {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    let mut body = body;
    body["job_id"] = serde_json::Value::String(job_id.to_string());
    let response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/internal/callbacks/export")
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {TEST_CALLBACK_TOKEN}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
}

/// Like `complete_export_job`, but actually runs the real ffmpeg
/// pipeline first (`exports::transcode_and_upload`, the same function
/// bulk import still uses in-process) to produce real gif/mp4/webm files
/// at the real R2 keys the export Lambda would have written to — for
/// tests that need to inspect the actual encoded output, not just the
/// job-row bookkeeping. `video_path` must still exist locally (the
/// caller's own fixture file, not the backend's post-upload copy, which
/// gets deleted).
#[allow(dead_code)]
pub async fn complete_export_job_with_real_files(
    test_app: &TestApp,
    export_id: &str,
    video_path: &std::path::Path,
    ass_content: &str,
    range_start: f64,
    clip_duration: f64,
) -> (i64, i64) {
    use gifiac_backend::exports::{ExportEvent, transcode_and_upload};

    let export_uuid = uuid::Uuid::parse_str(export_id).unwrap();
    let result = transcode_and_upload(
        &test_app.state,
        export_uuid,
        video_path,
        ass_content,
        range_start,
        clip_duration,
        &|_: ExportEvent| {},
    )
    .await
    .expect("transcode_and_upload failed");

    complete_export_job(test_app, export_id, result.width, result.height).await;
    (result.width, result.height)
}

/// Drives an export job to completion with one "done" callback per format
/// — gif carries the output dimensions real `export_lambda` would have
/// probed, mp4/webm just report done (their dimensions aren't used).
#[allow(dead_code)]
pub async fn complete_export_job(test_app: &TestApp, job_id: &str, gif_width: i64, gif_height: i64) {
    simulate_export_callback(
        test_app,
        job_id,
        serde_json::json!({ "format": "gif", "status": "done", "percent": 100, "width": gif_width, "height": gif_height }),
    )
    .await;
    simulate_export_callback(test_app, job_id, serde_json::json!({ "format": "mp4", "status": "done", "percent": 100 })).await;
    simulate_export_callback(test_app, job_id, serde_json::json!({ "format": "webm", "status": "done", "percent": 100 })).await;
}

/// Uploads a synthetic test video, drives its ingest job to completion
/// (simulating the ingest Lambda's callbacks — see
/// `complete_ingest_job`), and returns the finished `videos` row. The
/// shared first step of `create_gif` and any test that needs a fully-
/// ingested video to `PUT` a template against or export from.
#[allow(dead_code)]
pub async fn upload_test_video(test_app: &TestApp) -> serde_json::Value {
    upload_test_video_with_path(test_app).await.0
}

/// Same as `upload_test_video`, but also returns the local fixture path
/// (kept alive — the backend's own copy is deleted right after upload,
/// per SPEC-CLOUD.md §6) for callers that go on to run a real export via
/// `complete_export_job_with_real_files`.
async fn upload_test_video_with_path(test_app: &TestApp) -> (serde_json::Value, PathBuf) {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    let fixture_dir = TempDir::new().unwrap();
    let video_path = make_test_video(fixture_dir.path(), 3.0);
    // Leaked deliberately so the file outlives this function — see
    // `exports_api.rs`'s `upload_video` helper for the same pattern.
    std::mem::forget(fixture_dir);
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
                .header("cookie", &test_app.owner_cookie)
                .body(Body::from(body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(upload_response.status(), StatusCode::ACCEPTED);
    let accepted: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(upload_response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    let video_id = accepted["video_id"].as_str().unwrap();
    let job_id = accepted["job_id"].as_str().unwrap();

    // No real ingest Lambda runs in tests — generate the thumbnail/
    // filmstrip the same way `bin/ingest_lambda.rs` does (real ffmpeg,
    // same functions) and upload them to the same source-bucket keys, so
    // `GET .../thumbnail` and `.../filmstrip.jpg` have something real to
    // serve once the job completes below.
    let video_uuid = uuid::Uuid::parse_str(video_id).unwrap();
    let probe = gifiac_backend::ffmpeg::probe_video(&video_path).unwrap();
    let assets_dir = TempDir::new().unwrap();
    let thumb_path = assets_dir.path().join("thumb.jpg");
    gifiac_backend::ffmpeg::generate_thumbnail(&video_path, &thumb_path, probe.duration_seconds)
        .await
        .unwrap();
    test_app
        .source_storage
        .upload_file(&gifiac_backend::paths::video_thumbnail_object_key(&video_uuid), &thumb_path, "image/jpeg")
        .await
        .unwrap();
    let layout = gifiac_backend::filmstrip_layout::compute_filmstrip_layout(probe.duration_seconds, probe.width, probe.height);
    let filmstrip_path = assets_dir.path().join("filmstrip.jpg");
    gifiac_backend::ffmpeg::generate_filmstrip_sprite(&video_path, &filmstrip_path, &layout)
        .await
        .unwrap();
    test_app
        .source_storage
        .upload_file(&gifiac_backend::paths::video_filmstrip_object_key(&video_uuid), &filmstrip_path, "image/jpeg")
        .await
        .unwrap();

    complete_ingest_job(test_app, job_id, probe.duration_seconds, probe.width, probe.height).await;

    let get_response = test_app
        .app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/videos/{video_id}"))
                .header("cookie", &test_app.owner_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);
    let video: serde_json::Value =
        serde_json::from_slice(&axum::body::to_bytes(get_response.into_body(), usize::MAX).await.unwrap()).unwrap();
    (video, video_path)
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

    let (video, video_path) = upload_test_video_with_path(test_app).await;

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
        "captions": captions.clone(),
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
                .header("cookie", &test_app.owner_cookie)
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

    // No real export Lambda runs in tests — run the real ffmpeg pipeline
    // directly (`complete_export_job_with_real_files`) so callers of this
    // helper get real gif/mp4/webm objects in R2, not just a DB row —
    // several (e.g. gifs_api.rs's delete test) check real object
    // existence. Must happen before reading progress, so
    // `export_progress` takes its terminal-replay path (gifiac#32) and
    // returns the `complete` event immediately.
    let captions_vec: Vec<gifiac_backend::models::Caption> = serde_json::from_value(captions).unwrap();
    let (output_width, output_height) =
        gifiac_backend::scale::scaled_dimensions(video["width"].as_i64().unwrap(), video["height"].as_i64().unwrap());
    let ass_content = gifiac_backend::ass::generate_ass(&captions_vec, 0.0, 1.0, output_width, output_height);
    complete_export_job_with_real_files(test_app, &export_id, &video_path, &ass_content, 0.0, 1.0).await;

    let progress_response = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        test_app.app.clone().oneshot(
            Request::builder()
                .uri(format!("/api/exports/{export_id}/progress"))
                .header("cookie", &test_app.owner_cookie)
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
    let mut gif: serde_json::Value = serde_json::from_str(last_data).unwrap();
    // The export's own automatic cleanup of an untemplated source video
    // (wayfinder gifiac#32's `finalize_video_export`) may have already
    // nulled `gifs.video_id` by the time this reads back from the DB
    // (`export_progress`'s terminal-replay path, taken since the export
    // was already completed above before this stream was even opened) —
    // restore the value as of creation, which every caller of this
    // helper actually wants (e.g. to then assert the video *is* gone).
    if gif["video_id"].is_null() {
        gif["video_id"] = video["id"].clone();
    }
    gif
}

/// Generates a tiny synthetic GIF fixture with the system `ffmpeg` binary —
/// for bulk-import tests, which need a real *GIF* (not an mp4) as their
/// source, per SPEC.md §7 ("imported files are typically GIF-only").
#[allow(dead_code)]
pub fn make_test_gif(dir: &std::path::Path, duration_seconds: f64) -> PathBuf {
    let path = dir.join("source.gif");
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            &format!("color=c=green:s=64x48:d={duration_seconds}"),
            path.to_str().unwrap(),
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .expect("failed to run ffmpeg to build gif test fixture");
    assert!(status.success(), "ffmpeg gif fixture generation failed");
    path
}

pub fn multipart_body(
    field_name: &str,
    filename: &str,
    content_type: &str,
    bytes: Vec<u8>,
) -> (String, Vec<u8>) {
    multipart_body_multi(&[(field_name, filename, content_type, bytes)])
}

/// Same wire format as `multipart_body`, but with one part per `(field_name,
/// filename, content_type, bytes)` entry — for endpoints that accept
/// multiple files in a single request (bulk import, SPEC.md §7).
#[allow(dead_code)]
pub fn multipart_body_multi(files: &[(&str, &str, &str, Vec<u8>)]) -> (String, Vec<u8>) {
    let boundary = "----gifiac-test-boundary".to_string();
    let mut body = Vec::new();
    for (field_name, filename, content_type, bytes) in files {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"{field_name}\"; filename=\"{filename}\"\r\n"
            )
            .as_bytes(),
        );
        body.extend_from_slice(format!("Content-Type: {content_type}\r\n\r\n").as_bytes());
        body.extend_from_slice(bytes);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (boundary, body)
}
