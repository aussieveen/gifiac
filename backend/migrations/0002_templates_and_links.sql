CREATE TABLE video_templates (
    video_id     TEXT PRIMARY KEY REFERENCES videos (id),
    payload_json TEXT NOT NULL,
    saved_at     TEXT NOT NULL
);

-- SQLite has no ALTER COLUMN, so relaxing gif_range_start/end and
-- width/height to nullable (SPEC.md §2/§13: NULL for a linked GIF, which
-- has no clip range and isn't dimension-probed) means rebuilding the
-- table. `external_url` is the new linked-GIF marker column, and
-- `video_id` gains ON DELETE SET NULL (the original table had no ON
-- DELETE clause, so a video delete was blocked by the FK constraint by
-- default) — SPEC.md §12 now allows deleting a video with GIFs still made
-- from it, and a GIF whose source video is gone is exactly the "video_id
-- IS NULL" case the archive UI already treats as un-re-editable.
CREATE TABLE gifs_new (
    id              TEXT PRIMARY KEY,
    video_id        TEXT REFERENCES videos (id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    caption_text    TEXT NOT NULL DEFAULT '',
    captions_json   TEXT,
    gif_range_start REAL,
    gif_range_end   REAL,
    width           INTEGER,
    height          INTEGER,
    external_url    TEXT,
    created_at      TEXT NOT NULL
);

INSERT INTO gifs_new (id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, external_url, created_at)
SELECT id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, NULL, created_at
FROM gifs;

DROP TABLE gifs;
ALTER TABLE gifs_new RENAME TO gifs;

CREATE INDEX idx_gifs_video_id ON gifs (video_id);
CREATE INDEX idx_gifs_created_at ON gifs (created_at);
