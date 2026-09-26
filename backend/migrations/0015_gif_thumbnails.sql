-- Static poster-frame thumbnails for linked GIFs (external_url IS NOT
-- NULL) — the only gifs with no mp4/webm to pause on instead. Generation
-- is async (fetching a third-party URL can be slow or fail outright), so
-- this tracks where a gif is in that pipeline. NULL for every non-linked
-- gif (mp4/webm cover them, nothing to generate). Set to 'pending' at
-- insert time for a freshly linked gif; flipped to 'ready' or 'failed' by
-- the background job (or the one-off backfill CLI for gifs linked before
-- this existed) once it's actually attempted.
ALTER TABLE gifs ADD COLUMN thumbnail_status TEXT;

ALTER TABLE gifs ADD CONSTRAINT gifs_thumbnail_status_check
    CHECK (thumbnail_status IS NULL OR thumbnail_status IN ('pending', 'ready', 'failed'));

UPDATE gifs SET thumbnail_status = 'pending' WHERE external_url IS NOT NULL;
