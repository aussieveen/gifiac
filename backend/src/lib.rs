pub mod ass;
pub mod auth;
pub mod config;
pub mod db;
pub mod email_auth;
pub mod error;
pub mod exports;
pub mod ffmpeg;
pub mod filmstrip_layout;
pub mod handle;
pub mod ingest;
pub mod lambda_jobs;
pub mod link_check;
pub mod mailer;
pub mod models;
pub mod paths;
pub mod routes;
pub mod scale;
pub mod source_video;
pub mod state;
pub mod storage;
pub mod template_assets;
pub mod thumbnails;

use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

use config::Config;
use models::ExportFormat;
use state::AppState;

/// Where the built frontend (`frontend/dist`, per SPEC.md §1: "built to
/// static files ... served by the same Axum binary") lives at runtime —
/// relative to the process's working directory, which the Dockerfile fixes
/// by `WORKDIR`ing to the same place it copies the built assets into. In
/// local dev this directory just doesn't exist (the frontend is served by
/// Vite on :5173 instead, proxying `/api` back to this server — see
/// frontend/vite.config.ts) — `ServeDir` 404s per-request rather than
/// failing at startup, so that's harmless.
const STATIC_DIR: &str = "static";

/// Axum's `Multipart` extractor otherwise caps request bodies at 2MB, far
/// too small for a video upload — 200MB comfortably covers "at least
/// 100MB, even though that's unlikely" per the user's ask.
const MAX_UPLOAD_BYTES: usize = 200 * 1024 * 1024;

pub async fn build_state() -> anyhow::Result<Arc<AppState>> {
    let config = Config::from_env();
    std::fs::create_dir_all(&config.video_dir)?;

    let pool = db::create_pool(&config.database_url).await?;
    db::run_migrations(&pool).await?;

    let r2 = storage::R2Config::from_env()?;
    let storage = storage::Storage::new(
        &r2.endpoint_url(),
        &r2.bucket_name,
        Some(&r2.public_base_url),
        &r2.access_key_id,
        &r2.secret_access_key,
    );

    let source_videos = storage::SourceStorageConfig::from_env()?;
    let source_storage = storage::Storage::new_for_source_bucket(&source_videos).await;

    let template_assets = storage::TemplateAssetsConfig::from_env()?;
    let template_assets_storage = storage::Storage::new_for_template_assets_bucket(&template_assets).await;

    let http_client = link_check::build_client()?;
    let google_auth = auth::GoogleAuthConfig::from_env()?;
    let email_auth = email_auth::EmailAuthConfig::from_env()?;
    let mailer = match email_auth.mailer_kind {
        email_auth::MailerKind::Ses => {
            mailer::Mailer::ses(
                email_auth.email_from_address.clone().expect("checked in EmailAuthConfig::from_env"),
                email_auth.ses_region.clone().expect("checked in EmailAuthConfig::from_env"),
            )
            .await
        }
        email_auth::MailerKind::Log => mailer::Mailer::log(),
    };
    tracing::info!(mailer = ?email_auth.mailer_kind, "email mailer selected");
    if email_auth.turnstile_secret_key.is_none() {
        tracing::warn!("TURNSTILE_SECRET_KEY not set — Turnstile verification is disabled");
    }

    // Lambda has no bearing on IMDS-vs-explicit-credentials the way R2 vs
    // the source bucket does — the Lambda functions are AWS-native, so
    // the SDK's default chain (the EC2 instance role via IMDS) is always
    // the right one, same reasoning as `Storage::new_for_source_bucket`.
    let lambda_sdk_config = aws_config::defaults(aws_config::BehaviorVersion::latest()).load().await;
    let lambda_client = aws_sdk_lambda::Client::new(&lambda_sdk_config);
    let lambda_config = lambda_jobs::LambdaConfig::from_env()?;

    spawn_login_code_cleanup(pool.clone());

    let state = Arc::new(AppState {
        pool,
        config,
        storage,
        source_storage,
        template_assets_storage,
        http_client,
        google_auth,
        email_auth,
        mailer,
        export_jobs: Default::default(),
        ingest_jobs: Default::default(),
        lambda_client,
        lambda_config,
    });
    spawn_job_sweep(state.clone());

    Ok(state)
}

/// SPEC-EMAIL-AUTH.md §8: hourly in-process cleanup of expired
/// `login_codes` rows — no new infra (systemd timer, separate binary) for
/// what's just tidying rows that are otherwise harmless to leave around a
/// while longer. Rows must survive at least an hour, per the rolling
/// per-hour rate-limit windows in `email_auth`, so this only ever deletes
/// rows created more than a day ago.
fn spawn_login_code_cleanup(pool: sqlx::PgPool) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
        loop {
            interval.tick().await;
            let older_than = (chrono::Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
            match db::delete_expired_login_codes(&pool, &older_than).await {
                Ok(deleted) if deleted > 0 => tracing::info!(deleted, "cleaned up expired login codes"),
                Ok(_) => {}
                Err(err) => tracing::error!(error = ?err, "failed to clean up expired login codes"),
            }
        }
    });
}

