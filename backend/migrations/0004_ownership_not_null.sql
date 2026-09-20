-- Ownership scoping (SPEC-CLOUD.md §3) is fully wired up as of this
-- milestone — every insert path now supplies a `user_id` — so the
-- "nullable for now" from 0002_multi_tenant_foundation.sql is tightened
-- here, as that migration's comment said it would be.
ALTER TABLE videos ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE gifs ALTER COLUMN user_id SET NOT NULL;
