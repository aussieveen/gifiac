//! Lambda entrypoint for the ingest pipeline (wayfinder gifiac#32):
//! probing, thumbnail generation, and filmstrip generation, moved off the
//! synchronous `upload_video` request path. Invoked asynchronously by the
//! backend right after a
//! raw upload lands in the source-video S3 bucket (piece 3), and reports
//! progress/completion by POSTing back to the backend rather than
//! writing to Postgres directly or sharing any disk with it.
//!
//! Local testing: `cargo lambda watch --bin ingest_lambda`, or run the
//! built binary under the Lambda Runtime Interface Emulator — either way,
//! point `callback_url` at a throwaway local HTTP listener to inspect the
//! callback payloads without a real backend running.

use std::path::Path;

use anyhow::{Context, Result};
use gifiac_backend::filmstrip_layout::compute_filmstrip_layout;
use gifiac_backend::{ffmpeg, paths, storage};
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Deserialize)]
struct IngestRequest {
    job_id: String,
    video_id: String,
    /// `paths::video_object_key`'s shape — the source bucket key the raw
    /// upload was already written to before this Lambda was invoked.
    source_key: String,
    extension: String,
    callback_url: String,
    callback_token: String,
}

#[derive(Debug, Serialize)]
struct IngestResponse {
    ok: bool,
}

/// Mirrors the backend's `IngestCallback` body (`routes/internal.rs`,
/// piece 3) exactly — the two sides of this contract are defined once,
/// here and there, and must stay in sync by hand since the Lambda and the
/// backend don't share a crate boundary at runtime.
#[derive(Debug, Serialize)]
struct IngestCallback<'a> {
    job_id: &'a str,
    stage: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    probe: Option<ProbeCallback>,
}

#[derive(Debug, Serialize)]
struct ProbeCallback {
    duration_seconds: f64,
    width: i64,
    height: i64,
}

async fn post_callback(
    http_client: &reqwest::Client,
    callback_url: &str,
    callback_token: &str,
    body: &IngestCallback<'_>,
) {
    // Best-effort, matching this app's existing "broadcast outcome, never
    // propagate a send failure" convention (see `exports::run_export_job`'s
    // doc comment) — if the callback itself fails to deliver, the
    // stuck-job sweep (gifiac#43) is what eventually notices and marks the
    // job `timed_out`, not a retry loop here.
    if let Err(err) = http_client
        .post(callback_url)
        .bearer_auth(callback_token)
        .json(body)
        .send()
        .await
    {
        tracing::error!(error = ?err, stage = %body.stage, "failed to deliver ingest callback");
    }
}

async fn handler(event: LambdaEvent<IngestRequest>) -> Result<IngestResponse, Error> {
    let req = event.payload;
    let http_client = reqwest::Client::new();

    if let Err(err) = run_ingest(&req, &http_client).await {
        tracing::error!(job_id = %req.job_id, error = ?err, "ingest job failed");
        post_callback(
            &http_client,
            &req.callback_url,
            &req.callback_token,
            &IngestCallback {
                job_id: &req.job_id,
                stage: "failed",
                error: Some(err.to_string()),
                probe: None,
            },
        )
        .await;
    }

    Ok(IngestResponse { ok: true })
}

async fn run_ingest(req: &IngestRequest, http_client: &reqwest::Client) -> Result<()> {
    let video_id = Uuid::parse_str(&req.video_id).context("parsing video_id")?;

    let source_videos = storage::SourceStorageConfig::from_env()?;
    let source_storage = storage::Storage::new_for_source_bucket(&source_videos).await;

    let tmp_dir = tempfile::tempdir()?;
    let video_path = tmp_dir.path().join(format!("source.{}", req.extension));
    source_storage
        .download_file(&req.source_key, &video_path)
        .await
        .context("downloading source video")?;

    let probe_path = video_path.clone();
    let probe = tokio::task::spawn_blocking(move || ffmpeg::probe_video(&probe_path)).await??;

    post_callback(
        http_client,
        &req.callback_url,
        &req.callback_token,
        &IngestCallback {
            job_id: &req.job_id,
            stage: "analyzing",
            error: None,
            probe: Some(ProbeCallback {
                duration_seconds: probe.duration_seconds,
                width: probe.width,
                height: probe.height,
            }),
        },
    )
    .await;

    let thumbnail_path = tmp_dir.path().join("thumb.jpg");
    ffmpeg::generate_thumbnail(&video_path, &thumbnail_path, probe.duration_seconds)
        .await
        .context("generating thumbnail")?;
    upload_to_source_bucket(
        &source_storage,
        &paths::video_thumbnail_object_key(&video_id),
        &thumbnail_path,
        "image/jpeg",
    )
    .await?;

    post_callback(
        http_client,
        &req.callback_url,
        &req.callback_token,
        &IngestCallback {
            job_id: &req.job_id,
            stage: "building_filmstrip",
            error: None,
            probe: None,
        },
    )
    .await;

    let layout = compute_filmstrip_layout(probe.duration_seconds, probe.width, probe.height);
    let filmstrip_path = tmp_dir.path().join("filmstrip.jpg");
    ffmpeg::generate_filmstrip_sprite(&video_path, &filmstrip_path, &layout)
        .await
        .context("generating filmstrip sprite")?;
    upload_to_source_bucket(
        &source_storage,
        &paths::video_filmstrip_object_key(&video_id),
        &filmstrip_path,
        "image/jpeg",
    )
    .await?;

    post_callback(
        http_client,
        &req.callback_url,
        &req.callback_token,
        &IngestCallback {
            job_id: &req.job_id,
            stage: "complete",
            error: None,
            probe: None,
        },
    )
    .await;

    Ok(())
}

async fn upload_to_source_bucket(storage: &storage::Storage, key: &str, path: &Path, content_type: &str) -> Result<()> {
    storage
        .upload_file(key, path, content_type)
        .await
        .with_context(|| format!("uploading {key}"))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().without_time().init();
    run(service_fn(handler)).await
}
