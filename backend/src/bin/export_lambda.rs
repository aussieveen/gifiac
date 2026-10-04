//! Lambda entrypoint for one export-format encode (wayfinder gifiac#32):
//! the backend invokes this once per format (gif/mp4/webm) per export job,
//! each a separate async invocation reading the source clip from S3
//! independently. Reports progress/completion by POSTing back to the
//! backend, same contract shape as `ingest_lambda`.
//!
//! The `gif` format runs both palette-generation passes internally,
//! back-to-back (per the map's palette-generation decision, gifiac#37) —
//! no separate fan-out step shared with mp4/webm.

use anyhow::{Context, Result, anyhow};
use gifiac_backend::ffmpeg::export::{ClipSource, encode_gif, encode_mp4, encode_webm, generate_palette};
use gifiac_backend::storage;
use lambda_runtime::{Error, LambdaEvent, run, service_fn};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct ExportRequest {
    job_id: String,
    format: String, // "gif" | "mp4" | "webm"
    source_key: String,
    /// Caption .ass content, inlined — the Lambda has no disk shared
    /// with the backend to read a file path from.
    ass_content: String,
    range_start: f64,
    clip_duration: f64,
    /// R2 destination key (`paths::{gif,mp4,webm}_object_key`).
    output_key: String,
    callback_url: String,
    callback_token: String,
}

#[derive(Debug, Serialize)]
struct ExportResponse {
    ok: bool,
}

/// Mirrors the backend's `ExportCallback` body (`routes/internal.rs`,
/// piece 3) exactly — see `ingest_lambda`'s matching comment.
#[derive(Debug, Serialize)]
struct ExportCallback<'a> {
    job_id: &'a str,
    format: &'a str,
    status: &'a str, // "running" | "done" | "failed"
    percent: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// The gif format's actual post-scale output dimensions, probed from
    /// the encoded file rather than reimplementing the scale filter's
    /// rounding rules a second time (same approach the pre-Lambda
    /// pipeline used) — present only on `gif`'s own "done" callback; the
    /// backend persists these on `export_jobs` since the "all formats
    /// terminal" callback that needs them to build the `gifs` row may be
    /// a later, different callback (mp4/webm finish independently).
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<i64>,
}

async fn post_callback(http_client: &reqwest::Client, callback_url: &str, callback_token: &str, body: &ExportCallback<'_>) {
    // Best-effort — see `ingest_lambda::post_callback`'s doc comment.
    if let Err(err) = http_client
        .post(callback_url)
        .bearer_auth(callback_token)
        .json(body)
        .send()
        .await
    {
        tracing::error!(error = ?err, status = %body.status, "failed to deliver export callback");
    }
}

async fn handler(event: LambdaEvent<ExportRequest>) -> Result<ExportResponse, Error> {
    let req = event.payload;
    let http_client = reqwest::Client::new();

    if let Err(err) = run_export(&req, &http_client).await {
        tracing::error!(job_id = %req.job_id, format = %req.format, error = ?err, "export job failed");
        post_callback(
            &http_client,
            &req.callback_url,
            &req.callback_token,
            &ExportCallback {
                job_id: &req.job_id,
                format: &req.format,
                status: "failed",
                percent: 0,
                error: Some(err.to_string()),
                width: None,
                height: None,
            },
        )
        .await;
    }

    Ok(ExportResponse { ok: true })
}

