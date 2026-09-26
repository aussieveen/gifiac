use std::collections::HashSet;

use anyhow::Result;
use sqlx::postgres::{PgPool, PgPoolOptions};
use uuid::Uuid;

use crate::handle;
use crate::models::{
    AdminUserView, Gif, LibrarySort, NewGif, NewVideo, PreferencesView, PublicGif, Session, Template, TemplatePayload,
    UpdatePreferencesRequest, User, Video, VideoListItem, VideoTemplate,
};

const VIDEO_COLUMNS: &str = "id, original_filename, extension, file_size_bytes, duration_seconds, width, height, uploaded_at";
const GIF_COLUMNS: &str = "id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, external_url, created_at, is_one_off, is_public, use_count, thumbnail_status";
/// The columns a fresh insert actually supplies — `is_one_off` is
/// deliberately excluded: every newly created GIF (export, import, or
/// link) starts out reusable, relying on the schema's `DEFAULT false`
/// rather than binding it explicitly. `user_id` isn't part of either
/// column list: it's an ownership-scoping parameter on every function
/// here, never part of what's `SELECT`ed back out to a response (SPEC-
/// CLOUD.md §3's ownership model is enforced in the query, not surfaced
/// to the frontend).
const INSERT_GIF_COLUMNS: &str = "id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, external_url, created_at, thumbnail_status";
const TEMPLATE_COLUMNS: &str = "id, video_id, user_id, payload_json, saved_at";

pub async fn create_pool(database_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new().connect(database_url).await?;
    Ok(pool)
}

pub async fn run_migrations(pool: &PgPool) -> Result<()> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

/// Spins up a throwaway Postgres database (via a maintenance connection to
/// `TEST_DATABASE_URL`, default a local `postgres` superuser database) and
/// runs migrations against it, so a test gets the same complete isolation
/// SQLite's `:memory:` used to give for free — this is what let many tests
/// in this file (and every integration-test binary under
/// `backend/tests/`) reuse hardcoded ids like `"v1"`/`"g1"` without
/// clashing. The created database is never dropped: Postgres has no
/// synchronous "drop this pool's own database" hook, and leaking scratch
/// test databases locally is the same accepted tradeoff already made for
/// MinIO test objects in `backend/tests/common::test_storage` — periodic
/// manual cleanup (`dropdb`) is fine for a dev/CI Postgres instance that
/// only ever holds throwaway data.
pub async fn create_ephemeral_test_pool() -> PgPool {
    let admin_url = std::env::var("TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://gifiac:gifiac@localhost:5432/gifiac".to_string());
    let admin_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&admin_url)
        .await
        .expect("failed to connect to TEST_DATABASE_URL for ephemeral test database setup");

    let db_name = format!("gifiac_test_{}", Uuid::new_v4().simple());
    sqlx::query(sqlx::AssertSqlSafe(format!("CREATE DATABASE \"{db_name}\"")))
        .execute(&admin_pool)
        .await
        .expect("failed to create ephemeral test database");
    admin_pool.close().await;

    let (base, _) = admin_url
        .rsplit_once('/')
        .expect("TEST_DATABASE_URL must be a postgres:// URL with a database path");
    let test_url = format!("{base}/{db_name}");

    let pool = create_pool(&test_url)
        .await
        .expect("failed to connect to newly created ephemeral test database");
    run_migrations(&pool).await.expect("failed to run migrations against ephemeral test database");
    pool
}

