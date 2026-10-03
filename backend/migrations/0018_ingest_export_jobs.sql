-- Lambda ingest/export migration (wayfinder gifiac#32), piece 1. Job
-- progress moves from in-memory-only state to these DB-backed rows so a
-- Lambda invocation's callback (piece 3) has somewhere durable to write,
-- and the stuck-job sweep (gifiac#43) has rows to scan.

-- Probing (duration/width/height) now happens in the async ingest Lambda
-- rather than synchronously during upload, so a `videos` row can exist
-- before these are known — inserted as NULL, backfilled by the ingest
-- Lambda's callback once probing completes (piece 3).
ALTER TABLE videos ALTER COLUMN duration_seconds DROP NOT NULL;
ALTER TABLE videos ALTER COLUMN width DROP NOT NULL;
ALTER TABLE videos ALTER COLUMN height DROP NOT NULL;

-- One row per upload, tracking the probe+thumbnail+filmstrip pipeline
-- that now runs in the ingest Lambda instead of inline in upload_video.
-- Stage-only (no percent column) — the 3 stages are coarse enough that a
-- percent bar would be fake precision.
CREATE TABLE ingest_jobs (
    id          TEXT PRIMARY KEY,
    video_id    TEXT NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    stage       TEXT NOT NULL DEFAULT 'uploading',
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

ALTER TABLE ingest_jobs ADD CONSTRAINT ingest_jobs_stage_check
    CHECK (stage IN ('uploading', 'analyzing', 'building_filmstrip', 'complete', 'failed', 'timed_out'));

CREATE INDEX idx_ingest_jobs_video_id ON ingest_jobs (video_id);
-- The stuck-job sweep's "find stale non-terminal rows" query filters on
-- this combination.
CREATE INDEX idx_ingest_jobs_stage_updated_at ON ingest_jobs (stage, updated_at);

-- One row per export, 3 fixed per-format column triples instead of a
-- child table — simpler reads/writes for a fixed, small set of formats
-- (gif/mp4/webm) not expected to grow casually. No stored overall status:
-- that's derived from the 3 columns (gif failure fails the whole job even
-- if mp4/webm succeeded; mp4/webm otherwise fail independently).
--
-- `request_json` stashes the original export request (video/template,
-- captions, owner, save-as-template flag) so the callback handler that
-- finalizes the job once all 3 formats are terminal has what it needs,
-- surviving a backend restart mid-export.
CREATE TABLE export_jobs (
    id            TEXT PRIMARY KEY,
    request_json  TEXT NOT NULL,
    gif_status    TEXT NOT NULL DEFAULT 'pending',
    gif_percent   INTEGER NOT NULL DEFAULT 0,
    gif_error     TEXT,
    mp4_status    TEXT NOT NULL DEFAULT 'pending',
    mp4_percent   INTEGER NOT NULL DEFAULT 0,
    mp4_error     TEXT,
    webm_status   TEXT NOT NULL DEFAULT 'pending',
    webm_percent  INTEGER NOT NULL DEFAULT 0,
    webm_error    TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_gif_status_check
    CHECK (gif_status IN ('pending', 'running', 'done', 'failed', 'timed_out'));
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_mp4_status_check
    CHECK (mp4_status IN ('pending', 'running', 'done', 'failed', 'timed_out'));
ALTER TABLE export_jobs ADD CONSTRAINT export_jobs_webm_status_check
    CHECK (webm_status IN ('pending', 'running', 'done', 'failed', 'timed_out'));

CREATE INDEX idx_export_jobs_updated_at ON export_jobs (updated_at);
