-- The template clip/thumbnail location is derived from `templates.id`,
-- the same way every other asset path in this codebase is derived from
-- its own row's id (video/thumbnail/filmstrip paths, R2 object keys) —
-- see paths.rs. A separately stored key is permanently redundant with
-- that, so the columns 0002_multi_tenant_foundation.sql added per
-- SPEC-CLOUD.md §4's literal table are dropped here before anything ever
-- populates them.
ALTER TABLE templates DROP COLUMN clip_s3_key;
ALTER TABLE templates DROP COLUMN thumbnail_s3_key;