pub async fn insert_video(pool: &PgPool, video: &NewVideo, uploaded_at: &str) -> Result<Video> {
    let sql = format!(
        "INSERT INTO videos ({VIDEO_COLUMNS}, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING {VIDEO_COLUMNS}"
    );
    sqlx::query_as::<_, Video>(sqlx::AssertSqlSafe(sql))
        .bind(&video.id)
        .bind(&video.original_filename)
        .bind(&video.extension)
        .bind(video.file_size_bytes)
        .bind(video.duration_seconds)
        .bind(video.width)
        .bind(video.height)
        .bind(uploaded_at)
        .bind(&video.user_id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn get_video(pool: &PgPool, id: &str, owner_id: &str) -> Result<Option<Video>> {
    let sql = format!("SELECT {VIDEO_COLUMNS} FROM videos WHERE id = $1 AND user_id = $2");
    sqlx::query_as::<_, Video>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(owner_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// `has_template` is resolved at the join level (SPEC.md §12) rather than
/// with a per-video follow-up query.
pub async fn list_videos(pool: &PgPool, owner_id: &str) -> Result<Vec<VideoListItem>> {
    let sql = "SELECT v.id, v.original_filename, v.extension, v.file_size_bytes, v.duration_seconds, v.width, v.height, v.uploaded_at, (t.video_id IS NOT NULL) AS has_template \
         FROM videos v LEFT JOIN templates t ON t.video_id = v.id WHERE v.user_id = $1 ORDER BY v.uploaded_at DESC";
    sqlx::query_as::<_, VideoListItem>(sql)
        .bind(owner_id)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn insert_gif(pool: &PgPool, gif: &NewGif, created_at: &str) -> Result<Gif> {
    // A linked gif (external_url set) starts `pending` — nothing to
    // transcode server-side, but a thumbnail still needs fetching/
    // extracting from the third-party URL (see thumbnails.rs). Every other
    // gif has mp4/webm from the transcode pipeline instead, so there's
    // nothing to generate here.
    let thumbnail_status = gif.external_url.is_some().then_some("pending");
    let sql = format!(
        "INSERT INTO gifs ({INSERT_GIF_COLUMNS}, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING {GIF_COLUMNS}"
    );
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(&gif.id)
        .bind(&gif.video_id)
        .bind(&gif.name)
        .bind(&gif.caption_text)
        .bind(&gif.captions_json)
        .bind(gif.gif_range_start)
        .bind(gif.gif_range_end)
        .bind(gif.width)
        .bind(gif.height)
        .bind(&gif.external_url)
        .bind(created_at)
        .bind(thumbnail_status)
        .bind(&gif.user_id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// Flips a linked gif's thumbnail pipeline status (see
/// `0015_gif_thumbnails.sql`) — used by both the background job spawned
/// from `routes::gifs::link_gif` and the one-off backfill CLI, so the two
/// share one place that knows how this column is written.
pub async fn set_thumbnail_status(pool: &PgPool, gif_id: &str, status: &str) -> Result<()> {
    sqlx::query("UPDATE gifs SET thumbnail_status = $1 WHERE id = $2")
        .bind(status)
        .bind(gif_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Every linked gif never attempted by the thumbnail pipeline — what the
/// backfill CLI processes. Ignores `failed` rows deliberately (SPEC
/// decision: a permanently broken external link isn't retried
/// automatically; re-running this CLI against `failed` rows too is a
/// manual, deliberate choice, not this query's default).
pub async fn list_gifs_needing_thumbnail(pool: &PgPool) -> Result<Vec<Gif>> {
    let sql = format!(
        "SELECT {GIF_COLUMNS} FROM gifs WHERE external_url IS NOT NULL AND thumbnail_status = 'pending' ORDER BY created_at ASC"
    );
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// A user's saved preferences (Preferences page) — `None` (no
/// `user_preferences` row yet) reads as every preference defaulting off,
/// same as `PreferencesView::default()`.
pub async fn get_preferences(pool: &PgPool, user_id: &str) -> Result<PreferencesView> {
    let row: Option<PreferencesView> =
        sqlx::query_as("SELECT disable_gif_autoplay FROM user_preferences WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.unwrap_or_default())
}

/// Merges `request` onto the caller's existing preferences (each field
/// independently optional, see `UpdatePreferencesRequest`) and upserts the
/// result — a user's first-ever preference change creates their row.
pub async fn update_preferences(
    pool: &PgPool,
    user_id: &str,
    request: &UpdatePreferencesRequest,
    updated_at: &str,
) -> Result<PreferencesView> {
    let current = get_preferences(pool, user_id).await?;
    let updated = PreferencesView {
        disable_gif_autoplay: request.disable_gif_autoplay.unwrap_or(current.disable_gif_autoplay),
    };
    sqlx::query(
        "INSERT INTO user_preferences (user_id, disable_gif_autoplay, updated_at) VALUES ($1, $2, $3) \
         ON CONFLICT (user_id) DO UPDATE SET disable_gif_autoplay = $2, updated_at = $3",
    )
    .bind(user_id)
    .bind(updated.disable_gif_autoplay)
    .bind(updated_at)
    .execute(pool)
    .await?;
    Ok(updated)
}

/// SPEC.md §5: `q` matches `name` and `caption_text` **together** — one
/// combined filter, no separate name/tag params. `None`/empty returns
/// everything, newest first, no pagination (v1). Sorted `is_one_off ASC`
/// first (SPEC.md §8): reusable GIFs come before one-offs, each group
/// newest-first — the frontend renders the "One-offs" divider wherever
/// the flag flips in this single ordered list. Scoped to `owner_id`
/// throughout (SPEC-CLOUD.md §3) — the global library (all users' public
/// gifs) is a separate, later query, not this one.
pub async fn list_gifs(pool: &PgPool, owner_id: &str, q: Option<&str>) -> Result<Vec<Gif>> {
    match q.map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => {
            // `ILIKE`, not `LIKE`: SQLite's `LIKE` is case-insensitive for
            // ASCII by default, Postgres' isn't — `ILIKE` is what
            // reproduces that original case-insensitive search behavior.
            let sql = format!(
                "SELECT {GIF_COLUMNS} FROM gifs WHERE user_id = $1 AND (name ILIKE $2 ESCAPE '\\' OR caption_text ILIKE $3 ESCAPE '\\') ORDER BY is_one_off ASC, created_at DESC"
            );
            let pattern = format!("%{}%", escape_like(q));
            sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
                .bind(owner_id)
                .bind(&pattern)
                .bind(&pattern)
                .fetch_all(pool)
                .await
                .map_err(Into::into)
        }
        None => {
            let sql = format!(
                "SELECT {GIF_COLUMNS} FROM gifs WHERE user_id = $1 ORDER BY is_one_off ASC, created_at DESC"
            );
            sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
                .bind(owner_id)
                .fetch_all(pool)
                .await
                .map_err(Into::into)
        }
    }
}

/// Escapes `LIKE` wildcards (`%`, `_`) in user-supplied search text, paired
/// with `ESCAPE '\'` at the call site, so a search containing them is
/// matched literally instead of as a pattern.
fn escape_like(input: &str) -> String {
    input.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub async fn get_gif(pool: &PgPool, id: &str, owner_id: &str) -> Result<Option<Gif>> {
    let sql = format!("SELECT {GIF_COLUMNS} FROM gifs WHERE id = $1 AND user_id = $2");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(owner_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Renames a GIF in place (SPEC.md §5 `PATCH /api/gifs/{id}` — no
/// re-export needed). Returns `None` if no row matched, so the route can
/// tell "renamed" apart from "doesn't exist" without a separate lookup.
pub async fn rename_gif(pool: &PgPool, id: &str, owner_id: &str, name: &str) -> Result<Option<Gif>> {
    let sql = format!("UPDATE gifs SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING {GIF_COLUMNS}");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(name)
        .bind(id)
        .bind(owner_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Flips the "one-off" flag (SPEC.md §8) — the same `PATCH
/// /api/gifs/{id}` toggle button in the archive detail panel sets this
/// back to `false` to return a GIF to the reusable group. A separate
/// function from `rename_gif` rather than one combined dynamic-SQL
/// update: each field is independently optional in the request, and two
/// plain, statically-checked `UPDATE`s are simpler than building a SQL
/// string conditionally.
pub async fn set_gif_one_off(pool: &PgPool, id: &str, owner_id: &str, is_one_off: bool) -> Result<Option<Gif>> {
    let sql = format!("UPDATE gifs SET is_one_off = $1 WHERE id = $2 AND user_id = $3 RETURNING {GIF_COLUMNS}");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(is_one_off)
        .bind(id)
        .bind(owner_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Opts a gif into (or out of) the global library and its creator's
/// public profile (SPEC-CLOUD.md §4/§8) — same pattern as
/// `set_gif_one_off`.
pub async fn set_gif_public(pool: &PgPool, id: &str, owner_id: &str, is_public: bool) -> Result<Option<Gif>> {
    let sql = format!("UPDATE gifs SET is_public = $1 WHERE id = $2 AND user_id = $3 RETURNING {GIF_COLUMNS}");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(is_public)
        .bind(id)
        .bind(owner_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Bumps a gif's use counter (SPEC-CLOUD.md §8: copy-link, copy-embed, and
/// download all fire this) — no ownership/visibility check, since the spec
/// only requires "auth required," not "must be public or yours," and a
/// private gif's id is unguessable by anyone but its owner anyway.
pub async fn increment_gif_use_count(pool: &PgPool, id: &str) -> Result<Option<Gif>> {
    let sql = format!("UPDATE gifs SET use_count = use_count + 1 WHERE id = $1 RETURNING {GIF_COLUMNS}");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Returns `true` if a row was actually deleted, so the route can 404 on a
/// nonexistent id rather than reporting a no-op delete as success.
pub async fn delete_gif(pool: &PgPool, id: &str, owner_id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM gifs WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(owner_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn delete_video(pool: &PgPool, id: &str, owner_id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM videos WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(owner_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn get_template(pool: &PgPool, video_id: &str) -> Result<Option<TemplatePayload>> {
    let row: Option<VideoTemplate> =
        sqlx::query_as("SELECT video_id, payload_json, saved_at FROM templates WHERE video_id = $1")
            .bind(video_id)
            .fetch_optional(pool)
            .await?;
    row.map(|r| serde_json::from_str(&r.payload_json).map_err(Into::into))
        .transpose()
}

/// The `id` of the template already saved for `video_id`, if any — lets
/// the caller reuse it across an overwrite (SPEC-CLOUD.md §4: the clip/
/// thumbnail files on disk are named after this id, via `paths.rs`, so
/// reusing it means an overwrite replaces those files in place instead of
/// orphaning the previous save's).
pub async fn get_template_id(pool: &PgPool, video_id: &str) -> Result<Option<String>> {
    sqlx::query_scalar("SELECT id FROM templates WHERE video_id = $1")
        .bind(video_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Upserts the template for `video_id` (SPEC.md §12: "Upserts (creates or
/// overwrites) the template with the request body"). `id` is the
/// caller's to generate (or reuse, via `get_template_id`, on an
/// overwrite) — unlike before M3, the route needs it *before* this call
/// to name the clip/thumbnail files it writes to disk. `ON CONFLICT`
/// leaves `id`/`user_id` alone on an overwrite: a template's identity and
/// creator survive being re-saved.
pub async fn upsert_template(
    pool: &PgPool,
    id: &str,
    video_id: &str,
    user_id: &str,
    payload: &TemplatePayload,
    saved_at: &str,
) -> Result<()> {
    let payload_json = serde_json::to_string(payload)?;
    sqlx::query(
        "INSERT INTO templates (id, video_id, user_id, payload_json, saved_at) VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (video_id) DO UPDATE SET payload_json = excluded.payload_json, saved_at = excluded.saved_at",
    )
    .bind(id)
    .bind(video_id)
    .bind(user_id)
    .bind(payload_json)
    .bind(saved_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Returns `true` if a template was actually deleted.
pub async fn delete_template(pool: &PgPool, video_id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM templates WHERE video_id = $1")
        .bind(video_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// A template's full row, any visibility — used only by the owner-only
/// `PATCH /api/templates/{id}` route, which needs to find the row (to
/// distinguish "doesn't exist" from "not yours") before its ownership
/// check can run.
pub async fn get_template_by_id(pool: &PgPool, id: &str) -> Result<Option<Template>> {
    let sql = format!("SELECT {TEMPLATE_COLUMNS} FROM templates WHERE id = $1");
    sqlx::query_as::<_, Template>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

const USER_COLUMNS: &str = "id, handle, slug, role, created_at, email, avatar_url, display_name, disabled";

/// SPEC-CLOUD.md §2: identity lookup is the sole way a login resolves to a
/// user — no merging by email, since Google is (for now) the only
/// provider and there's nothing to merge across yet.
pub async fn find_user_by_identity(pool: &PgPool, provider: &str, provider_user_id: &str) -> Result<Option<User>> {
    let sql = format!(
        "SELECT {USER_COLUMNS} FROM users u JOIN identities i ON i.user_id = u.id WHERE i.provider = $1 AND i.provider_user_id = $2"
    );
    sqlx::query_as::<_, User>(sqlx::AssertSqlSafe(sql))
        .bind(provider)
        .bind(provider_user_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

pub async fn get_user(pool: &PgPool, id: &str) -> Result<Option<User>> {
    let sql = format!("SELECT {USER_COLUMNS} FROM users WHERE id = $1");
    sqlx::query_as::<_, User>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Creates a brand-new user plus the identity that resolves to it, in one
/// transaction — a first-time Google login always creates both together
/// (SPEC-CLOUD.md §2), never a user without at least one identity.
/// `handle` starts `NULL`: picking one is the M5 profiles ticket's job,
/// not this one's.
#[allow(clippy::too_many_arguments)]
pub async fn create_user_with_identity(
    pool: &PgPool,
    user_id: &str,
    created_at: &str,
    provider: &str,
    provider_user_id: &str,
    email: Option<&str>,
    avatar_url: Option<&str>,
    display_name: Option<&str>,
) -> Result<User> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO users (id, role, created_at, email, avatar_url, display_name) VALUES ($1, 'user', $2, $3, $4, $5)",
    )
    .bind(user_id)
    .bind(created_at)
    .bind(email)
    .bind(avatar_url)
    .bind(display_name)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO identities (provider, provider_user_id, user_id) VALUES ($1, $2, $3)")
        .bind(provider)
        .bind(provider_user_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    get_user(pool, user_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("user row vanished immediately after insert"))
}

/// Refreshes the profile fields captured from the OAuth payload (§2/§5) —
/// called on every login, not just the first, since a display name or
/// avatar can change on Google's side over time.
pub async fn update_user_profile_fields(
    pool: &PgPool,
    user_id: &str,
    email: Option<&str>,
    avatar_url: Option<&str>,
    display_name: Option<&str>,
) -> Result<()> {
    sqlx::query("UPDATE users SET email = $1, avatar_url = $2, display_name = $3 WHERE id = $4")
        .bind(email)
        .bind(avatar_url)
        .bind(display_name)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Admin-only (SPEC-CLOUD.md §7): flips the disabled flag, blocking
/// further login (checked in `routes::auth::callback`). No owner scoping —
/// there's no "owner" of an account other than the admin acting on it;
/// authorization is enforced by the `AdminUser` extractor at the route
/// layer, not here.
pub async fn set_user_disabled(pool: &PgPool, id: &str, disabled: bool) -> Result<Option<User>> {
    let sql = format!("UPDATE users SET disabled = $1 WHERE id = $2 RETURNING {USER_COLUMNS}");
    sqlx::query_as::<_, User>(sqlx::AssertSqlSafe(sql))
        .bind(disabled)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// The actual mechanism behind "disable revokes the user's sessions"
/// (SPEC-CLOUD.md §7) — `CurrentUser`'s existing session-lookup-fails-401
/// behavior does the rest, immediately, on the next request.
pub async fn delete_sessions_for_user(pool: &PgPool, user_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// `GET /api/admin/users` (SPEC-CLOUD.md §7) — every user plus per-user
/// usage stats, to spot the heaviest users ahead of ever needing quotas.
pub async fn admin_list_users(pool: &PgPool) -> Result<Vec<AdminUserView>> {
    let sql = "SELECT users.id, users.handle, users.email, users.avatar_url, users.role, users.disabled, \
         users.created_at, COUNT(gifs.id) AS gif_count, MAX(gifs.created_at) AS latest_gif_at \
         FROM users LEFT JOIN gifs ON gifs.user_id = users.id \
         GROUP BY users.id ORDER BY users.created_at DESC";
    sqlx::query_as::<_, AdminUserView>(sql)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// Admin visibility into any user's gifs/templates (SPEC-CLOUD.md §7) —
/// same shape as `list_public_gifs_by_user`/a plain per-video template
/// list, but with no `is_public` filter: an admin sees private content
/// too, which is the entire point.
pub async fn admin_list_gifs_by_user(pool: &PgPool, user_id: &str) -> Result<Vec<Gif>> {
    let sql = format!("SELECT {GIF_COLUMNS} FROM gifs WHERE user_id = $1 ORDER BY created_at DESC");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn admin_list_templates_by_user(pool: &PgPool, user_id: &str) -> Result<Vec<Template>> {
    let sql = format!("SELECT {TEMPLATE_COLUMNS} FROM templates WHERE user_id = $1 ORDER BY saved_at DESC");
    sqlx::query_as::<_, Template>(sqlx::AssertSqlSafe(sql))
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// Like `get_gif`, but admin-scoped — no owner filter (SPEC-CLOUD.md §7:
/// "delete/unpublish any gif"). Also reused by `routes::gifs::unfavourite_gif`
/// (SPEC-CLOUD.md §14) for a non-admin caller — but only once they've
/// proven legitimate prior knowledge of the gif (an existing favourite
/// row); never call this for an id a caller hasn't already earned access
/// to some other way.
pub async fn admin_get_gif(pool: &PgPool, id: &str) -> Result<Option<Gif>> {
    let sql = format!("SELECT {GIF_COLUMNS} FROM gifs WHERE id = $1");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Like `delete_gif`, but admin-scoped — no owner filter.
pub async fn admin_delete_gif(pool: &PgPool, id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM gifs WHERE id = $1").bind(id).execute(pool).await?;
    Ok(result.rows_affected() > 0)
}

/// Like `set_gif_public`, but admin-scoped and one-directional — an admin
/// only ever takes content *down* (SPEC-CLOUD.md §7's "unpublish"), never
/// publishes someone else's private content on their behalf.
pub async fn admin_unpublish_gif(pool: &PgPool, id: &str) -> Result<Option<Gif>> {
    let sql = format!("UPDATE gifs SET is_public = false WHERE id = $1 RETURNING {GIF_COLUMNS}");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Deletes a template by its own id, admin-scoped, no owner filter —
/// distinct from `delete_template`, which is video-id-scoped for the
/// owner's own video-nested flow.
pub async fn admin_delete_template(pool: &PgPool, id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM templates WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Astronomically generous — collisions this deep would mean thousands of
/// handles case-folding to the same base slug, not a real scenario, just
/// a bound so a pathological case can't loop forever.
const MAX_SLUG_ATTEMPTS: u32 = 1000;

/// Sets a user's handle (and its derived, collision-resistant slug,
/// migration 0012) exactly once — `false` covers "already set" (the
/// `WHERE handle IS NULL` matches no row) and "this exact handle string
/// is already taken" (a `users_handle_key` violation) — SPEC-CLOUD.md §5:
/// "locked permanently once set". A *slug* collision — a different
/// handle that case-folds to the same lowercase form — isn't a failure:
/// it just retries with the next numbered suffix
/// (`handle::slug_candidate`) until a free one is found.
pub async fn set_handle(pool: &PgPool, user_id: &str, handle: &str) -> Result<bool> {
    let base = handle::base_slug(handle);
    for attempt in 1..=MAX_SLUG_ATTEMPTS {
        let slug = handle::slug_candidate(&base, attempt);
        let result = sqlx::query("UPDATE users SET handle = $1, slug = $2 WHERE id = $3 AND handle IS NULL")
            .bind(handle)
            .bind(&slug)
            .bind(user_id)
            .execute(pool)
            .await;
        match result {
            Ok(result) => return Ok(result.rows_affected() > 0),
            Err(sqlx::Error::Database(db_err)) if db_err.constraint() == Some("users_slug_key") => continue,
            Err(sqlx::Error::Database(db_err)) if db_err.is_unique_violation() => return Ok(false),
            Err(err) => return Err(err.into()),
        }
    }
    Ok(false)
}

/// Exact match — `slug` is already the canonical, collision-resolved
/// lowercase form (`db::set_handle`), so unlike the old
/// `get_user_by_handle` (migration 0011) this needs no `lower()` folding.
pub async fn get_user_by_slug(pool: &PgPool, slug: &str) -> Result<Option<User>> {
    let sql = format!("SELECT {USER_COLUMNS} FROM users WHERE slug = $1");
    sqlx::query_as::<_, User>(sqlx::AssertSqlSafe(sql))
        .bind(slug)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// A user's public gifs (SPEC-CLOUD.md §5's profile page) — no owner
/// check, this is the one gif-listing query meant to be reachable by
/// anyone, scoped by `is_public` instead of by caller identity.
pub async fn list_public_gifs_by_user(pool: &PgPool, user_id: &str) -> Result<Vec<Gif>> {
    let sql = format!(
        "SELECT {GIF_COLUMNS} FROM gifs WHERE user_id = $1 AND is_public = true ORDER BY created_at DESC"
    );
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// The global library (SPEC-CLOUD.md §8) — every user's public gifs, with
/// the same name/caption `ILIKE` search `list_gifs` does, plus the
/// creator's handle for attribution. `sort` picks `Newest` (creation-time,
/// the only option before M5c) or `MostUsed` (`use_count` descending, with
/// creation-time as a tiebreaker for equally-used gifs).
pub async fn list_public_gifs(pool: &PgPool, q: Option<&str>, sort: LibrarySort) -> Result<Vec<PublicGif>> {
    let columns = "gifs.id, gifs.video_id, gifs.name, gifs.caption_text, gifs.captions_json, \
         gifs.gif_range_start, gifs.gif_range_end, gifs.width, gifs.height, gifs.external_url, \
         gifs.created_at, gifs.is_one_off, gifs.is_public, gifs.use_count, gifs.thumbnail_status, \
         users.handle AS owner_handle, users.slug AS owner_slug";
    let order_by = match sort {
        LibrarySort::Newest => "gifs.created_at DESC",
        LibrarySort::MostUsed => "gifs.use_count DESC, gifs.created_at DESC",
    };
    match q.map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => {
            let sql = format!(
                "SELECT {columns} FROM gifs JOIN users ON users.id = gifs.user_id \
                 WHERE gifs.is_public = true AND (gifs.name ILIKE $1 ESCAPE '\\' OR gifs.caption_text ILIKE $2 ESCAPE '\\') \
                 ORDER BY {order_by}"
            );
            let pattern = format!("%{}%", escape_like(q));
            sqlx::query_as::<_, PublicGif>(sqlx::AssertSqlSafe(sql))
                .bind(&pattern)
                .bind(&pattern)
                .fetch_all(pool)
                .await
                .map_err(Into::into)
        }
        None => {
            let sql = format!(
                "SELECT {columns} FROM gifs JOIN users ON users.id = gifs.user_id \
                 WHERE gifs.is_public = true ORDER BY {order_by}"
            );
            sqlx::query_as::<_, PublicGif>(sqlx::AssertSqlSafe(sql))
                .fetch_all(pool)
                .await
                .map_err(Into::into)
        }
    }
}

pub async fn is_favourited(pool: &PgPool, user_id: &str, gif_id: &str) -> Result<bool> {
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM favourites WHERE user_id = $1 AND gif_id = $2")
        .bind(user_id)
        .bind(gif_id)
        .fetch_optional(pool)
        .await?;
    Ok(exists.is_some())
}

pub async fn list_favourite_gif_ids(pool: &PgPool, user_id: &str) -> Result<HashSet<String>> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT gif_id FROM favourites WHERE user_id = $1")
        .bind(user_id)
        .fetch_all(pool)
        .await?;
    Ok(ids.into_iter().collect())
}

/// Shared by every auth-optional list endpoint (`list_library`,
/// `get_profile` — SPEC-CLOUD.md §14): an anonymous viewer gets an empty
/// set (everything reads as not-favourited) without a wasted query.
pub async fn favourited_ids_for_viewer(pool: &PgPool, viewer_id: Option<&str>) -> Result<HashSet<String>> {
    match viewer_id {
        Some(id) => list_favourite_gif_ids(pool, id).await,
        None => Ok(HashSet::new()),
    }
}

/// A gif eligible to be favourited by `viewer_id` (SPEC-CLOUD.md §14):
/// opted into the global library, or owned by the viewer themselves
/// (public or private) — the only thing excluded is another user's
/// private gif.
pub async fn get_favouritable_gif(pool: &PgPool, id: &str, viewer_id: &str) -> Result<Option<Gif>> {
    let sql = format!("SELECT {GIF_COLUMNS} FROM gifs WHERE id = $1 AND (is_public = true OR user_id = $2)");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(viewer_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Idempotent — saving an already-favourited gif again leaves its
/// original `created_at` untouched rather than bumping it back to the top
/// of Saved.
pub async fn add_favourite(pool: &PgPool, user_id: &str, gif_id: &str, created_at: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO favourites (user_id, gif_id, created_at) VALUES ($1, $2, $3) \
         ON CONFLICT (user_id, gif_id) DO NOTHING",
    )
    .bind(user_id)
    .bind(gif_id)
    .bind(created_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Idempotent — removing a favourite that was never saved (or already
/// removed) is a no-op, not an error. Doesn't check the gif's current
/// visibility: unfavouriting your own bookmark is always allowed, even
/// for a gif its owner has since made private (SPEC-CLOUD.md §14).
pub async fn remove_favourite(pool: &PgPool, user_id: &str, gif_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM favourites WHERE user_id = $1 AND gif_id = $2")
        .bind(user_id)
        .bind(gif_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// The caller's saved gifs (SPEC-CLOUD.md §14, `GET /api/favourites`),
/// newest-favourited first — ordered by `favourites.created_at`, not the
/// gif's own, so re-favouriting an old gif bumps it back to the top.
/// Filtered to gifs still visible to the viewer (public, or owned by
/// them): un-publishing a gif doesn't delete its favourite row (see
/// migration 0013), so this filter is what makes it disappear from Saved
/// and reappear if it's re-published later.
pub async fn list_favourite_gifs(pool: &PgPool, user_id: &str) -> Result<Vec<PublicGif>> {
    let sql = "SELECT gifs.id, gifs.video_id, gifs.name, gifs.caption_text, gifs.captions_json, \
         gifs.gif_range_start, gifs.gif_range_end, gifs.width, gifs.height, gifs.external_url, \
         gifs.created_at, gifs.is_one_off, gifs.is_public, gifs.use_count, gifs.thumbnail_status, \
         users.handle AS owner_handle, users.slug AS owner_slug \
         FROM favourites \
         JOIN gifs ON gifs.id = favourites.gif_id \
         JOIN users ON users.id = gifs.user_id \
         WHERE favourites.user_id = $1 AND (gifs.is_public = true OR gifs.user_id = $1) \
         ORDER BY favourites.created_at DESC";
    sqlx::query_as::<_, PublicGif>(sql)
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn create_session(pool: &PgPool, id: &str, user_id: &str, now: &str) -> Result<()> {
    sqlx::query("INSERT INTO sessions (id, user_id, created_at, last_active_at) VALUES ($1, $2, $3, $3)")
        .bind(id)
        .bind(user_id)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn get_session(pool: &PgPool, id: &str) -> Result<Option<Session>> {
    sqlx::query_as::<_, Session>("SELECT id, user_id, created_at, last_active_at FROM sessions WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Refreshes the sliding expiry (SPEC-CLOUD.md §2) — called on every
/// authenticated request that passes the `CurrentUser` extractor.
pub async fn touch_session(pool: &PgPool, id: &str, now: &str) -> Result<()> {
    sqlx::query("UPDATE sessions SET last_active_at = $1 WHERE id = $2")
        .bind(now)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Revoking a session (logout, or an admin disabling an account per §7)
/// is just deleting this row — no separate "revoked" flag to check.
pub async fn delete_session(pool: &PgPool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> PgPool {
        create_ephemeral_test_pool().await
    }

    /// A real `users` row — ownership FKs (SPEC-CLOUD.md §3) are `NOT
    /// NULL` as of this milestone, so every video/gif insert in these
    /// tests needs one to point at.
    async fn seed_user(pool: &PgPool) -> String {
        let id = Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO users (id, role, created_at) VALUES ($1, 'user', $2)")
            .bind(&id)
            .bind(chrono::Utc::now().to_rfc3339())
            .execute(pool)
            .await
            .unwrap();
        id
    }

    fn sample_video(id: &str, user_id: &str) -> NewVideo {
        NewVideo {
            id: id.to_string(),
            original_filename: "clip.mp4".to_string(),
            extension: "mp4".to_string(),
            file_size_bytes: 1024,
            duration_seconds: 12.5,
            width: 1920,
            height: 1080,
            user_id: user_id.to_string(),
        }
    }

    #[tokio::test]
    async fn insert_then_get_round_trips_all_fields() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        let inserted = insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        assert_eq!(inserted.id, "v1");
        assert_eq!(inserted.original_filename, "clip.mp4");
        assert_eq!(inserted.width, 1920);

        let fetched = get_video(&pool, "v1", &user).await.unwrap().unwrap();
        assert_eq!(fetched.id, inserted.id);
        assert_eq!(fetched.duration_seconds, 12.5);
    }

    #[tokio::test]
    async fn get_missing_video_returns_none() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        assert!(get_video(&pool, "missing", &user).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn get_video_scoped_to_another_owner_returns_none() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &owner), "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        assert!(get_video(&pool, "v1", &other).await.unwrap().is_none());
        assert!(get_video(&pool, "v1", &owner).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn list_videos_orders_newest_first() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("older", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_video(&pool, &sample_video("newer", &user), "2026-08-21T00:00:00Z")
            .await
            .unwrap();

        let videos = list_videos(&pool, &user).await.unwrap();
        let ids: Vec<&str> = videos.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, vec!["newer", "older"]);
    }

    #[tokio::test]
    async fn list_videos_only_returns_the_owners_own_videos() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        insert_video(&pool, &sample_video("mine", &owner), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        insert_video(&pool, &sample_video("theirs", &other), "2026-08-22T00:00:01Z")
            .await
            .unwrap();

        let videos = list_videos(&pool, &owner).await.unwrap();
        let ids: Vec<&str> = videos.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, vec!["mine"]);
    }

    #[tokio::test]
    async fn list_videos_reports_has_template_only_for_videos_with_a_saved_template() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        insert_video(&pool, &sample_video("v2", &user), "2026-08-22T00:00:01Z")
            .await
            .unwrap();
        upsert_template(&pool, "t1", "v1", &user, &sample_template(), "2026-08-22T00:00:02Z")
            .await
            .unwrap();

        let videos = list_videos(&pool, &user).await.unwrap();
        let has_template = |id: &str| videos.iter().find(|v| v.id == id).unwrap().has_template;
        assert!(has_template("v1"));
        assert!(!has_template("v2"));
    }

    #[tokio::test]
    async fn insert_gif_round_trips_including_nullable_fields() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        let gif = insert_gif(
            &pool,
            &NewGif {
                id: "g1".to_string(),
                video_id: Some("v1".to_string()),
                name: "My GIF".to_string(),
                caption_text: "hello world".to_string(),
                captions_json: Some("[]".to_string()),
                gif_range_start: Some(1.0),
                gif_range_end: Some(4.0),
                width: Some(480),
                height: Some(270),
                external_url: None,
                user_id: user.clone(),
            },
            "2026-08-22T00:00:01Z",
        )
        .await
        .unwrap();

        assert_eq!(gif.id, "g1");
        assert_eq!(gif.video_id.as_deref(), Some("v1"));
        assert_eq!(gif.name, "My GIF");
        assert_eq!(gif.width, Some(480));
    }

    #[tokio::test]
    async fn insert_gif_allows_null_video_id_and_captions_json_for_imports() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;

        let gif = insert_gif(
            &pool,
            &NewGif {
                id: "imported".to_string(),
                video_id: None,
                name: "imported.gif".to_string(),
                caption_text: String::new(),
                captions_json: None,
                gif_range_start: Some(0.0),
                gif_range_end: Some(0.0),
                width: Some(200),
                height: Some(200),
                external_url: None,
                user_id: user,
            },
            "2026-08-22T00:00:01Z",
        )
        .await
        .unwrap();

        assert!(gif.video_id.is_none());
        assert!(gif.captions_json.is_none());
    }

    #[tokio::test]
    async fn insert_gif_allows_a_linked_gif_with_no_range_or_dimensions() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;

        let gif = insert_gif(
            &pool,
            &NewGif {
                id: "linked".to_string(),
                video_id: None,
                name: "a linked gif".to_string(),
                caption_text: String::new(),
                captions_json: None,
                gif_range_start: None,
                gif_range_end: None,
                width: None,
                height: None,
                external_url: Some("https://example.com/a.gif".to_string()),
                user_id: user,
            },
            "2026-08-22T00:00:01Z",
        )
        .await
        .unwrap();

        assert_eq!(gif.external_url.as_deref(), Some("https://example.com/a.gif"));
        assert!(gif.gif_range_start.is_none());
        assert!(gif.width.is_none());
    }

    fn sample_gif(id: &str, name: &str, caption_text: &str, user_id: &str) -> NewGif {
        NewGif {
            id: id.to_string(),
            video_id: None,
            name: name.to_string(),
            caption_text: caption_text.to_string(),
            captions_json: None,
            gif_range_start: Some(0.0),
            gif_range_end: Some(1.0),
            width: Some(480),
            height: Some(270),
            external_url: None,
            user_id: user_id.to_string(),
        }
    }

    fn sample_template() -> TemplatePayload {
        TemplatePayload {
            captions: vec![],
            gif_range_start: 0.0,
            gif_range_end: 2.0,
            width: 480,
            height: 270,
        }
    }

    #[tokio::test]
    async fn list_gifs_with_no_query_returns_everything_newest_first() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("older", "a", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("newer", "b", "", &user), "2026-08-21T00:00:00Z")
            .await
            .unwrap();

        let gifs = list_gifs(&pool, &user, None).await.unwrap();
        let ids: Vec<&str> = gifs.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["newer", "older"]);
    }

    #[tokio::test]
    async fn list_gifs_only_returns_the_owners_own_gifs() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("mine", "a", "", &owner), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("theirs", "b", "", &other), "2026-08-20T00:00:01Z")
            .await
            .unwrap();

        let gifs = list_gifs(&pool, &owner, None).await.unwrap();
        let ids: Vec<&str> = gifs.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["mine"]);
    }

    #[tokio::test]
    async fn list_gifs_matches_name_or_caption_text() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "Cat jumping", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_gif(
            &pool,
            &sample_gif("g2", "Dog running", "cat sound", &user),
            "2026-08-21T00:00:00Z",
        )
        .await
        .unwrap();
        insert_gif(&pool, &sample_gif("g3", "Bird flying", "", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        let gifs = list_gifs(&pool, &user, Some("cat")).await.unwrap();
        let ids: Vec<&str> = gifs.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["g2", "g1"]); // matched via caption_text and name respectively, newest first
    }

    #[tokio::test]
    async fn list_gifs_treats_a_blank_query_as_no_filter() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "a", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        let gifs = list_gifs(&pool, &user, Some("   ")).await.unwrap();
        assert_eq!(gifs.len(), 1);
    }

    #[tokio::test]
    async fn get_gif_returns_none_for_a_missing_id() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        assert!(get_gif(&pool, "missing", &user).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn get_gif_scoped_to_another_owner_returns_none() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "a", "", &owner), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        assert!(get_gif(&pool, "g1", &other).await.unwrap().is_none());
        assert!(get_gif(&pool, "g1", &owner).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn rename_gif_updates_the_name_and_returns_the_updated_row() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "old name", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        let renamed = rename_gif(&pool, "g1", &user, "new name").await.unwrap().unwrap();
        assert_eq!(renamed.name, "new name");
        assert_eq!(get_gif(&pool, "g1", &user).await.unwrap().unwrap().name, "new name");
    }

    #[tokio::test]
    async fn rename_gif_returns_none_for_a_missing_id() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        assert!(rename_gif(&pool, "missing", &user, "x").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rename_gif_cannot_rename_another_owners_gif() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "old name", "", &owner), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        assert!(rename_gif(&pool, "g1", &other, "hijacked").await.unwrap().is_none());
        assert_eq!(get_gif(&pool, "g1", &owner).await.unwrap().unwrap().name, "old name");
    }

    #[tokio::test]
    async fn new_gifs_default_to_not_one_off() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        let gif = insert_gif(&pool, &sample_gif("g1", "a", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        assert!(!gif.is_one_off);
    }

    #[tokio::test]
    async fn set_gif_one_off_flips_the_flag_and_back() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "a", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        let marked = set_gif_one_off(&pool, "g1", &user, true).await.unwrap().unwrap();
        assert!(marked.is_one_off);
        assert!(get_gif(&pool, "g1", &user).await.unwrap().unwrap().is_one_off);

        let unmarked = set_gif_one_off(&pool, "g1", &user, false).await.unwrap().unwrap();
        assert!(!unmarked.is_one_off);
    }

    #[tokio::test]
    async fn set_gif_public_flips_the_flag_and_back() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "a", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        assert!(!get_gif(&pool, "g1", &user).await.unwrap().unwrap().is_public);

        let shared = set_gif_public(&pool, "g1", &user, true).await.unwrap().unwrap();
        assert!(shared.is_public);
        assert!(get_gif(&pool, "g1", &user).await.unwrap().unwrap().is_public);

        let unshared = set_gif_public(&pool, "g1", &user, false).await.unwrap().unwrap();
        assert!(!unshared.is_public);
    }

    #[tokio::test]
    async fn set_gif_public_cannot_be_toggled_by_another_owner() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "a", "", &owner), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        assert!(set_gif_public(&pool, "g1", &other, true).await.unwrap().is_none());
        assert!(!get_gif(&pool, "g1", &owner).await.unwrap().unwrap().is_public);
    }

    #[tokio::test]
    async fn list_public_gifs_returns_public_gifs_across_users_with_attribution() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        set_handle(&pool, &owner, "owner-handle").await.unwrap();
        insert_gif(&pool, &sample_gif("public", "cat jumping", "", &owner), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("private", "cat sleeping", "", &owner), "2026-08-20T00:00:01Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("someone-elses", "dog running", "", &other), "2026-08-20T00:00:02Z")
            .await
            .unwrap();
        set_gif_public(&pool, "public", &owner, true).await.unwrap();
        set_gif_public(&pool, "someone-elses", &other, true).await.unwrap();

        let all = list_public_gifs(&pool, None, LibrarySort::Newest).await.unwrap();
        let ids: Vec<&str> = all.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["someone-elses", "public"]);
        let public_entry = all.iter().find(|g| g.id == "public").unwrap();
        assert_eq!(public_entry.owner_handle.as_deref(), Some("owner-handle"));

        let filtered = list_public_gifs(&pool, Some("cat"), LibrarySort::Newest).await.unwrap();
        let filtered_ids: Vec<&str> = filtered.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(filtered_ids, vec!["public"]);
    }

    #[tokio::test]
    async fn set_gif_one_off_returns_none_for_a_missing_id() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        assert!(set_gif_one_off(&pool, "missing", &user, true).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_gifs_sorts_one_off_gifs_after_reusable_ones() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        // Newest first within each group, but one-offs always after
        // reusable GIFs regardless of creation time (SPEC.md §8).
        insert_gif(&pool, &sample_gif("old-reusable", "a", "", &user), "2026-08-19T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("new-one-off", "b", "", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("new-reusable", "c", "", &user), "2026-08-21T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("old-one-off", "d", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        set_gif_one_off(&pool, "new-one-off", &user, true).await.unwrap();
        set_gif_one_off(&pool, "old-one-off", &user, true).await.unwrap();

        let gifs = list_gifs(&pool, &user, None).await.unwrap();
        let ids: Vec<&str> = gifs.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["new-reusable", "old-reusable", "new-one-off", "old-one-off"]
        );
    }

    #[tokio::test]
    async fn delete_gif_removes_the_row_and_reports_success() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "a", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        assert!(delete_gif(&pool, "g1", &user).await.unwrap());
        assert!(get_gif(&pool, "g1", &user).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_gif_reports_false_for_a_missing_id() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        assert!(!delete_gif(&pool, "missing", &user).await.unwrap());
    }

    #[tokio::test]
    async fn delete_gif_cannot_delete_another_owners_gif() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "a", "", &owner), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        assert!(!delete_gif(&pool, "g1", &other).await.unwrap());
        assert!(get_gif(&pool, "g1", &owner).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn get_template_returns_none_when_no_template_is_saved() {
        let pool = test_pool().await;
        assert!(get_template(&pool, "v1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn upsert_template_creates_then_overwrites_the_same_row() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        upsert_template(&pool, "t1", "v1", &user, &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();
        let first = get_template(&pool, "v1").await.unwrap().unwrap();
        assert_eq!(first.width, 480);

        let mut overwrite = sample_template();
        overwrite.width = 320;
        upsert_template(&pool, "t1", "v1", &user, &overwrite, "2026-08-22T00:00:02Z")
            .await
            .unwrap();

        let second = get_template(&pool, "v1").await.unwrap().unwrap();
        assert_eq!(second.width, 320);
    }

    /// SPEC-CLOUD.md §4: reusing the existing template's id across an
    /// overwrite (via `get_template_id`) is what lets the route replace a
    /// template's clip/thumbnail files in place instead of orphaning the
    /// previous save's — this is the id-stability guarantee that depends on.
    #[tokio::test]
    async fn get_template_id_stays_stable_across_an_overwrite() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        assert!(get_template_id(&pool, "v1").await.unwrap().is_none());

        upsert_template(&pool, "t1", "v1", &user, &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();
        assert_eq!(get_template_id(&pool, "v1").await.unwrap().as_deref(), Some("t1"));

        upsert_template(&pool, "t1", "v1", &user, &sample_template(), "2026-08-22T00:00:02Z")
            .await
            .unwrap();
        assert_eq!(get_template_id(&pool, "v1").await.unwrap().as_deref(), Some("t1"));
    }

    #[tokio::test]
    async fn delete_template_removes_it_and_reports_success() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        upsert_template(&pool, "t1", "v1", &user, &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();

        assert!(delete_template(&pool, "v1").await.unwrap());
        assert!(get_template(&pool, "v1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_template_reports_false_for_a_missing_video() {
        let pool = test_pool().await;
        assert!(!delete_template(&pool, "missing").await.unwrap());
    }

    #[tokio::test]
    async fn get_template_by_id_returns_the_full_row() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        upsert_template(&pool, "t1", "v1", &user, &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();

        let template = get_template_by_id(&pool, "t1").await.unwrap().unwrap();
        assert_eq!(template.user_id, user);

        assert!(get_template_by_id(&pool, "missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_video_removes_the_row_and_reports_success() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        assert!(delete_video(&pool, "v1", &user).await.unwrap());
        assert!(get_video(&pool, "v1", &user).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_video_reports_false_for_a_missing_id() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        assert!(!delete_video(&pool, "missing", &user).await.unwrap());
    }

    #[tokio::test]
    async fn delete_video_cannot_delete_another_owners_video() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &owner), "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        assert!(!delete_video(&pool, "v1", &other).await.unwrap());
        assert!(get_video(&pool, "v1", &owner).await.unwrap().is_some());
    }

    /// M4: deleting a video no longer needs to be blocked by a saved
    /// template (SPEC-CLOUD.md §6 supersedes SPEC.md §12's guard) — the
    /// template is a self-contained clipped asset (M3) that outlives its
    /// source video, via `templates.video_id`'s `ON DELETE SET NULL`
    /// (migration `0006_template_video_id_nullable.sql`).
    #[tokio::test]
    async fn deleting_a_video_survives_and_nulls_out_its_templates_video_id() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        upsert_template(&pool, "t1", "v1", &user, &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();

        assert!(delete_video(&pool, "v1", &user).await.unwrap());

        // The template row itself survives, payload intact — just no
        // longer pointing at a video that no longer exists.
        let video_id: Option<String> = sqlx::query_scalar("SELECT video_id FROM templates WHERE id = $1")
            .bind("t1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(video_id.is_none());
    }

    #[tokio::test]
    async fn set_handle_succeeds_once_then_fails_even_with_a_different_value() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;

        assert!(set_handle(&pool, &user, "simon").await.unwrap());
        assert!(!set_handle(&pool, &user, "someone-else").await.unwrap());
        assert_eq!(
            get_user(&pool, &user).await.unwrap().unwrap().handle.as_deref(),
            Some("simon")
        );
    }

    #[tokio::test]
    async fn set_handle_fails_when_it_collides_with_another_users_handle() {
        let pool = test_pool().await;
        let first = seed_user(&pool).await;
        let second = seed_user(&pool).await;

        assert!(set_handle(&pool, &first, "taken").await.unwrap());
        assert!(!set_handle(&pool, &second, "taken").await.unwrap());
        assert!(get_user(&pool, &second).await.unwrap().unwrap().handle.is_none());
    }

    #[tokio::test]
    async fn get_user_by_slug_round_trips() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        set_handle(&pool, &user, "simon").await.unwrap();

        let found = get_user_by_slug(&pool, "simon").await.unwrap().unwrap();
        assert_eq!(found.id, user);
        assert!(get_user_by_slug(&pool, "nobody").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn set_handle_preserves_case_and_a_case_variant_still_succeeds_with_a_suffixed_slug() {
        let pool = test_pool().await;
        let first = seed_user(&pool).await;
        let second = seed_user(&pool).await;

        assert!(set_handle(&pool, &first, "Simon").await.unwrap());
        assert_eq!(
            get_user(&pool, &first).await.unwrap().unwrap().handle.as_deref(),
            Some("Simon")
        );
        assert_eq!(get_user(&pool, &first).await.unwrap().unwrap().slug.as_deref(), Some("simon"));

        // "simon" case-folds to the already-taken slug "simon" — rather
        // than being rejected, it succeeds with its own handle preserved
        // exactly and a suffixed slug for disambiguation (migration 0012).
        assert!(set_handle(&pool, &second, "simon").await.unwrap());
        let second_user = get_user(&pool, &second).await.unwrap().unwrap();
        assert_eq!(second_user.handle.as_deref(), Some("simon"));
        assert_eq!(second_user.slug.as_deref(), Some("simon2"));
    }

    #[tokio::test]
    async fn set_handle_keeps_incrementing_the_suffix_across_repeated_slug_collisions() {
        let pool = test_pool().await;
        let first = seed_user(&pool).await;
        let second = seed_user(&pool).await;
        let third = seed_user(&pool).await;

        assert!(set_handle(&pool, &first, "Sim_Mc").await.unwrap());
        assert!(set_handle(&pool, &second, "sim_mc").await.unwrap());
        assert!(set_handle(&pool, &third, "SIM_MC").await.unwrap());

        assert_eq!(get_user(&pool, &first).await.unwrap().unwrap().slug.as_deref(), Some("sim_mc"));
        assert_eq!(get_user(&pool, &second).await.unwrap().unwrap().slug.as_deref(), Some("sim_mc2"));
        assert_eq!(get_user(&pool, &third).await.unwrap().unwrap().slug.as_deref(), Some("sim_mc3"));
    }

    #[tokio::test]
    async fn get_user_by_slug_is_an_exact_match_not_case_insensitive() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        set_handle(&pool, &user, "Simon").await.unwrap();

        // slug is always stored lowercase, so a lowercase lookup finds it...
        assert_eq!(get_user_by_slug(&pool, "simon").await.unwrap().unwrap().id, user);
        // ...but an uppercase lookup does not — the frontend always builds
        // links from the real `slug` the API returns, never guesses one.
        assert!(get_user_by_slug(&pool, "SIMON").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn set_user_disabled_flips_and_persists() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        assert!(!get_user(&pool, &user).await.unwrap().unwrap().disabled);

        let disabled = set_user_disabled(&pool, &user, true).await.unwrap().unwrap();
        assert!(disabled.disabled);
        assert!(get_user(&pool, &user).await.unwrap().unwrap().disabled);

        let enabled = set_user_disabled(&pool, &user, false).await.unwrap().unwrap();
        assert!(!enabled.disabled);

        assert!(set_user_disabled(&pool, "missing", true).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_sessions_for_user_only_removes_that_users_sessions() {
        let pool = test_pool().await;
        let target = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        create_session(&pool, "sess-target", &target, "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        create_session(&pool, "sess-other", &other, "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        delete_sessions_for_user(&pool, &target).await.unwrap();

        assert!(get_session(&pool, "sess-target").await.unwrap().is_none());
        assert!(get_session(&pool, "sess-other").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn admin_list_users_reports_gif_count_and_latest_gif_at() {
        let pool = test_pool().await;
        let active = seed_user(&pool).await;
        let idle = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "a", "", &active), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("g2", "b", "", &active), "2026-08-21T00:00:00Z")
            .await
            .unwrap();

        let users = admin_list_users(&pool).await.unwrap();
        let active_row = users.iter().find(|u| u.id == active).unwrap();
        assert_eq!(active_row.gif_count, 2);
        assert_eq!(active_row.latest_gif_at.as_deref(), Some("2026-08-21T00:00:00Z"));

        let idle_row = users.iter().find(|u| u.id == idle).unwrap();
        assert_eq!(idle_row.gif_count, 0);
        assert!(idle_row.latest_gif_at.is_none());
    }

    #[tokio::test]
    async fn admin_list_gifs_by_user_includes_private_gifs() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("mine", "a", "", &owner), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("theirs", "b", "", &other), "2026-08-20T00:00:01Z")
            .await
            .unwrap();

        let gifs = admin_list_gifs_by_user(&pool, &owner).await.unwrap();
        let ids: Vec<&str> = gifs.iter().map(|g| g.id.as_str()).collect();
        // Private (never made public) but still visible to the admin.
        assert_eq!(ids, vec!["mine"]);
    }

    #[tokio::test]
    async fn admin_gif_functions_ignore_ownership() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "a", "", &owner), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        assert!(admin_get_gif(&pool, "g1").await.unwrap().is_some());

        let unpublished = admin_unpublish_gif(&pool, "g1").await.unwrap().unwrap();
        assert!(!unpublished.is_public);

        assert!(admin_delete_gif(&pool, "g1").await.unwrap());
        assert!(admin_get_gif(&pool, "g1").await.unwrap().is_none());
        assert!(!admin_delete_gif(&pool, "g1").await.unwrap());
    }

    #[tokio::test]
    async fn admin_template_functions_ignore_ownership() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &owner), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        upsert_template(&pool, "t1", "v1", &owner, &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();

        let by_user = admin_list_templates_by_user(&pool, &owner).await.unwrap();
        assert_eq!(by_user.len(), 1);
        assert_eq!(by_user[0].id, "t1");

        assert!(admin_delete_template(&pool, "t1").await.unwrap());
        assert!(get_template_by_id(&pool, "t1").await.unwrap().is_none());
        assert!(!admin_delete_template(&pool, "t1").await.unwrap());
    }

    #[tokio::test]
    async fn increment_gif_use_count_increments_from_zero_repeatedly_with_no_dedup() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("g1", "a", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        assert_eq!(get_gif(&pool, "g1", &user).await.unwrap().unwrap().use_count, 0);

        let once = increment_gif_use_count(&pool, "g1").await.unwrap().unwrap();
        assert_eq!(once.use_count, 1);

        let twice = increment_gif_use_count(&pool, "g1").await.unwrap().unwrap();
        assert_eq!(twice.use_count, 2);
    }

    #[tokio::test]
    async fn increment_gif_use_count_returns_none_for_a_missing_id() {
        let pool = test_pool().await;
        assert!(increment_gif_use_count(&pool, "missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_public_gifs_sorted_most_used_orders_by_use_count_descending() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("low", "a", "", &user), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("high", "b", "", &user), "2026-08-19T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("tied-newer", "c", "", &user), "2026-08-21T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("tied-older", "d", "", &user), "2026-08-18T00:00:00Z")
            .await
            .unwrap();
        for id in ["low", "high", "tied-newer", "tied-older"] {
            set_gif_public(&pool, id, &user, true).await.unwrap();
        }
        increment_gif_use_count(&pool, "low").await.unwrap();
        for _ in 0..3 {
            increment_gif_use_count(&pool, "high").await.unwrap();
        }
        for _ in 0..2 {
            increment_gif_use_count(&pool, "tied-newer").await.unwrap();
            increment_gif_use_count(&pool, "tied-older").await.unwrap();
        }

        let sorted = list_public_gifs(&pool, None, LibrarySort::MostUsed).await.unwrap();
        let ids: Vec<&str> = sorted.iter().map(|g| g.id.as_str()).collect();
        // "high" (3) first, then the tied-at-2 pair broken by recency
        // (newer first), then "low" (1) last.
        assert_eq!(ids, vec!["high", "tied-newer", "tied-older", "low"]);
    }

    #[tokio::test]
    async fn list_public_gifs_by_user_only_returns_that_users_public_gifs() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        let other = seed_user(&pool).await;
        insert_gif(&pool, &sample_gif("public", "a", "", &owner), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("private", "b", "", &owner), "2026-08-20T00:00:01Z")
            .await
            .unwrap();
        insert_gif(
            &pool,
            &sample_gif("someone-elses-public", "c", "", &other),
            "2026-08-20T00:00:02Z",
        )
        .await
        .unwrap();
        sqlx::query("UPDATE gifs SET is_public = true WHERE id = $1")
            .bind("public")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE gifs SET is_public = true WHERE id = $1")
            .bind("someone-elses-public")
            .execute(&pool)
            .await
            .unwrap();

        let gifs = list_public_gifs_by_user(&pool, &owner).await.unwrap();
        let ids: Vec<&str> = gifs.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["public"]);
    }
}
