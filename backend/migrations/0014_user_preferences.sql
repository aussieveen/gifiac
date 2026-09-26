-- Preferences section (first option): a per-user settings row, kept
-- separate from `users` so future preferences don't pile columns onto the
-- core identity/auth table. One row per user, created lazily on first
-- write (`db::set_disable_gif_autoplay`'s upsert) — a user who's never
-- touched Preferences has no row at all, and reads default to `false`.
CREATE TABLE user_preferences (
    user_id              TEXT NOT NULL PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    disable_gif_autoplay BOOLEAN NOT NULL DEFAULT false,
    updated_at            TEXT NOT NULL
);
