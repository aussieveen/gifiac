-- Collections (collections-design/COLLECTIONS.md §1): named, unordered
-- groupings of gifs, replacing the flat `favourites` table. Every user
-- gets exactly one `kind = 'favourites'` collection — reserved name
-- "Favourites", can't be renamed or deleted (enforced server-side).
CREATE TABLE collections (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'custom',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CONSTRAINT collections_kind_check CHECK (kind IN ('favourites', 'custom'))
);

-- Case-insensitive per-owner name uniqueness ("Favourites" vs "favourites"
-- can't both exist, nor can two differently-cased dupes of a custom name).
CREATE UNIQUE INDEX idx_collections_owner_name ON collections (owner_id, lower(name));
CREATE INDEX idx_collections_owner_id ON collections (owner_id);

CREATE TABLE collection_gifs (
    collection_id TEXT NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
    gif_id        TEXT NOT NULL REFERENCES gifs (id) ON DELETE CASCADE,
    added_at      TEXT NOT NULL,
    PRIMARY KEY (collection_id, gif_id)
);

CREATE INDEX idx_collection_gifs_gif_id ON collection_gifs (gif_id);

-- Migrate: one Favourites collection per user who already has favourite
-- rows, carrying their original per-row dates across. A user with zero
-- existing favourites gets no row here — their Favourites collection is
-- created lazily on first use (db::get_or_create_favourites_collection).
INSERT INTO collections (id, owner_id, name, kind, created_at, updated_at)
SELECT gen_random_uuid()::text, user_id, 'Favourites', 'favourites', min(created_at), min(created_at)
FROM favourites
GROUP BY user_id;

INSERT INTO collection_gifs (collection_id, gif_id, added_at)
SELECT c.id, f.gif_id, f.created_at
FROM favourites f
JOIN collections c ON c.owner_id = f.user_id AND c.kind = 'favourites';

DROP TABLE favourites;
