-- Widening handle validation (backend/src/handle.rs) to allow uppercase
-- letters means handles are no longer forced to lowercase before being
-- stored (routes/profiles.rs::set_handle) — the case the user typed is
-- now preserved. Without this, the plain `handle TEXT UNIQUE` constraint
-- from 0002 would let "Simon" and "simon" both be taken as separate
-- handles, which reads as impersonation/squatting risk on public profile
-- pages (SPEC-CLOUD.md §5), not a real feature. Uniqueness is
-- case-insensitive instead; the column itself still stores (and displays,
-- and is looked up by db::get_user_by_handle) whatever case was typed.
ALTER TABLE users DROP CONSTRAINT users_handle_key;
CREATE UNIQUE INDEX users_handle_lower_key ON users (lower(handle));
