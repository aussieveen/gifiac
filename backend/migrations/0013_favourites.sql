-- Favourites (SPEC-CLOUD.md §14): a personal saved-library join table. A
-- deleted user or gif cascades away their favourite rows (no tombstones).
-- Un-publishing a gif (gifs.is_public flipping to false) deliberately does
-- NOT touch this table at all — visibility is enforced at read time
-- instead (see db::list_favourite_gifs), so a favourite silently
-- disappears from view and just as silently reappears if the gif is later
-- re-published.
CREATE TABLE favourites (
    user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    gif_id     TEXT NOT NULL REFERENCES gifs (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, gif_id)
);
