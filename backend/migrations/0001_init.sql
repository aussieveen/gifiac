CREATE TABLE videos (
    id                 TEXT PRIMARY KEY,
    original_filename  TEXT NOT NULL,
    extension          TEXT NOT NULL,
    file_size_bytes    INTEGER NOT NULL,
    duration_seconds   REAL NOT NULL,
    width              INTEGER NOT NULL,
    height             INTEGER NOT NULL,
    uploaded_at        TEXT NOT NULL
);

CREATE INDEX idx_videos_uploaded_at ON videos (uploaded_at);

CREATE TABLE gifs (
    id             TEXT PRIMARY KEY,
    video_id       TEXT REFERENCES videos (id),
    name           TEXT NOT NULL,
    caption_text   TEXT NOT NULL DEFAULT '',
    captions_json  TEXT,
    gif_range_start REAL NOT NULL,
    gif_range_end   REAL NOT NULL,
    width          INTEGER NOT NULL,
    height         INTEGER NOT NULL,
    created_at     TEXT NOT NULL
);

CREATE INDEX idx_gifs_video_id ON gifs (video_id);
CREATE INDEX idx_gifs_created_at ON gifs (created_at);
