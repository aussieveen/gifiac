-- Public templates, second attempt — narrower than the design reverted by
-- 0010_remove_template_sharing.sql. No per-caption locking, no use-counts,
-- no attribution/profile pages. A template gets a name and a public/private
-- flag; using a template (whether your own or someone else's) always locks
-- its trim range and output dimensions, only captions/style are editable.

ALTER TABLE templates ADD COLUMN name TEXT NOT NULL DEFAULT 'Untitled template';
ALTER TABLE templates ALTER COLUMN name DROP DEFAULT;
ALTER TABLE templates ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT false;

-- Lineage only (drives the "Remix this GIF" affordance) — never shown to
-- other users as attribution.
ALTER TABLE gifs ADD COLUMN template_id TEXT REFERENCES templates (id) ON DELETE SET NULL;
