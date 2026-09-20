-- Postgres schema (SPEC-CLOUD.md §1: metadata DB moves from SQLite to
-- Postgres via RDS). This is a fresh database, not an upgrade path for the
-- old SQLite file's migration history — the one-time carry-over of
-- Simon's existing archive is a separate scripted migration, not sqlx
-- migrations (SPEC-CLOUD.md §12). This file collapses what were three
-- SQLite migrations (init, template/link nullability, one-off flag) into
-- the single shape they'd already reached, translated to Postgres types:
-- BIGINT for the i64 columns (Postgres INTEGER is i32), DOUBLE PRECISION
-- for the f64 columns (Postgres REAL is f32), and a native BOOLEAN for
-- is_one_off instead of SQLite's INTEGER 0/1.

CREATE TABLE videos (
    id                 TEXT PRIMARY KEY,
    original_filename  TEXT NOT NULL,
    extension          TEXT NOT NULL,
    file_size_bytes    BIGINT NOT NULL,
    duration_seconds   DOUBLE PRECISION NOT NULL,
    width              BIGINT NOT NULL,
    height             BIGINT NOT NULL,
    uploaded_at        TEXT NOT NULL
);

CREATE INDEX idx_videos_uploaded_at ON videos (uploaded_at);

CREATE TABLE gifs (
    id              TEXT PRIMARY KEY,
    video_id        TEXT REFERENCES videos (id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    caption_text    TEXT NOT NULL DEFAULT '',
    captions_json   TEXT,
    gif_range_start DOUBLE PRECISION,
    gif_range_end   DOUBLE PRECISION,
    width           BIGINT,
    height          BIGINT,
    external_url    TEXT,
    created_at      TEXT NOT NULL,
    is_one_off      BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_gifs_video_id ON gifs (video_id);
CREATE INDEX idx_gifs_created_at ON gifs (created_at);
CREATE INDEX idx_gifs_is_one_off ON gifs (is_one_off);

CREATE TABLE video_templates (
    video_id     TEXT PRIMARY KEY REFERENCES videos (id),
    payload_json TEXT NOT NULL,
    saved_at     TEXT NOT NULL
);
