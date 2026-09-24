-- Persisted, collision-resistant URL slug (backend/src/handle.rs,
-- db::set_handle) computed once at handle-set time, not derived on the
-- fly via lower(handle) at query/link-build time (migration 0011's
-- approach). This lets two different handles that happen to case-fold to
-- the same string both exist — instead of the second being rejected
-- outright — with the second's slug disambiguated by a numeric suffix
-- ("sim_mc", "sim_mc2", ...). `handle` itself goes back to a plain
-- (case-sensitive, exact-string) unique constraint: a literal duplicate
-- is still rejected outright; it's only the derived slug that absorbs
-- case collisions.
ALTER TABLE users ADD COLUMN slug TEXT;

-- Backfill: migration 0011 already enforced lower(handle) uniqueness, so
-- no two existing rows can collide here — a plain lowercase is always a
-- safe, unique starting slug for every row that already has a handle.
UPDATE users SET slug = lower(handle) WHERE handle IS NOT NULL;

DROP INDEX users_handle_lower_key;
CREATE UNIQUE INDEX users_handle_key ON users (handle);
CREATE UNIQUE INDEX users_slug_key ON users (slug);