async fn run_export(req: &ExportRequest, http_client: &reqwest::Client) -> Result<()> {
    let source_videos = storage::SourceStorageConfig::from_env()?;
    let source_storage = storage::Storage::new_for_source_bucket(&source_videos).await;
    // R2 is not an AWS-native resource — no instance/execution-role IMDS
    // chain reaches it, so credentials come from Lambda env vars
    // (terraform piece 5), same explicit-credentials path the EC2 app
    // already uses for R2 (`Storage::new`).
    let r2 = storage::R2Config::from_env()?;
    let output_storage = storage::Storage::new(
        &r2.endpoint_url(),
        &r2.bucket_name,
        Some(&r2.public_base_url),
        &r2.access_key_id,
        &r2.secret_access_key,
    );

    let tmp_dir = tempfile::tempdir()?;
    let extension = req.source_key.rsplit('.').next().unwrap_or("mp4");
    let video_path = tmp_dir.path().join(format!("source.{extension}"));
    source_storage
        .download_file(&req.source_key, &video_path)
        .await
        .context("downloading source clip")?;

    let ass_path = tmp_dir.path().join("captions.ass");
    tokio::fs::write(&ass_path, &req.ass_content).await?;

    let clip = ClipSource {
        video_path: &video_path,
        ass_path: &ass_path,
        range_start: req.range_start,
        clip_duration: req.clip_duration,
    };

    let report_progress = |percent: u8| {
        let http_client = http_client.clone();
        let callback_url = req.callback_url.clone();
        let callback_token = req.callback_token.clone();
        let job_id = req.job_id.clone();
        let format = req.format.clone();
        // `generate_palette`/`encode_*`'s on_progress callback is sync
        // (`FnMut(u8)`, fed straight from parsing FFmpeg's `-progress`
        // output) — fire-and-forget the HTTP POST on its own task rather
        // than blocking the ffmpeg-output reader loop on it, same
        // best-effort semantics as the in-process broadcast send this
        // replaces (`exports::run_export_job`'s `let _ = events.send(...)`).
        tokio::spawn(async move {
            post_callback(
                &http_client,
                &callback_url,
                &callback_token,
                &ExportCallback {
                    job_id: &job_id,
                    format: &format,
                    status: "running",
                    percent,
                    error: None,
                    width: None,
                    height: None,
                },
            )
            .await;
        });
    };

    let output_path = tmp_dir.path().join(format!("out.{}", output_extension(&req.format)?));
    let content_type = output_content_type(&req.format)?;

    match req.format.as_str() {
        "gif" => {
            let palette_path = tmp_dir.path().join("palette.png");
            generate_palette(clip, &palette_path, report_progress).await?;
            encode_gif(clip, &palette_path, &output_path, report_progress).await?;
        }
        "mp4" => {
            encode_mp4(clip, &output_path, report_progress).await?;
        }
        "webm" => {
            encode_webm(clip, &output_path, report_progress).await?;
        }
        other => return Err(anyhow!("unknown export format: {other}")),
    }

    output_storage
        .upload_file(&req.output_key, &output_path, content_type)
        .await
        .with_context(|| format!("uploading {}", req.output_key))?;

    // Only the gif format's dimensions are needed by the backend (the
    // `gifs` row stores just one width/height, same as today) — probing
    // mp4/webm's output would be redundant, they share the same scale
    // filter and thus the same output dimensions.
    let (width, height) = if req.format == "gif" {
        let probe_path = output_path.clone();
        let probe = tokio::task::spawn_blocking(move || gifiac_backend::ffmpeg::probe_video(&probe_path)).await??;
        (Some(probe.width), Some(probe.height))
    } else {
        (None, None)
    };

    post_callback(
        http_client,
        &req.callback_url,
        &req.callback_token,
        &ExportCallback {
            job_id: &req.job_id,
            format: &req.format,
            status: "done",
            percent: 100,
            error: None,
            width,
            height,
        },
    )
    .await;

    Ok(())
}

fn output_extension(format: &str) -> Result<&'static str> {
    match format {
        "gif" => Ok("gif"),
        "mp4" => Ok("mp4"),
        "webm" => Ok("webm"),
        other => Err(anyhow!("unknown export format: {other}")),
    }
}

fn output_content_type(format: &str) -> Result<&'static str> {
    match format {
        "gif" => Ok("image/gif"),
        "mp4" => Ok("video/mp4"),
        "webm" => Ok("video/webm"),
        other => Err(anyhow!("unknown export format: {other}")),
    }
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().without_time().init();
    run(service_fn(handler)).await
}
