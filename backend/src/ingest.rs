//! The ingest pipeline's SSE event shape (wayfinder gifiac#32) —
//! probe + thumbnail + filmstrip now run in the ingest Lambda rather than
//! inline in `upload_video`; this is what its callbacks (via
//! `routes::internal::ingest_callback`) get translated into for relay to
//! `GET /api/videos/{job_id}/ingest-progress`'s SSE stream. Mirrors
//! `exports::ExportEvent`'s role for the export side.

use serde::Serialize;

use crate::models::Video;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum IngestEvent {
    /// One of `ingest_jobs.stage`'s non-terminal values
    /// (`uploading`/`analyzing`/`building_filmstrip`).
    Stage { stage: String },
    /// Carries the full, now-probed `Video` row so the frontend can adopt
    /// it immediately without a separate re-fetch — same shape as
    /// `exports::ExportEvent::Complete { gif }`.
    Complete { video: Box<Video> },
    Failed { message: String },
}