/// Stuck-job detection (wayfinder gifiac#43): a non-terminal ingest or
/// export job whose Lambda invocation never calls back at all — as
/// opposed to one that calls back with an error — would otherwise leave
/// its DB row (and the browser's SSE connection) waiting forever. Mirrors
/// `spawn_login_code_cleanup`'s in-process interval-loop pattern, one
/// combined task scanning both tables each tick rather than two separate
/// loops. The grace windows are each job type's Lambda timeout (ingest
/// 90s, export 5min, per gifiac#34) plus a fixed buffer.
///
/// Also pushes a `Failed`-shaped event to any live SSE subscriber and
/// removes the in-memory broadcast-channel entry for each job it marks
/// `timed_out` — the SSE-push half of the design that piece 1 (DB
/// migration/queries only, no `AppState` yet) couldn't implement.
fn spawn_job_sweep(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(20));
        loop {
            interval.tick().await;
            let now = chrono::Utc::now();
            let ingest_cutoff = (now - chrono::Duration::seconds(120)).to_rfc3339();
            let export_cutoff = (now - chrono::Duration::seconds(360)).to_rfc3339();

            match db::find_stale_ingest_jobs(&state.pool, &ingest_cutoff).await {
                Ok(jobs) if !jobs.is_empty() => {
                    for job in &jobs {
                        let now = chrono::Utc::now().to_rfc3339();
                        match db::mark_ingest_job_timed_out(&state.pool, &job.id, &now).await {
                            Ok(true) => {
                                if let Ok(uuid) = Uuid::parse_str(&job.id)
                                    && let Some(tx) = state.ingest_jobs.lock().unwrap().remove(&uuid)
                                {
                                    let _ = tx.send(ingest::IngestEvent::Failed {
                                        message: "timed out waiting for Lambda".to_string(),
                                    });
                                }
                            }
                            Ok(false) => {}
                            Err(err) => tracing::error!(job_id = %job.id, error = ?err, "failed to mark ingest job timed out"),
                        }
                    }
                    tracing::info!(count = jobs.len(), "marked stale ingest jobs as timed_out");
                }
                Ok(_) => {}
                Err(err) => tracing::error!(error = ?err, "failed to sweep for stale ingest jobs"),
            }

            match db::find_stale_export_jobs(&state.pool, &export_cutoff).await {
                Ok(jobs) if !jobs.is_empty() => {
                    for job in &jobs {
                        let now = chrono::Utc::now().to_rfc3339();
                        // Only the formats that were non-terminal when
                        // `find_stale_export_jobs` selected this row get
                        // flipped to `timed_out` — re-check status
                        // against the pre-sweep row to know which, rather
                        // than assuming all 3.
                        let was_non_terminal = |status: &str| !matches!(status, "done" | "failed" | "timed_out");
                        let newly_timed_out: Vec<ExportFormat> = [
                            (ExportFormat::Gif, job.gif_status.as_str()),
                            (ExportFormat::Mp4, job.mp4_status.as_str()),
                            (ExportFormat::Webm, job.webm_status.as_str()),
                        ]
                        .into_iter()
                        .filter(|(_, status)| was_non_terminal(status))
                        .map(|(format, _)| format)
                        .collect();

                        match db::mark_export_job_timed_out(&state.pool, &job.id, &now).await {
                            Ok(true) => {
                                let Ok(uuid) = Uuid::parse_str(&job.id) else { continue };
                                let tx = state.export_jobs.lock().unwrap().get(&uuid).cloned();
                                if let Some(tx) = &tx {
                                    for format in &newly_timed_out {
                                        let _ = tx.send(exports::ExportEvent::FormatFailed {
                                            format: *format,
                                            message: "timed out waiting for Lambda".to_string(),
                                        });
                                    }
                                }
                                if let Ok(Some(updated)) = db::get_export_job(&state.pool, &job.id).await
                                    && exports::export_job_is_terminal(&updated)
                                {
                                    if exports::export_job_failed(&updated) {
                                        if let Some(tx) = &tx {
                                            let _ = tx.send(exports::ExportEvent::Failed {
                                                message: "export timed out".to_string(),
                                            });
                                        }
                                        state.export_jobs.lock().unwrap().remove(&uuid);
                                    } else if let Err(err) = exports::finalize_export_job(&state, &updated).await {
                                        tracing::error!(job_id = %job.id, error = ?err, "failed to finalize export job after sweep");
                                    }
                                }
                            }
                            Ok(false) => {}
                            Err(err) => tracing::error!(job_id = %job.id, error = ?err, "failed to mark export job timed out"),
                        }
                    }
                    tracing::info!(count = jobs.len(), "marked stale export jobs as timed_out");
                }
                Ok(_) => {}
                Err(err) => tracing::error!(error = ?err, "failed to sweep for stale export jobs"),
            }
        }
    });
}

pub fn build_app(state: Arc<AppState>) -> Router {
    Router::new()
        .nest("/api", routes::api_router())
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
        // Anything not under /api. `ServeDir` alone only serves index.html
        // for a directory-root request (`/`) — since the frontend is now a
        // real client-side router (multiple paths, not one view-switching
        // page), a deep link like `/library` or a refresh on one 404s
        // without this: falling back to index.html for any path ServeDir
        // can't match to a real static file lets the client-side router
        // take over from there. Use `fallback` (not `not_found_service`,
        // which wraps the fallback in `SetStatus::new(_, 404)` and forces
        // every deep-link response to 404 even though the body is a
        // perfectly good index.html) so the response status stays 200.
        .fallback_service(ServeDir::new(STATIC_DIR).fallback(ServeFile::new(format!("{STATIC_DIR}/index.html"))))
}

pub async fn run() -> anyhow::Result<()> {
    let state = build_state().await?;
    let port = state.config.port;
    let app = build_app(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;

    Ok(())
}
