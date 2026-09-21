-- Template sharing/use-tracking parity with gifs (SPEC-CLOUD.md §4/§8).
ALTER TABLE templates ADD COLUMN use_count BIGINT NOT NULL DEFAULT 0;

-- Closes the same "nullable for now" gap 0004_ownership_not_null.sql closed
-- for videos/gifs — every insert (upsert_template) has always supplied one.
ALTER TABLE templates ALTER COLUMN user_id SET NOT NULL;
