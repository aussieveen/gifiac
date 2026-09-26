use std::collections::HashMap;
use std::sync::Mutex;

use sqlx::PgPool;
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::auth::GoogleAuthConfig;
use crate::config::Config;
use crate::exports::ExportEvent;
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
    /// Shared client for the light URL sanity check behind linked GIFs
    /// (SPEC.md §13, see link_check.rs) — reused across requests rather
    /// than building a fresh one per submission.
    pub http_client: reqwest::Client,
    /// In-flight export jobs, keyed by export id, so `GET
    /// /api/exports/{id}/progress` can subscribe to a job's broadcast
    /// channel. Entries are removed once the job finishes (success or
    /// failure) — a client connecting after that point gets a 404, which
    /// is an accepted limitation for a single-user LAN tool where the
    /// frontend opens the SSE connection immediately after the `202`.
    pub export_jobs: Mutex<HashMap<Uuid, broadcast::Sender<ExportEvent>>>,
}
