use std::collections::HashMap;
use std::sync::Mutex;

use sqlx::PgPool;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::auth::GoogleAuthConfig;
use crate::config::Config;
use crate::email_auth::EmailAuthConfig;
use crate::exports::ExportEvent;
use crate::ingest::IngestEvent;
use crate::lambda_jobs::LambdaConfig;
use crate::mailer::Mailer;
use crate::storage::Storage;

pub struct AppState {
    pub pool: PgPool,
    pub config: Config,
    pub storage: Storage,
    /// The private bucket source videos live in (SPEC-CLOUD.md §6) —
    /// distinct from `storage`, which is the public R2 bucket finished
    /// GIF/clip outputs go to.
    pub source_storage: Storage,
    /// The private, versioned bucket a saved template's clip/thumbnail/
    /// filmstrip are backed up to (SPEC-CLOUD.md §10) — distinct from
    /// `source_storage`'s hard 7-day expiry, since a template is meant to
    /// survive indefinitely, not just for the duration of active editing.
    pub template_assets_storage: Storage,
    pub google_auth: GoogleAuthConfig,
    /// Email-passcode login config (SPEC-EMAIL-AUTH.md) — the HMAC key,
    /// Turnstile keys, and rate-limit-adjacent settings read from env at
    /// startup, mirroring `google_auth`.
    pub email_auth: EmailAuthConfig,
    pub mailer: Mailer,
    /// Shared client for the light URL sanity check behind linked GIFs
    /// (SPEC.md §13, see link_check.rs) — reused across requests rather
    /// than building a fresh one per submission.
    pub http_client: reqwest::Client,
    /// In-flight export jobs, keyed by export id, so `GET
    /// /api/exports/{id}/progress` can subscribe to a job's broadcast
    /// channel. Entries are removed once the job reaches a terminal state
    /// (success, failure, or the stuck-job sweep's `timed_out`, gifiac#43)
    /// — a client connecting after that point (or who never had a live
    /// entry at all, e.g. after a backend restart) gets the job's current
    /// state replayed from `export_jobs` the DB table instead of a 404.
    pub export_jobs: Mutex<HashMap<Uuid, broadcast::Sender<ExportEvent>>>,
    /// Same shape as `export_jobs`, for ingest's 3-stage SSE stream.
    pub ingest_jobs: Mutex<HashMap<Uuid, broadcast::Sender<IngestEvent>>>,
    pub lambda_client: aws_sdk_lambda::Client,
    pub lambda_config: LambdaConfig,
}
