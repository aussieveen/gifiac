-- Minimal, generic audit trail for admin actions (starting with
-- delete-user, the first genuinely irreversible admin action with zero
-- trace today). `target_id` has no FK to `users`/`gifs`/etc — the target
-- row is often the thing being deleted, so it must still be readable
-- after that row is gone. `details` is a plain TEXT column holding a
-- serialized JSON blob (same convention as `gifs.captions_json`), not a
-- real jsonb column, since nothing here needs to query inside it.
CREATE TABLE admin_actions (
    id            TEXT NOT NULL PRIMARY KEY,
    admin_user_id TEXT NOT NULL REFERENCES users (id),
    action_type   TEXT NOT NULL,
    target_id     TEXT NOT NULL,
    details       TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE INDEX admin_actions_created_at_idx ON admin_actions (created_at DESC);
