-- Multi-tenant schema foundation (SPEC-CLOUD.md). This lays down the
-- tables/columns every later ticket needs to exist, without yet wiring up
-- the behavior that populates them — auth (§2), ownership scoping (§3),
-- and template clip generation (§4) land as their own follow-up work.

-- Auth & identity (SPEC-CLOUD.md §2): pluggable providers via a separate
-- `identities` table rather than a `google_id` column on `users`, so a
-- second provider needs no schema change. Session cookies (not JWTs) are
-- backed by `sessions`, with a sliding 30-day expiry maintained by the
-- application, not the schema.
CREATE TABLE users (
    id         TEXT PRIMARY KEY,
    handle     TEXT UNIQUE,
    role       TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL
);

CREATE TABLE identities (
    provider          TEXT NOT NULL,
    provider_user_id  TEXT NOT NULL,
    user_id           TEXT NOT NULL REFERENCES users (id),
    PRIMARY KEY (provider, provider_user_id)
);

CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users (id),
    created_at     TEXT NOT NULL,
    last_active_at TEXT NOT NULL
);

-- Ownership (SPEC-CLOUD.md §3): plain `user_id` FK per resource, no
-- team/workspace concept. Nullable for now — no auth exists yet to
-- populate it — and tightened to NOT NULL once every write path supplies
-- one.
ALTER TABLE videos ADD COLUMN user_id TEXT REFERENCES users (id);
ALTER TABLE gifs ADD COLUMN user_id TEXT REFERENCES users (id);

-- Sharing & the global library (SPEC-CLOUD.md §4/§8): opt-in publish flag
-- plus a plain incrementing use counter, no events table.
ALTER TABLE gifs ADD COLUMN is_public BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE gifs ADD COLUMN use_count BIGINT NOT NULL DEFAULT 0;

-- `templates` replaces `video_templates` (SPEC-CLOUD.md §4): a template
-- becomes a self-contained clipped asset (`clip_s3_key`/`thumbnail_s3_key`,
-- trimmed at save time) instead of a set of offsets into the original
-- video, so it works without access to the source video. No existing rows
-- to carry over — this is a pre-launch dev branch with no template data
-- yet, so the old table is dropped rather than migrated in place.
CREATE TABLE templates (
    id               TEXT PRIMARY KEY,
    video_id         TEXT NOT NULL UNIQUE REFERENCES videos (id),
    user_id          TEXT REFERENCES users (id),
    clip_s3_key      TEXT,
    thumbnail_s3_key TEXT,
    payload_json     TEXT NOT NULL,
    is_public        BOOLEAN NOT NULL DEFAULT false,
    saved_at         TEXT NOT NULL
);

DROP TABLE video_templates;

-- GIF<->template lineage (SPEC-CLOUD.md §4/§21): stamped at export time
-- when the export form was pre-filled from a template.
ALTER TABLE gifs ADD COLUMN template_id TEXT REFERENCES templates (id) ON DELETE SET NULL;
