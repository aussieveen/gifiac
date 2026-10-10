-- `gifs.user_id` (list_gifs) and `gifs.is_public` (list_public_gifs) had no
-- index — every "my gifs" and library listing was a full table scan.
-- Harmless at today's row counts but load-testing flagged it as a
-- scaling risk; adding both now while they're cheap.
CREATE INDEX idx_gifs_user_id ON gifs (user_id);
CREATE INDEX idx_gifs_is_public ON gifs (is_public);
