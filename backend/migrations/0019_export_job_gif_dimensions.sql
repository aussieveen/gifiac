-- gif's actual post-scale output dimensions, reported by the export
-- Lambda's "done" callback (probed from the encoded file — same "probe
-- the output rather than reimplement the scale filter's rounding rules a
-- second time" approach the pre-Lambda pipeline used). Needed by the
-- "all formats terminal" callback handler to build the `gifs` row, which
-- may arrive in a callback *after* gif's own "done" callback (mp4/webm
-- finish independently) — so these can't just be a local variable at the
-- point gif's callback is handled, they need to survive until then.
ALTER TABLE export_jobs ADD COLUMN gif_width BIGINT;
ALTER TABLE export_jobs ADD COLUMN gif_height BIGINT;
