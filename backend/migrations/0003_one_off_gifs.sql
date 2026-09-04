-- "One-off" GIFs (differentiating GIFs unlikely to be re-used from the
-- default reusable set) — a simple boolean flag, toggled via `PATCH
-- /api/gifs/{id}`, no separate table needed. SQLite supports `ALTER TABLE
-- ... ADD COLUMN` directly here (unlike the nullability change in
-- 0002_templates_and_links.sql), since this is purely additive.
ALTER TABLE gifs ADD COLUMN is_one_off INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_gifs_is_one_off ON gifs (is_one_off);
