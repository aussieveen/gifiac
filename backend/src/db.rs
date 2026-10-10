use std::collections::HashSet;

use anyhow::Result;
use sqlx::postgres::{PgPool, PgPoolOptions};
use uuid::Uuid;

use crate::handle;
use crate::models::{
    AdminActionView, AdminUserView, Collection, CollectionWithCount, ExportFormat, ExportJob, Gif, IngestJob,
    LibrarySort, LoginCode, NewGif, NewVideo, PreferencesView, PublicGif, Session, Template, TemplatePayload,
    TemplateSummary, UpdatePreferencesRequest, User, Video, VideoListItem, VideoTemplate,
};

const VIDEO_COLUMNS: &str = "id, original_filename, extension, file_size_bytes, duration_seconds, width, height, uploaded_at";
const GIF_COLUMNS: &str = "id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, external_url, created_at, is_one_off, is_public, use_count, thumbnail_status, template_id";
/// The columns a fresh insert actually supplies — `is_one_off` is
/// deliberately excluded: every newly created GIF (export, import, or
/// link) starts out reusable, relying on the schema's `DEFAULT false`
/// rather than binding it explicitly. `user_id` isn't part of either
/// column list: it's an ownership-scoping parameter on every function
/// here, never part of what's `SELECT`ed back out to a response (SPEC-
/// CLOUD.md §3's ownership model is enforced in the query, not surfaced
/// to the frontend).
const INSERT_GIF_COLUMNS: &str =
    "id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, external_url, created_at, thumbnail_status, template_id, is_public";
const TEMPLATE_COLUMNS: &str = "id, video_id, user_id, name, is_public, payload_json, saved_at";

pub async fn create_pool(database_url: &str) -> Result<PgPool> {
    // sqlx defaults to 10, which queues requests under concurrent load
    // (load-testing showed this as a real, if secondary, bottleneck
    // alongside the unpaginated list endpoints' response size) — 25 is
    // comfortably under Postgres' own default `max_connections` of 100,
    // and this is the only non-trivial consumer on a single-instance
    // deployment (SPEC-CLOUD.md).
    let pool = PgPoolOptions::new().max_connections(25).connect(database_url).await?;
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

/// Unscoped by owner — only for the ingest Lambda's callback handler
/// (`routes::internal::ingest_callback`), which has no user session to
/// scope by at all (Lambda has no `CurrentUser`), only the `video_id`
/// its own `ingest_jobs` row already ties it to.
pub async fn get_video_unscoped(pool: &PgPool, id: &str) -> Result<Option<Video>> {
    let sql = format!("SELECT {VIDEO_COLUMNS} FROM videos WHERE id = $1");
    sqlx::query_as::<_, Video>(sqlx::AssertSqlSafe(sql))
        .bind(id)
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
        "INSERT INTO gifs ({INSERT_GIF_COLUMNS}, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING {GIF_COLUMNS}"
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
        .bind(&gif.template_id)
        .bind(gif.is_public)
        .bind(&gif.user_id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// Every external URL the user has already linked — the Import GIFs
/// modal's "That GIF is already in your library" check against this (not
/// a global check: SPEC.md §13 treats a hotlink as the creator's own
/// entry, so someone else linking the same URL isn't a duplicate for
/// them).
pub async fn list_external_urls_for_user(pool: &PgPool, user_id: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as("SELECT external_url FROM gifs WHERE user_id = $1 AND external_url IS NOT NULL")
        .bind(user_id)
        .fetch_all(pool)
        .await?;
    Ok(rows.into_iter().map(|(url,)| url).collect())
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
/// Page size every paginated list endpoint uses (`list_gifs`,
/// `list_public_gifs`) — `fetch_all` always pulls one extra row beyond
/// this so `paginate` can derive `has_more` without a separate `COUNT(*)`.
pub const PAGE_SIZE: i64 = 24;

/// Splits a `PAGE_SIZE + 1`-row fetch into the page itself plus whether
/// there's a next one, without a second round-trip to count the total.
fn paginate<T>(mut rows: Vec<T>) -> (Vec<T>, bool) {
    let has_more = rows.len() as i64 > PAGE_SIZE;
    rows.truncate(PAGE_SIZE as usize);
    (rows, has_more)
}

pub async fn list_gifs(pool: &PgPool, owner_id: &str, q: Option<&str>, page: u32) -> Result<(Vec<Gif>, bool)> {
    let offset = (page.saturating_sub(1) as i64) * PAGE_SIZE;
    let rows = match q.map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => {
            // `ILIKE`, not `LIKE`: SQLite's `LIKE` is case-insensitive for
            // ASCII by default, Postgres' isn't — `ILIKE` is what
            // reproduces that original case-insensitive search behavior.
            let sql = format!(
                "SELECT {GIF_COLUMNS} FROM gifs WHERE user_id = $1 AND (name ILIKE $2 ESCAPE '\\' OR caption_text ILIKE $3 ESCAPE '\\') ORDER BY is_one_off ASC, created_at DESC LIMIT $4 OFFSET $5"
            );
            let pattern = format!("%{}%", escape_like(q));
            sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
                .bind(owner_id)
                .bind(&pattern)
                .bind(&pattern)
                .bind(PAGE_SIZE + 1)
                .bind(offset)
                .fetch_all(pool)
                .await?
        }
        None => {
            let sql = format!(
                "SELECT {GIF_COLUMNS} FROM gifs WHERE user_id = $1 ORDER BY is_one_off ASC, created_at DESC LIMIT $2 OFFSET $3"
            );
            sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
                .bind(owner_id)
                .bind(PAGE_SIZE + 1)
                .bind(offset)
                .fetch_all(pool)
                .await?
        }
    };
    Ok(paginate(rows))
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

/// Unscoped by owner — only for `export_progress`'s terminal-replay path,
/// which was already unscoped before it (its `CurrentUser` extractor is
/// present but unused, same pre-existing posture this doesn't change):
/// the export id is a random UUID, not guessable, which is the whole
/// endpoint's existing security model.
pub async fn get_gif_unscoped(pool: &PgPool, id: &str) -> Result<Option<Gif>> {
    let sql = format!("SELECT {GIF_COLUMNS} FROM gifs WHERE id = $1");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(id)
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

/// Stamps a gif with the template it's now tied to — used only right after
/// Flow A's "Also save as a template" checkbox (`exports::run_pipeline`)
/// succeeds, so the gif that *produced* the template gets remix lineage to
/// it too, not just later gifs started *from* it (Flow B, which already
/// sets `template_id` at insert time). No ownership check: only called
/// server-side, right after the same request already created both rows.
pub async fn set_gif_template_id(pool: &PgPool, id: &str, template_id: &str) -> Result<()> {
    sqlx::query("UPDATE gifs SET template_id = $1 WHERE id = $2")
        .bind(template_id)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// One-off backfill counterpart to `set_gif_template_id`, for gifs created
/// before it existed: any gif whose video already has a template (saved
/// either before or after that gif was exported — `save_as_template` and
/// the plain "Save template" toggle both upsert onto the same `video_id`)
/// but whose own `template_id` is still unstamped. A gif whose video never
/// got a template stays `NULL`, same as always. Returns the number of gifs
/// updated.
pub async fn backfill_gif_template_lineage(pool: &PgPool) -> Result<u64> {
    let result = sqlx::query(
        "UPDATE gifs SET template_id = templates.id \
         FROM templates \
         WHERE gifs.video_id = templates.video_id AND gifs.template_id IS NULL",
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
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
/// creator survive being re-saved — this is the "in-place overwrite, same
/// id" the public-templates design calls for, so existing `gifs.template_id`
/// lineage and a public template's URL both keep working across a re-save.
#[allow(clippy::too_many_arguments)]
pub async fn upsert_template(
    pool: &PgPool,
    id: &str,
    video_id: &str,
    user_id: &str,
    name: &str,
    is_public: bool,
    payload: &TemplatePayload,
    saved_at: &str,
) -> Result<()> {
    let payload_json = serde_json::to_string(payload)?;
    sqlx::query(
        "INSERT INTO templates (id, video_id, user_id, name, is_public, payload_json, saved_at) VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (video_id) DO UPDATE SET name = excluded.name, is_public = excluded.is_public, \
         payload_json = excluded.payload_json, saved_at = excluded.saved_at",
    )
    .bind(id)
    .bind(video_id)
    .bind(user_id)
    .bind(name)
    .bind(is_public)
    .bind(payload_json)
    .bind(saved_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Returns `true` if a template was actually deleted. Video-id-scoped, for
/// the owner's own video-nested flow A (`DELETE /api/videos/{id}/template`)
/// — see `delete_template_by_id` for the New GIF page's own-id-scoped
/// delete, and `admin_delete_template` for the ownership-agnostic one.
pub async fn delete_template(pool: &PgPool, video_id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM templates WHERE video_id = $1")
        .bind(video_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Deletes a template by its own id, scoped to `owner_id` — the New GIF
/// page's "Delete template" action on one of the caller's own tiles.
/// Distinct from `delete_template` (video-id-scoped, flow A) and
/// `admin_delete_template` (no owner filter).
pub async fn delete_template_by_id(pool: &PgPool, id: &str, owner_id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM templates WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(owner_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// A template's full row, any visibility — used to find the row (to
/// distinguish "doesn't exist" from "not yours") before an owner-only
/// check runs, and by the admin routes.
pub async fn get_template_by_id(pool: &PgPool, id: &str) -> Result<Option<Template>> {
    let sql = format!("SELECT {TEMPLATE_COLUMNS} FROM templates WHERE id = $1");
    sqlx::query_as::<_, Template>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// A template usable by `viewer_id` to start a new GIF from (flow B) —
/// public, or owned by the viewer, the same "public OR owner" gate
/// `get_favouritable_gif` uses for gifs. Every flow-B read goes through
/// this: the New GIF page's detail view, the clip/thumbnail/filmstrip/meta
/// asset routes, and the template-export route — a private template a
/// non-owner doesn't have access to simply doesn't resolve here, the same
/// `NotFound` a nonexistent id gets.
pub async fn get_template_for_use(pool: &PgPool, id: &str, viewer_id: &str) -> Result<Option<Template>> {
    let sql = format!("SELECT {TEMPLATE_COLUMNS} FROM templates WHERE id = $1 AND (is_public = true OR user_id = $2)");
    sqlx::query_as::<_, Template>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(viewer_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Renames a template in place — lightweight, deliberately not routed
/// through `upsert_template`'s clip-regeneration pipeline: the public-
/// templates design wants this instant, with no re-trim/re-save.
pub async fn rename_template(pool: &PgPool, id: &str, owner_id: &str, name: &str) -> Result<Option<Template>> {
    let sql = format!("UPDATE templates SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING {TEMPLATE_COLUMNS}");
    sqlx::query_as::<_, Template>(sqlx::AssertSqlSafe(sql))
        .bind(name)
        .bind(id)
        .bind(owner_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Flips a template's public/private flag — same lightweight shape as
/// `rename_template`.
pub async fn set_template_public(pool: &PgPool, id: &str, owner_id: &str, is_public: bool) -> Result<Option<Template>> {
    let sql = format!("UPDATE templates SET is_public = $1 WHERE id = $2 AND user_id = $3 RETURNING {TEMPLATE_COLUMNS}");
    sqlx::query_as::<_, Template>(sqlx::AssertSqlSafe(sql))
        .bind(is_public)
        .bind(id)
        .bind(owner_id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Builds the "New GIF" page's grid rows from raw `Template` rows —
/// deserializing `payload_json` in Rust (it's opaque JSON text, not
/// `jsonb`, so `duration_seconds`/`caption_count` can't be computed in
/// SQL). `owner_handle` is left to the caller to fill in (only meaningful
/// for "From others", see `get_public_template_summaries`).
fn template_summary_from(t: Template, owner_handle: Option<String>) -> Result<TemplateSummary> {
    let payload: TemplatePayload = serde_json::from_str(&t.payload_json)?;
    let first_caption_text = payload
        .captions
        .first()
        .map(|c| c.text.trim().to_string())
        .filter(|s| !s.is_empty());
    Ok(TemplateSummary {
        id: t.id,
        name: t.name,
        is_public: t.is_public,
        saved_at: t.saved_at,
        duration_seconds: payload.gif_range_end - payload.gif_range_start,
        caption_count: payload.captions.len(),
        first_caption_text,
        owner_handle,
    })
}

/// The New GIF page's "My templates" tab — every template the caller
/// owns, public or private.
pub async fn get_template_summaries_owned(pool: &PgPool, owner_id: &str) -> Result<Vec<TemplateSummary>> {
    let sql = format!("SELECT {TEMPLATE_COLUMNS} FROM templates WHERE user_id = $1 ORDER BY saved_at DESC");
    let rows = sqlx::query_as::<_, Template>(sqlx::AssertSqlSafe(sql))
        .bind(owner_id)
        .fetch_all(pool)
        .await?;
    rows.into_iter().map(|t| template_summary_from(t, None)).collect()
}

/// The New GIF page's "From others" tab — every *other* user's public
/// template, with a plain-text creator handle for attribution (no link,
/// no profile page — the public-templates design deliberately excludes
/// that, unlike gifs' `list_public_gifs`).
pub async fn get_public_template_summaries(pool: &PgPool, exclude_user_id: &str) -> Result<Vec<TemplateSummary>> {
    let columns = "t.id, t.video_id, t.user_id, t.name, t.is_public, t.payload_json, t.saved_at, users.handle AS owner_handle";
    let sql = format!(
        "SELECT {columns} FROM templates t JOIN users ON users.id = t.user_id \
         WHERE t.is_public = true AND t.user_id != $1 ORDER BY t.saved_at DESC"
    );
    #[derive(sqlx::FromRow)]
    struct Row {
        id: String,
        video_id: Option<String>,
        user_id: String,
        name: String,
        is_public: bool,
        payload_json: String,
        saved_at: String,
        owner_handle: Option<String>,
    }
    let rows = sqlx::query_as::<_, Row>(sqlx::AssertSqlSafe(sql))
        .bind(exclude_user_id)
        .fetch_all(pool)
        .await?;
    rows.into_iter()
        .map(|r| {
            let template = Template {
                id: r.id,
                video_id: r.video_id,
                user_id: r.user_id,
                name: r.name,
                is_public: r.is_public,
                payload_json: r.payload_json,
                saved_at: r.saved_at,
            };
            template_summary_from(template, r.owner_handle)
        })
        .collect()
}

/// Whether `template_id` (if any) is remixable by `viewer_id` — public, or
/// owned by them. `None` (no template lineage at all) is always `false`.
/// Single-item counterpart of `remixable_template_ids`, used wherever only
/// one gif's response is being built.
pub async fn is_template_remixable(pool: &PgPool, template_id: Option<&str>, viewer_id: &str) -> Result<bool> {
    let Some(id) = template_id else { return Ok(false) };
    let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM templates WHERE id = $1 AND (is_public = true OR user_id = $2)")
        .bind(id)
        .bind(viewer_id)
        .fetch_optional(pool)
        .await?;
    Ok(exists.is_some())
}

/// Bulk counterpart of `is_template_remixable`, for a list of gifs at
/// once (`list_gifs`, `list_library`, `list_favourites`, a profile page)
/// — one query instead of N. `viewer_id: None` (a logged-out library
/// visitor) only ever matches public templates, since there's no owner to
/// compare against.
pub async fn remixable_template_ids(pool: &PgPool, template_ids: &[String], viewer_id: Option<&str>) -> Result<HashSet<String>> {
    if template_ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<String> = match viewer_id {
        Some(viewer) => {
            sqlx::query_scalar("SELECT id FROM templates WHERE id = ANY($1) AND (is_public = true OR user_id = $2)")
                .bind(template_ids)
                .bind(viewer)
                .fetch_all(pool)
                .await?
        }
        None => {
            sqlx::query_scalar("SELECT id FROM templates WHERE id = ANY($1) AND is_public = true")
                .bind(template_ids)
                .fetch_all(pool)
                .await?
        }
    };
    Ok(rows.into_iter().collect())
}

/// Every template, any owner — used only by the one-off
/// `backfill_template_assets` CLI (SPEC-CLOUD.md §10) to back up whatever
/// was saved before that S3 upload existed.
pub async fn list_all_templates(pool: &PgPool) -> Result<Vec<Template>> {
    let sql = format!("SELECT {TEMPLATE_COLUMNS} FROM templates");
    sqlx::query_as::<_, Template>(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
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

/// SPEC-EMAIL-AUTH.md §4/§5: resolves an email-login account, and lets the
/// Google callback find an existing email-login user to link to. Exact
/// match against the normalized, unique `users.email` column (migration
/// 0017).
pub async fn find_user_by_email(pool: &PgPool, email: &str) -> Result<Option<User>> {
    let sql = format!("SELECT {USER_COLUMNS} FROM users WHERE email = $1");
    sqlx::query_as::<_, User>(sqlx::AssertSqlSafe(sql))
        .bind(email)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// SPEC-EMAIL-AUTH.md §4 step 6 / §5: attaches a new provider identity to
/// an *existing* user — an email-login user's first Google sign-in, or a
/// Google user's first email sign-in, both resolve to the same account
/// rather than creating a second one.
pub async fn add_identity(pool: &PgPool, provider: &str, provider_user_id: &str, user_id: &str) -> Result<()> {
    sqlx::query("INSERT INTO identities (provider, provider_user_id, user_id) VALUES ($1, $2, $3)")
        .bind(provider)
        .bind(provider_user_id)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
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

/// `video_assets`/`template_ids` are what existed for the deleted user,
/// handed back so the caller can run best-effort storage cleanup for them
/// *after* this commits — see `admin_delete_user`'s doc comment for why
/// gif media itself is excluded from that cleanup.
pub struct AdminUserDeletion {
    pub video_assets: Vec<(Uuid, String)>,
    pub template_ids: Vec<Uuid>,
}

/// Admin-only, irreversible: cascades a full delete of everything `target`
/// owns. SPEC-CLOUD.md §11 called account deletion out of scope entirely —
/// it no longer is. Every DB row goes in one transaction, including the
/// `admin_actions` audit row (migration `0020_admin_actions.sql`): this is
/// the single most destructive admin action and previously left zero
/// trace. Gif/mp4/webm objects in R2 are deliberately *not* touched here
/// (unlike `admin_delete_gif`) so existing shared/embedded links to a
/// deleted user's public gifs keep resolving after the account is gone;
/// template and video assets ARE cleaned up by the caller using the ids
/// this returns, since nothing external links to those directly.
pub async fn admin_delete_user(pool: &PgPool, target: &User, admin_id: &str, now: &str) -> Result<AdminUserDeletion> {
    let mut tx = pool.begin().await?;

    let videos: Vec<(String, String)> = sqlx::query_as("SELECT id, extension FROM videos WHERE user_id = $1")
        .bind(&target.id)
        .fetch_all(&mut *tx)
        .await?;
    let template_ids: Vec<String> = sqlx::query_scalar("SELECT id FROM templates WHERE user_id = $1")
        .bind(&target.id)
        .fetch_all(&mut *tx)
        .await?;
    let gif_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gifs WHERE user_id = $1")
        .bind(&target.id)
        .fetch_one(&mut *tx)
        .await?;

    sqlx::query("DELETE FROM gifs WHERE user_id = $1")
        .bind(&target.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM templates WHERE user_id = $1")
        .bind(&target.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM videos WHERE user_id = $1")
        .bind(&target.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(&target.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM identities WHERE user_id = $1")
        .bind(&target.id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(&target.id)
        .execute(&mut *tx)
        .await?;

    let details = serde_json::to_string(&serde_json::json!({
        "handle": target.handle,
        "email": target.email,
        "role": target.role,
        "gif_count": gif_count,
        "template_count": template_ids.len(),
        "video_count": videos.len(),
    }))?;
    sqlx::query(
        "INSERT INTO admin_actions (id, admin_user_id, action_type, target_id, details, created_at) \
         VALUES ($1, $2, 'delete_user', $3, $4, $5)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(admin_id)
    .bind(&target.id)
    .bind(&details)
    .bind(now)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(AdminUserDeletion {
        video_assets: videos
            .into_iter()
            .filter_map(|(id, ext)| Uuid::parse_str(&id).ok().map(|uuid| (uuid, ext)))
            .collect(),
        template_ids: template_ids.into_iter().filter_map(|id| Uuid::parse_str(&id).ok()).collect(),
    })
}

/// `GET /api/admin/actions` — most recent N audit entries, newest first.
pub async fn list_admin_actions(pool: &PgPool, limit: i64) -> Result<Vec<AdminActionView>> {
    sqlx::query_as::<_, AdminActionView>(
        "SELECT id, admin_user_id, action_type, target_id, details, created_at \
         FROM admin_actions ORDER BY created_at DESC LIMIT $1",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
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
pub async fn list_public_gifs(pool: &PgPool, q: Option<&str>, sort: LibrarySort, page: u32) -> Result<(Vec<PublicGif>, bool)> {
    let columns = "gifs.id, gifs.video_id, gifs.name, gifs.caption_text, gifs.captions_json, \
         gifs.gif_range_start, gifs.gif_range_end, gifs.width, gifs.height, gifs.external_url, \
         gifs.created_at, gifs.is_one_off, gifs.is_public, gifs.use_count, gifs.thumbnail_status, gifs.template_id, \
         users.handle AS owner_handle, users.slug AS owner_slug";
    let order_by = match sort {
        LibrarySort::Newest => "gifs.created_at DESC",
        LibrarySort::MostUsed => "gifs.use_count DESC, gifs.created_at DESC",
    };
    let offset = (page.saturating_sub(1) as i64) * PAGE_SIZE;
    let rows = match q.map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => {
            let sql = format!(
                "SELECT {columns} FROM gifs JOIN users ON users.id = gifs.user_id \
                 WHERE gifs.is_public = true AND (gifs.name ILIKE $1 ESCAPE '\\' OR gifs.caption_text ILIKE $2 ESCAPE '\\') \
                 ORDER BY {order_by} LIMIT $3 OFFSET $4"
            );
            let pattern = format!("%{}%", escape_like(q));
            sqlx::query_as::<_, PublicGif>(sqlx::AssertSqlSafe(sql))
                .bind(&pattern)
                .bind(&pattern)
                .bind(PAGE_SIZE + 1)
                .bind(offset)
                .fetch_all(pool)
                .await?
        }
        None => {
            let sql = format!(
                "SELECT {columns} FROM gifs JOIN users ON users.id = gifs.user_id \
                 WHERE gifs.is_public = true ORDER BY {order_by} LIMIT $1 OFFSET $2"
            );
            sqlx::query_as::<_, PublicGif>(sqlx::AssertSqlSafe(sql))
                .bind(PAGE_SIZE + 1)
                .bind(offset)
                .fetch_all(pool)
                .await?
        }
    };
    Ok(paginate(rows))
}

pub async fn is_favourited(pool: &PgPool, user_id: &str, gif_id: &str) -> Result<bool> {
    let exists: Option<i32> = sqlx::query_scalar(
        "SELECT 1 FROM collection_gifs cg JOIN collections c ON c.id = cg.collection_id \
         WHERE c.owner_id = $1 AND c.kind = 'favourites' AND cg.gif_id = $2",
    )
    .bind(user_id)
    .bind(gif_id)
    .fetch_optional(pool)
    .await?;
    Ok(exists.is_some())
}

pub async fn list_favourite_gif_ids(pool: &PgPool, user_id: &str) -> Result<HashSet<String>> {
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT cg.gif_id FROM collection_gifs cg JOIN collections c ON c.id = cg.collection_id \
         WHERE c.owner_id = $1 AND c.kind = 'favourites'",
    )
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
/// original `added_at` untouched rather than bumping it back to the top
/// of Saved. Lazily creates the caller's Favourites collection on first
/// use (collections-design/COLLECTIONS.md §1: "created on demand or by
/// migration").
pub async fn add_favourite(pool: &PgPool, user_id: &str, gif_id: &str, created_at: &str) -> Result<()> {
    let favourites = get_or_create_favourites_collection(pool, user_id, created_at).await?;
    sqlx::query(
        "INSERT INTO collection_gifs (collection_id, gif_id, added_at) VALUES ($1, $2, $3) \
         ON CONFLICT (collection_id, gif_id) DO NOTHING",
    )
    .bind(&favourites.id)
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
    sqlx::query(
        "DELETE FROM collection_gifs cg USING collections c \
         WHERE cg.collection_id = c.id AND c.owner_id = $1 AND c.kind = 'favourites' AND cg.gif_id = $2",
    )
    .bind(user_id)
    .bind(gif_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// The caller's saved gifs (SPEC-CLOUD.md §14, `GET /api/favourites`),
/// newest-favourited first — ordered by `collection_gifs.added_at`, not
/// the gif's own, so re-favouriting an old gif bumps it back to the top.
/// Filtered to gifs still visible to the viewer (public, or owned by
/// them): un-publishing a gif doesn't delete its membership row, so this
/// filter is what makes it disappear from Saved and reappear if it's
/// re-published later.
pub async fn list_favourite_gifs(pool: &PgPool, user_id: &str) -> Result<Vec<PublicGif>> {
    let sql = "SELECT gifs.id, gifs.video_id, gifs.name, gifs.caption_text, gifs.captions_json, \
         gifs.gif_range_start, gifs.gif_range_end, gifs.width, gifs.height, gifs.external_url, \
         gifs.created_at, gifs.is_one_off, gifs.is_public, gifs.use_count, gifs.thumbnail_status, gifs.template_id, \
         users.handle AS owner_handle, users.slug AS owner_slug \
         FROM collection_gifs cg \
         JOIN collections c ON c.id = cg.collection_id \
         JOIN gifs ON gifs.id = cg.gif_id \
         JOIN users ON users.id = gifs.user_id \
         WHERE c.owner_id = $1 AND c.kind = 'favourites' AND (gifs.is_public = true OR gifs.user_id = $1) \
         ORDER BY cg.added_at DESC";
    sqlx::query_as::<_, PublicGif>(sql)
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// Returns the caller's Favourites collection, creating it on first use.
/// The `ON CONFLICT ... DO UPDATE` is a no-op write (sets `owner_id` to
/// itself) purely so `RETURNING` still works if a concurrent call created
/// it first — a plain `INSERT ... ON CONFLICT DO NOTHING` would return no
/// row in that race.
pub async fn get_or_create_favourites_collection(pool: &PgPool, owner_id: &str, now: &str) -> Result<Collection> {
    if let Some(existing) = sqlx::query_as::<_, Collection>(
        "SELECT id, owner_id, name, kind, created_at, updated_at FROM collections \
         WHERE owner_id = $1 AND kind = 'favourites'",
    )
    .bind(owner_id)
    .fetch_optional(pool)
    .await?
    {
        return Ok(existing);
    }
    sqlx::query_as::<_, Collection>(
        "INSERT INTO collections (id, owner_id, name, kind, created_at, updated_at) \
         VALUES ($1, $2, 'Favourites', 'favourites', $3, $3) \
         ON CONFLICT (owner_id, lower(name)) DO UPDATE SET owner_id = collections.owner_id \
         RETURNING id, owner_id, name, kind, created_at, updated_at",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(owner_id)
    .bind(now)
    .fetch_one(pool)
    .await
    .map_err(Into::into)
}

/// `GET /api/collections` (collections-design/COLLECTIONS.md §2): every
/// collection the caller owns, Favourites first then custom collections
/// alphabetically (case-insensitive), each with a count of its
/// currently-visible gifs — a member gif made private (or deleted) by
/// someone else drops out of the count without touching the membership
/// row, same visibility-at-read-time rule as Favourites always used.
pub async fn list_collections(pool: &PgPool, owner_id: &str) -> Result<Vec<CollectionWithCount>> {
    sqlx::query_as::<_, CollectionWithCount>(
        "SELECT c.id, c.owner_id, c.name, c.kind, c.created_at, c.updated_at, \
             COUNT(cg.gif_id) FILTER (WHERE g.is_public = true OR g.user_id = c.owner_id) AS gif_count \
         FROM collections c \
         LEFT JOIN collection_gifs cg ON cg.collection_id = c.id \
         LEFT JOIN gifs g ON g.id = cg.gif_id \
         WHERE c.owner_id = $1 \
         GROUP BY c.id \
         ORDER BY (c.kind = 'favourites') DESC, lower(c.name) ASC",
    )
    .bind(owner_id)
    .fetch_all(pool)
    .await
    .map_err(Into::into)
}

/// Ownership-scoped lookup, the same "invisible to anyone but the owner"
/// treatment every other owned resource in this app gets — a collection
/// that doesn't exist and one that exists but belongs to someone else
/// both read as `None`.
pub async fn get_collection(pool: &PgPool, id: &str, owner_id: &str) -> Result<Option<Collection>> {
    sqlx::query_as::<_, Collection>(
        "SELECT id, owner_id, name, kind, created_at, updated_at FROM collections WHERE id = $1 AND owner_id = $2",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(pool)
    .await
    .map_err(Into::into)
}

/// `POST /api/collections` — `Ok(None)` means the name collided with an
/// existing collection (case-insensitively), including "Favourites"
/// itself once that row exists for this user; the route layer turns that
/// into a 409 with the exact wording collections-design/COLLECTIONS.md §4
/// specifies. Reserved-name rejection ("'Favourites' is reserved" for a
/// user with no Favourites collection yet) is a pre-check at the route
/// layer instead, since it can't rely on the DB constraint existing yet.
pub async fn create_collection(pool: &PgPool, owner_id: &str, name: &str, now: &str) -> Result<Option<Collection>> {
    let result = sqlx::query_as::<_, Collection>(
        "INSERT INTO collections (id, owner_id, name, kind, created_at, updated_at) \
         VALUES ($1, $2, $3, 'custom', $4, $4) \
         RETURNING id, owner_id, name, kind, created_at, updated_at",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(owner_id)
    .bind(name)
    .bind(now)
    .fetch_one(pool)
    .await;
    match result {
        Ok(collection) => Ok(Some(collection)),
        Err(sqlx::Error::Database(db_err)) if db_err.constraint() == Some("idx_collections_owner_name") => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// `PATCH /api/collections/{id}` — caller must already have confirmed via
/// `get_collection` that this isn't the Favourites collection; this just
/// handles the name-uniqueness race the same way `create_collection` does.
pub async fn rename_collection(pool: &PgPool, id: &str, owner_id: &str, name: &str, now: &str) -> Result<Option<Collection>> {
    let result = sqlx::query_as::<_, Collection>(
        "UPDATE collections SET name = $1, updated_at = $2 WHERE id = $3 AND owner_id = $4 \
         RETURNING id, owner_id, name, kind, created_at, updated_at",
    )
    .bind(name)
    .bind(now)
    .bind(id)
    .bind(owner_id)
    .fetch_optional(pool)
    .await;
    match result {
        Ok(collection) => Ok(collection),
        Err(sqlx::Error::Database(db_err)) if db_err.constraint() == Some("idx_collections_owner_name") => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// `DELETE /api/collections/{id}` — cascades away its `collection_gifs`
/// rows only (`ON DELETE CASCADE`); the gifs themselves are never touched.
/// `false` means no such collection owned by this caller (404) — the
/// Favourites-can't-be-deleted rule is enforced by the route layer via
/// `get_collection`, same as rename.
pub async fn delete_collection(pool: &PgPool, id: &str, owner_id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM collections WHERE id = $1 AND owner_id = $2")
        .bind(id)
        .bind(owner_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// `POST /api/collections/{id}/gifs` — idempotent. The caller must own
/// `collection_id` (checked by the route layer via `get_collection`); the
/// gif's own visibility is re-checked here via `get_favouritable_gif`'s
/// rule (own, or public) — the same eligibility Favourites has always
/// enforced, now shared by every collection.
pub async fn add_gif_to_collection(pool: &PgPool, collection_id: &str, gif_id: &str, added_at: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO collection_gifs (collection_id, gif_id, added_at) VALUES ($1, $2, $3) \
         ON CONFLICT (collection_id, gif_id) DO NOTHING",
    )
    .bind(collection_id)
    .bind(gif_id)
    .bind(added_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// `DELETE /api/collections/{id}/gifs/{gifId}` — idempotent, no
/// visibility check: removing a gif you can no longer see from your own
/// collection is still always allowed.
pub async fn remove_gif_from_collection(pool: &PgPool, collection_id: &str, gif_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM collection_gifs WHERE collection_id = $1 AND gif_id = $2")
        .bind(collection_id)
        .bind(gif_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// `GET /api/collections/{id}/gifs` — same visibility-at-read-time rule
/// and attributed shape as `list_favourite_gifs`, scoped to one
/// collection instead of the fixed `kind = 'favourites'` one, with the
/// same `q` search `list_gifs`/`list_library` already support.
pub async fn list_collection_gifs(pool: &PgPool, collection_id: &str, owner_id: &str, q: Option<&str>) -> Result<Vec<PublicGif>> {
    const BASE: &str = "SELECT gifs.id, gifs.video_id, gifs.name, gifs.caption_text, gifs.captions_json, \
         gifs.gif_range_start, gifs.gif_range_end, gifs.width, gifs.height, gifs.external_url, \
         gifs.created_at, gifs.is_one_off, gifs.is_public, gifs.use_count, gifs.thumbnail_status, gifs.template_id, \
         users.handle AS owner_handle, users.slug AS owner_slug \
         FROM collection_gifs cg \
         JOIN gifs ON gifs.id = cg.gif_id \
         JOIN users ON users.id = gifs.user_id \
         WHERE cg.collection_id = $1 AND (gifs.is_public = true OR gifs.user_id = $2)";

    match q.map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => {
            let sql = format!("{BASE} AND (gifs.name ILIKE $3 ESCAPE '\\' OR gifs.caption_text ILIKE $3 ESCAPE '\\') ORDER BY cg.added_at DESC");
            let pattern = format!("%{}%", escape_like(q));
            sqlx::query_as::<_, PublicGif>(sqlx::AssertSqlSafe(sql))
                .bind(collection_id)
                .bind(owner_id)
                .bind(pattern)
                .fetch_all(pool)
                .await
                .map_err(Into::into)
        }
        None => {
            let sql = format!("{BASE} ORDER BY cg.added_at DESC");
            sqlx::query_as::<_, PublicGif>(sqlx::AssertSqlSafe(sql))
                .bind(collection_id)
                .bind(owner_id)
                .fetch_all(pool)
                .await
                .map_err(Into::into)
        }
    }
}

/// For a gif's detail panel "In collections" chips — every collection the
/// *viewer* owns that this gif belongs to (collections are private, so
/// this never reveals anyone else's organization of the same gif).
pub async fn collection_ids_for_gif(pool: &PgPool, owner_id: &str, gif_id: &str) -> Result<Vec<String>> {
    sqlx::query_scalar(
        "SELECT cg.collection_id FROM collection_gifs cg JOIN collections c ON c.id = cg.collection_id \
         WHERE c.owner_id = $1 AND cg.gif_id = $2",
    )
    .bind(owner_id)
    .bind(gif_id)
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

/// `CurrentUser`'s row shape: a joined `User` plus the session's
/// `last_active_at` — one query instead of `get_session` followed by a
/// separate `get_user`, since every authenticated request paid for both
/// round trips before even reaching its own handler logic.
#[derive(sqlx::FromRow)]
struct SessionUserRow {
    #[sqlx(flatten)]
    user: User,
    last_active_at: String,
}

pub async fn get_session_user(pool: &PgPool, session_id: &str) -> Result<Option<(User, String)>> {
    let row: Option<SessionUserRow> = sqlx::query_as(
        "SELECT u.id, u.handle, u.slug, u.role, u.created_at, u.email, u.avatar_url, u.display_name, u.disabled, \
                s.last_active_at \
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| (r.user, r.last_active_at)))
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

// --- Email login codes (SPEC-EMAIL-AUTH.md §2) ---

const LOGIN_CODE_COLUMNS: &str = "id, email, code_hash, attempts, request_ip, created_at, expires_at, consumed_at";

#[allow(clippy::too_many_arguments)]
pub async fn insert_login_code(
    pool: &PgPool,
    id: &str,
    email: &str,
    code_hash: &str,
    request_ip: &str,
    created_at: &str,
    expires_at: &str,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO login_codes (id, email, code_hash, attempts, request_ip, created_at, expires_at) \
         VALUES ($1, $2, $3, 0, $4, $5, $6)",
    )
    .bind(id)
    .bind(email)
    .bind(code_hash)
    .bind(request_ip)
    .bind(created_at)
    .bind(expires_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// `/start` step 4: marks every outstanding (unconsumed, unexpired) code
/// for this email consumed before issuing a new one, so only the
/// most-recently-sent code is ever valid.
pub async fn invalidate_outstanding_login_codes(pool: &PgPool, email: &str, now: &str) -> Result<()> {
    sqlx::query("UPDATE login_codes SET consumed_at = $2 WHERE email = $1 AND consumed_at IS NULL AND expires_at > $2")
        .bind(email)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn count_login_codes_for_email_since(pool: &PgPool, email: &str, since: &str) -> Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM login_codes WHERE email = $1 AND created_at > $2")
        .bind(email)
        .bind(since)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn count_login_codes_for_ip_since(pool: &PgPool, request_ip: &str, since: &str) -> Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM login_codes WHERE request_ip = $1 AND created_at > $2")
        .bind(request_ip)
        .bind(since)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// The resend-cooldown check (SPEC-EMAIL-AUTH.md §6: 1 per 60s per email)
/// needs the exact timestamp of the most recent code, not just a count —
/// so it can report how many seconds are left rather than a flat retry.
pub async fn latest_login_code_for_email(pool: &PgPool, email: &str) -> Result<Option<LoginCode>> {
    let sql = format!("SELECT {LOGIN_CODE_COLUMNS} FROM login_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1");
    sqlx::query_as::<_, LoginCode>(sqlx::AssertSqlSafe(sql))
        .bind(email)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

pub async fn get_login_code(pool: &PgPool, id: &str) -> Result<Option<LoginCode>> {
    let sql = format!("SELECT {LOGIN_CODE_COLUMNS} FROM login_codes WHERE id = $1");
    sqlx::query_as::<_, LoginCode>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// `/verify` steps 2+3 combined into one atomic statement (SPEC-EMAIL-
/// AUTH.md §4: "in the same statement as the check, to avoid races") — a
/// `login_codes` row exists, matches `email`, isn't consumed, and isn't
/// expired, and its `attempts` counter is bumped in the same write. `None`
/// covers every "this attempt is invalid" case at once: missing row,
/// wrong email, already consumed, or expired — all rendered identically
/// (`invalid_or_expired`) by the caller regardless of which one it was.
pub async fn increment_login_code_attempts(pool: &PgPool, id: &str, email: &str, now: &str) -> Result<Option<LoginCode>> {
    let sql = format!(
        "UPDATE login_codes SET attempts = attempts + 1 \
         WHERE id = $1 AND email = $2 AND consumed_at IS NULL AND expires_at > $3 \
         RETURNING {LOGIN_CODE_COLUMNS}"
    );
    sqlx::query_as::<_, LoginCode>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(email)
        .bind(now)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// `/verify` step 5 (and the too-many-attempts lockout): atomically
/// consumes the code, returning `false` if it was already consumed by a
/// concurrent request — the caller treats that race as `invalid_or_expired`
/// too.
pub async fn consume_login_code(pool: &PgPool, id: &str, now: &str) -> Result<bool> {
    let result = sqlx::query("UPDATE login_codes SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL")
        .bind(id)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// The hourly cleanup interval task's one query (SPEC-EMAIL-AUTH.md §8) —
/// rows must survive at least an hour for the rolling rate limits above to
/// work, so this only ever removes rows old enough that no rate-limit
/// window could still be counting them.
pub async fn delete_expired_login_codes(pool: &PgPool, older_than: &str) -> Result<u64> {
    let result = sqlx::query("DELETE FROM login_codes WHERE created_at < $1")
        .bind(older_than)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

// --- Ingest/export jobs (wayfinder gifiac#32) ---

const INGEST_JOB_COLUMNS: &str = "id, video_id, stage, error, created_at, updated_at";
const INGEST_JOB_TERMINAL_STAGES: &str = "'complete', 'failed', 'timed_out'";

pub async fn insert_ingest_job(pool: &PgPool, id: &str, video_id: &str, now: &str) -> Result<IngestJob> {
    let sql = format!(
        "INSERT INTO ingest_jobs (id, video_id, stage, created_at, updated_at) \
         VALUES ($1, $2, 'uploading', $3, $3) \
         RETURNING {INGEST_JOB_COLUMNS}"
    );
    sqlx::query_as::<_, IngestJob>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(video_id)
        .bind(now)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn get_ingest_job(pool: &PgPool, id: &str) -> Result<Option<IngestJob>> {
    let sql = format!("SELECT {INGEST_JOB_COLUMNS} FROM ingest_jobs WHERE id = $1");
    sqlx::query_as::<_, IngestJob>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Moves `stage` forward only if the row isn't already terminal — the
/// "a late Lambda callback after the sweep marked a job `timed_out` gets
/// dropped" rule (gifiac#43) lives here once, not duplicated at every call
/// site. Returns `false` if the id doesn't exist OR the row is already
/// terminal; the caller distinguishes those via a prior `get_ingest_job`
/// read when it needs to log which.
pub async fn update_ingest_stage(pool: &PgPool, id: &str, stage: &str, error: Option<&str>, now: &str) -> Result<bool> {
    let sql = format!(
        "UPDATE ingest_jobs SET stage = $2, error = $3, updated_at = $4 \
         WHERE id = $1 AND stage NOT IN ({INGEST_JOB_TERMINAL_STAGES})"
    );
    let result = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(stage)
        .bind(error)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Backfills probe results once the ingest Lambda's callback reports them
/// — `videos.duration_seconds`/`width`/`height` are nullable precisely so
/// this can happen after the row already exists (piece 3 inserts it with
/// NULLs at upload time).
pub async fn fill_in_video_probe(pool: &PgPool, video_id: &str, duration_seconds: f64, width: i64, height: i64) -> Result<()> {
    sqlx::query("UPDATE videos SET duration_seconds = $2, width = $3, height = $4 WHERE id = $1")
        .bind(video_id)
        .bind(duration_seconds)
        .bind(width)
        .bind(height)
        .execute(pool)
        .await?;
    Ok(())
}

/// The stuck-job sweep's (gifiac#43) one query: non-terminal rows whose
/// last update is older than that job type's Lambda timeout + grace
/// buffer.
pub async fn find_stale_ingest_jobs(pool: &PgPool, older_than: &str) -> Result<Vec<IngestJob>> {
    let sql = format!(
        "SELECT {INGEST_JOB_COLUMNS} FROM ingest_jobs \
         WHERE stage NOT IN ({INGEST_JOB_TERMINAL_STAGES}) AND updated_at < $1"
    );
    sqlx::query_as::<_, IngestJob>(sqlx::AssertSqlSafe(sql))
        .bind(older_than)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn mark_ingest_job_timed_out(pool: &PgPool, id: &str, now: &str) -> Result<bool> {
    update_ingest_stage(pool, id, "timed_out", None, now).await
}

const EXPORT_JOB_COLUMNS: &str = "id, request_json, gif_status, gif_percent, gif_error, mp4_status, mp4_percent, mp4_error, webm_status, webm_percent, webm_error, gif_width, gif_height, created_at, updated_at";
const EXPORT_JOB_TERMINAL_STATUSES: &str = "'done', 'failed', 'timed_out'";

pub async fn insert_export_job(pool: &PgPool, id: &str, request_json: &str, now: &str) -> Result<ExportJob> {
    let sql = format!(
        "INSERT INTO export_jobs (id, request_json, created_at, updated_at) \
         VALUES ($1, $2, $3, $3) \
         RETURNING {EXPORT_JOB_COLUMNS}"
    );
    sqlx::query_as::<_, ExportJob>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(request_json)
        .bind(now)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn get_export_job(pool: &PgPool, id: &str) -> Result<Option<ExportJob>> {
    let sql = format!("SELECT {EXPORT_JOB_COLUMNS} FROM export_jobs WHERE id = $1");
    sqlx::query_as::<_, ExportJob>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Same terminal-lock semantics as `update_ingest_stage`, generalized
/// over `ExportFormat`'s 3 column triples.
pub async fn update_export_format_status(
    pool: &PgPool,
    id: &str,
    format: ExportFormat,
    status: &str,
    percent: i32,
    error: Option<&str>,
    now: &str,
) -> Result<bool> {
    let (status_col, percent_col, error_col) = match format {
        ExportFormat::Gif => ("gif_status", "gif_percent", "gif_error"),
        ExportFormat::Mp4 => ("mp4_status", "mp4_percent", "mp4_error"),
        ExportFormat::Webm => ("webm_status", "webm_percent", "webm_error"),
    };
    // The export Lambda posts one callback per ffmpeg progress tick,
    // each fire-and-forget on its own spawned task (`export_lambda.rs`'s
    // `report_progress`) — ffmpeg emits them in order, but nothing
    // guarantees the resulting HTTP requests *arrive* in that order.
    // Without the `$3 >= {percent_col}` guard, a late-arriving tick for
    // an earlier (lower) percent can overwrite a higher one already
    // stored, and that regression gets broadcast straight to the SSE
    // stream — the exact bug this fixes: the frontend's percent
    // appearing to flicker backward before climbing again. Only guards
    // a `running` update against a `running` row; a terminal status
    // (done/failed) always applies regardless of percent, same as
    // before.
    let sql = format!(
        "UPDATE export_jobs SET {status_col} = $2, {percent_col} = $3, {error_col} = $4, updated_at = $5 \
         WHERE id = $1 AND {status_col} NOT IN ({EXPORT_JOB_TERMINAL_STATUSES}) \
           AND ($2 != 'running' OR $3 >= {percent_col})"
    );
    let result = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(status)
        .bind(percent)
        .bind(error)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Persists the gif format's probed output dimensions, reported by the
/// export Lambda's "done" callback — see `ExportJob::gif_width`'s doc
/// comment for why these need to survive on the row rather than being a
/// local variable at the point the callback arrives.
pub async fn set_export_job_gif_dimensions(pool: &PgPool, id: &str, width: i64, height: i64) -> Result<()> {
    sqlx::query("UPDATE export_jobs SET gif_width = $2, gif_height = $3 WHERE id = $1")
        .bind(id)
        .bind(width)
        .bind(height)
        .execute(pool)
        .await?;
    Ok(())
}

/// The stuck-job sweep's export-side query: a job is non-terminal (and
/// thus a sweep candidate) as long as at least one of its 3 formats
/// hasn't reached a terminal status.
pub async fn find_stale_export_jobs(pool: &PgPool, older_than: &str) -> Result<Vec<ExportJob>> {
    let sql = format!(
        "SELECT {EXPORT_JOB_COLUMNS} FROM export_jobs \
         WHERE updated_at < $1 \
           AND (gif_status NOT IN ({EXPORT_JOB_TERMINAL_STATUSES}) \
            OR mp4_status NOT IN ({EXPORT_JOB_TERMINAL_STATUSES}) \
            OR webm_status NOT IN ({EXPORT_JOB_TERMINAL_STATUSES}))"
    );
    sqlx::query_as::<_, ExportJob>(sqlx::AssertSqlSafe(sql))
        .bind(older_than)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

/// Marks every still-non-terminal format `timed_out` in one statement —
/// the whole job is being abandoned, not one format in isolation.
pub async fn mark_export_job_timed_out(pool: &PgPool, id: &str, now: &str) -> Result<bool> {
    let sql = format!(
        "UPDATE export_jobs SET \
           gif_status = CASE WHEN gif_status NOT IN ({EXPORT_JOB_TERMINAL_STATUSES}) THEN 'timed_out' ELSE gif_status END, \
           mp4_status = CASE WHEN mp4_status NOT IN ({EXPORT_JOB_TERMINAL_STATUSES}) THEN 'timed_out' ELSE mp4_status END, \
           webm_status = CASE WHEN webm_status NOT IN ({EXPORT_JOB_TERMINAL_STATUSES}) THEN 'timed_out' ELSE webm_status END, \
           updated_at = $2 \
         WHERE id = $1"
    );
    let result = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .bind(now)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
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
            duration_seconds: Some(12.5),
            width: Some(1920),
            height: Some(1080),
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
        assert_eq!(inserted.width, Some(1920));

        let fetched = get_video(&pool, "v1", &user).await.unwrap().unwrap();
        assert_eq!(fetched.id, inserted.id);
        assert_eq!(fetched.duration_seconds, Some(12.5));
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
        upsert_template(&pool, "t1", "v1", &user, "Template", false, &sample_template(), "2026-08-22T00:00:02Z")
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
                is_public: false,
                user_id: user.clone(),
                template_id: None,
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
                is_public: false,
                user_id: user,
                template_id: None,
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
                is_public: false,
                user_id: user,
                template_id: None,
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
            is_public: false,
            user_id: user_id.to_string(),
            template_id: None,
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

        let (gifs, has_more) = list_gifs(&pool, &user, None, 1).await.unwrap();
        let ids: Vec<&str> = gifs.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["newer", "older"]);
        assert!(!has_more);
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

        let (gifs, _has_more) = list_gifs(&pool, &owner, None, 1).await.unwrap();
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

        let (gifs, _has_more) = list_gifs(&pool, &user, Some("cat"), 1).await.unwrap();
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

        let (gifs, _has_more) = list_gifs(&pool, &user, Some("   "), 1).await.unwrap();
        assert_eq!(gifs.len(), 1);
    }

    #[tokio::test]
    async fn list_gifs_paginates_at_page_size_with_no_overlap_or_gaps() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        for i in 0..30 {
            let id = format!("g{i:02}");
            let created_at = format!("2026-08-{:02}T00:00:00Z", i + 1);
            insert_gif(&pool, &sample_gif(&id, "a", "", &user), &created_at)
                .await
                .unwrap();
        }

        let (page1, has_more1) = list_gifs(&pool, &user, None, 1).await.unwrap();
        assert_eq!(page1.len(), PAGE_SIZE as usize);
        assert!(has_more1);

        let (page2, has_more2) = list_gifs(&pool, &user, None, 2).await.unwrap();
        assert_eq!(page2.len(), 30 - PAGE_SIZE as usize);
        assert!(!has_more2);

        let page1_ids: HashSet<&str> = page1.iter().map(|g| g.id.as_str()).collect();
        let page2_ids: HashSet<&str> = page2.iter().map(|g| g.id.as_str()).collect();
        assert!(page1_ids.is_disjoint(&page2_ids));
        assert_eq!(page1_ids.len() + page2_ids.len(), 30);
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

        let (all, _has_more) = list_public_gifs(&pool, None, LibrarySort::Newest, 1).await.unwrap();
        let ids: Vec<&str> = all.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["someone-elses", "public"]);
        let public_entry = all.iter().find(|g| g.id == "public").unwrap();
        assert_eq!(public_entry.owner_handle.as_deref(), Some("owner-handle"));

        let (filtered, _has_more) = list_public_gifs(&pool, Some("cat"), LibrarySort::Newest, 1).await.unwrap();
        let filtered_ids: Vec<&str> = filtered.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(filtered_ids, vec!["public"]);
    }

    #[tokio::test]
    async fn list_public_gifs_paginates_at_page_size_with_no_overlap_or_gaps() {
        let pool = test_pool().await;
        let owner = seed_user(&pool).await;
        for i in 0..30 {
            let id = format!("g{i:02}");
            let created_at = format!("2026-08-{:02}T00:00:00Z", i + 1);
            insert_gif(&pool, &sample_gif(&id, "a", "", &owner), &created_at)
                .await
                .unwrap();
            set_gif_public(&pool, &id, &owner, true).await.unwrap();
        }

        let (page1, has_more1) = list_public_gifs(&pool, None, LibrarySort::Newest, 1).await.unwrap();
        assert_eq!(page1.len(), PAGE_SIZE as usize);
        assert!(has_more1);

        let (page2, has_more2) = list_public_gifs(&pool, None, LibrarySort::Newest, 2).await.unwrap();
        assert_eq!(page2.len(), 30 - PAGE_SIZE as usize);
        assert!(!has_more2);

        let page1_ids: HashSet<&str> = page1.iter().map(|g| g.id.as_str()).collect();
        let page2_ids: HashSet<&str> = page2.iter().map(|g| g.id.as_str()).collect();
        assert!(page1_ids.is_disjoint(&page2_ids));
        assert_eq!(page1_ids.len() + page2_ids.len(), 30);
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

        let (gifs, _has_more) = list_gifs(&pool, &user, None, 1).await.unwrap();
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

        upsert_template(&pool, "t1", "v1", &user, "Template", false, &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();
        let first = get_template(&pool, "v1").await.unwrap().unwrap();
        assert_eq!(first.width, 480);

        let mut overwrite = sample_template();
        overwrite.width = 320;
        upsert_template(&pool, "t1", "v1", &user, "Template", false, &overwrite, "2026-08-22T00:00:02Z")
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

        upsert_template(&pool, "t1", "v1", &user, "Template", false, &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();
        assert_eq!(get_template_id(&pool, "v1").await.unwrap().as_deref(), Some("t1"));

        upsert_template(&pool, "t1", "v1", &user, "Template", false, &sample_template(), "2026-08-22T00:00:02Z")
            .await
            .unwrap();
        assert_eq!(get_template_id(&pool, "v1").await.unwrap().as_deref(), Some("t1"));
    }

    #[tokio::test]
    async fn backfill_gif_template_lineage_stamps_only_gifs_missing_it() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        upsert_template(&pool, "t1", "v1", &user, "Template", false, &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();

        // Flow A, pre-fix: exported from v1 (which has a template) but
        // never got stamped — exactly what this backfill exists to fix.
        let mut unstamped = sample_gif("g1", "unstamped", "hi", &user);
        unstamped.video_id = Some("v1".to_string());
        insert_gif(&pool, &unstamped, "2026-08-22T00:00:02Z").await.unwrap();

        // Already correct (either post-fix Flow A, or Flow B) — must be
        // left alone, not overwritten with some other template.
        let mut already_stamped = sample_gif("g2", "already stamped", "hi", &user);
        already_stamped.template_id = Some("t1".to_string());
        insert_gif(&pool, &already_stamped, "2026-08-22T00:00:03Z").await.unwrap();

        // No template lineage at all (untemplated video) — must stay NULL.
        let untemplated = sample_gif("g3", "untemplated", "hi", &user);
        insert_gif(&pool, &untemplated, "2026-08-22T00:00:04Z").await.unwrap();

        let updated = backfill_gif_template_lineage(&pool).await.unwrap();
        assert_eq!(updated, 1);

        assert_eq!(get_gif(&pool, "g1", &user).await.unwrap().unwrap().template_id.as_deref(), Some("t1"));
        assert_eq!(get_gif(&pool, "g2", &user).await.unwrap().unwrap().template_id.as_deref(), Some("t1"));
        assert!(get_gif(&pool, "g3", &user).await.unwrap().unwrap().template_id.is_none());

        // Re-running is a no-op — nothing left to stamp.
        assert_eq!(backfill_gif_template_lineage(&pool).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn delete_template_removes_it_and_reports_success() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        upsert_template(&pool, "t1", "v1", &user, "Template", false, &sample_template(), "2026-08-22T00:00:01Z")
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
        upsert_template(&pool, "t1", "v1", &user, "Template", false, &sample_template(), "2026-08-22T00:00:01Z")
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
        upsert_template(&pool, "t1", "v1", &user, "Template", false, &sample_template(), "2026-08-22T00:00:01Z")
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
    async fn get_session_user_joins_the_owning_user_and_returns_last_active_at() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        set_handle(&pool, &user, "joined-user").await.unwrap();
        create_session(&pool, "sess-1", &user, "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        let (joined_user, last_active_at) = get_session_user(&pool, "sess-1").await.unwrap().unwrap();
        assert_eq!(joined_user.id, user);
        assert_eq!(joined_user.handle.as_deref(), Some("joined-user"));
        assert_eq!(last_active_at, "2026-08-22T00:00:00Z");

        touch_session(&pool, "sess-1", "2026-08-22T01:00:00Z").await.unwrap();
        let (_, touched_last_active_at) = get_session_user(&pool, "sess-1").await.unwrap().unwrap();
        assert_eq!(touched_last_active_at, "2026-08-22T01:00:00Z");
    }

    #[tokio::test]
    async fn get_session_user_returns_none_for_a_missing_session() {
        let pool = test_pool().await;
        assert!(get_session_user(&pool, "missing").await.unwrap().is_none());
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
        upsert_template(&pool, "t1", "v1", &owner, "Template", false, &sample_template(), "2026-08-22T00:00:01Z")
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

        let (sorted, _has_more) = list_public_gifs(&pool, None, LibrarySort::MostUsed, 1).await.unwrap();
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

    async fn seed_video(pool: &PgPool, id: &str, user_id: &str) -> String {
        insert_video(pool, &sample_video(id, user_id), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        id.to_string()
    }

    #[tokio::test]
    async fn ingest_job_insert_then_get_round_trips() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        let video_id = seed_video(&pool, "v1", &user).await;

        let job = insert_ingest_job(&pool, "job1", &video_id, "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        assert_eq!(job.stage, "uploading");

        let fetched = get_ingest_job(&pool, "job1").await.unwrap().unwrap();
        assert_eq!(fetched.video_id, video_id);
        assert_eq!(fetched.stage, "uploading");
    }

    #[tokio::test]
    async fn update_ingest_stage_respects_terminal_lock() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        let video_id = seed_video(&pool, "v1", &user).await;
        insert_ingest_job(&pool, "job1", &video_id, "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        let moved = update_ingest_stage(&pool, "job1", "analyzing", None, "2026-08-22T00:00:01Z")
            .await
            .unwrap();
        assert!(moved);

        let terminated = update_ingest_stage(&pool, "job1", "complete", None, "2026-08-22T00:00:02Z")
            .await
            .unwrap();
        assert!(terminated);

        // A late callback after the job is already terminal is dropped —
        // gifiac#43's "never resurrect" rule.
        let late = update_ingest_stage(&pool, "job1", "failed", Some("too late"), "2026-08-22T00:00:03Z")
            .await
            .unwrap();
        assert!(!late);
        let job = get_ingest_job(&pool, "job1").await.unwrap().unwrap();
        assert_eq!(job.stage, "complete");
    }

    #[tokio::test]
    async fn fill_in_video_probe_writes_through_nullable_columns() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        sqlx::query(
            "INSERT INTO videos (id, original_filename, extension, file_size_bytes, uploaded_at, user_id) \
             VALUES ('v1', 'clip.mp4', 'mp4', 1024, $1, $2)",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&user)
        .execute(&pool)
        .await
        .unwrap();

        fill_in_video_probe(&pool, "v1", 12.5, 1920, 1080).await.unwrap();

        let video = get_video(&pool, "v1", &user).await.unwrap().unwrap();
        assert_eq!(video.duration_seconds, Some(12.5));
        assert_eq!(video.width, Some(1920));
        assert_eq!(video.height, Some(1080));
    }

    #[tokio::test]
    async fn find_stale_ingest_jobs_only_returns_non_terminal_and_old() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        let video_id = seed_video(&pool, "v1", &user).await;

        insert_ingest_job(&pool, "stale", &video_id, "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        insert_ingest_job(&pool, "fresh", &video_id, "2026-08-22T00:10:00Z")
            .await
            .unwrap();
        insert_ingest_job(&pool, "already-done", &video_id, "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        update_ingest_stage(&pool, "already-done", "complete", None, "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        let stale = find_stale_ingest_jobs(&pool, "2026-08-22T00:05:00Z").await.unwrap();
        let ids: Vec<&str> = stale.iter().map(|j| j.id.as_str()).collect();
        assert_eq!(ids, vec!["stale"]);
    }

    #[tokio::test]
    async fn mark_ingest_job_timed_out_sets_distinct_status() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        let video_id = seed_video(&pool, "v1", &user).await;
        insert_ingest_job(&pool, "job1", &video_id, "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        assert!(
            mark_ingest_job_timed_out(&pool, "job1", "2026-08-22T00:02:00Z")
                .await
                .unwrap()
        );
        let job = get_ingest_job(&pool, "job1").await.unwrap().unwrap();
        assert_eq!(job.stage, "timed_out");
    }

    #[tokio::test]
    async fn export_job_insert_then_get_round_trips() {
        let pool = test_pool().await;
        let job = insert_export_job(&pool, "exp1", "{\"owner_id\":\"u1\"}", "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        assert_eq!(job.gif_status, "pending");
        assert_eq!(job.request_json, "{\"owner_id\":\"u1\"}");

        let fetched = get_export_job(&pool, "exp1").await.unwrap().unwrap();
        assert_eq!(fetched.mp4_status, "pending");
    }

    #[tokio::test]
    async fn update_export_format_status_is_independent_per_format() {
        let pool = test_pool().await;
        insert_export_job(&pool, "exp1", "{}", "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        update_export_format_status(&pool, "exp1", ExportFormat::Gif, "done", 100, None, "2026-08-22T00:00:01Z")
            .await
            .unwrap();
        update_export_format_status(
            &pool,
            "exp1",
            ExportFormat::Mp4,
            "failed",
            40,
            Some("boom"),
            "2026-08-22T00:00:02Z",
        )
        .await
        .unwrap();

        let job = get_export_job(&pool, "exp1").await.unwrap().unwrap();
        assert_eq!(job.gif_status, "done");
        assert_eq!(job.mp4_status, "failed");
        assert_eq!(job.mp4_error.as_deref(), Some("boom"));
        assert_eq!(job.webm_status, "pending");
    }

    #[tokio::test]
    async fn update_export_format_status_respects_terminal_lock() {
        let pool = test_pool().await;
        insert_export_job(&pool, "exp1", "{}", "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        update_export_format_status(&pool, "exp1", ExportFormat::Gif, "done", 100, None, "2026-08-22T00:00:01Z")
            .await
            .unwrap();

        let late = update_export_format_status(
            &pool,
            "exp1",
            ExportFormat::Gif,
            "failed",
            0,
            Some("too late"),
            "2026-08-22T00:00:02Z",
        )
        .await
        .unwrap();
        assert!(!late);

        let job = get_export_job(&pool, "exp1").await.unwrap().unwrap();
        assert_eq!(job.gif_status, "done");
    }

    /// Regression test: the export Lambda posts one progress callback per
    /// ffmpeg tick on its own spawned task (`export_lambda.rs`'s
    /// `report_progress`), with no guarantee the resulting HTTP requests
    /// arrive in the order they were sent — an out-of-order arrival must
    /// not regress a format's stored percent, or that regression gets
    /// broadcast straight to the SSE stream as a visible flicker.
    #[tokio::test]
    async fn update_export_format_status_drops_an_out_of_order_lower_percent() {
        let pool = test_pool().await;
        insert_export_job(&pool, "exp1", "{}", "2026-08-22T00:00:00Z").await.unwrap();

        let advanced = update_export_format_status(&pool, "exp1", ExportFormat::Gif, "running", 80, None, "2026-08-22T00:00:01Z")
            .await
            .unwrap();
        assert!(advanced);

        // A tick for 45% arrives after the 80% tick already landed.
        let stale = update_export_format_status(&pool, "exp1", ExportFormat::Gif, "running", 45, None, "2026-08-22T00:00:02Z")
            .await
            .unwrap();
        assert!(!stale, "a lower running percent must be dropped, not overwrite a higher one");

        let job = get_export_job(&pool, "exp1").await.unwrap().unwrap();
        assert_eq!(job.gif_percent, 80, "stored percent must not have regressed");

        // An equal percent is allowed through (not strictly-greater-only).
        let same = update_export_format_status(&pool, "exp1", ExportFormat::Gif, "running", 80, None, "2026-08-22T00:00:03Z")
            .await
            .unwrap();
        assert!(same);

        // A terminal status always applies, even with a lower percent
        // than what's currently stored (e.g. a failure reported mid-encode).
        let terminal = update_export_format_status(
            &pool,
            "exp1",
            ExportFormat::Gif,
            "failed",
            10,
            Some("boom"),
            "2026-08-22T00:00:04Z",
        )
        .await
        .unwrap();
        assert!(terminal, "a terminal status must apply regardless of percent");

        let job = get_export_job(&pool, "exp1").await.unwrap().unwrap();
        assert_eq!(job.gif_status, "failed");
        assert_eq!(job.gif_percent, 10);
    }

    #[tokio::test]
    async fn find_stale_export_jobs_only_returns_non_terminal_and_old() {
        let pool = test_pool().await;
        insert_export_job(&pool, "stale", "{}", "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        insert_export_job(&pool, "fresh", "{}", "2026-08-22T00:10:00Z")
            .await
            .unwrap();
        insert_export_job(&pool, "already-done", "{}", "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        for format in [ExportFormat::Gif, ExportFormat::Mp4, ExportFormat::Webm] {
            update_export_format_status(&pool, "already-done", format, "done", 100, None, "2026-08-22T00:00:00Z")
                .await
                .unwrap();
        }

        let stale = find_stale_export_jobs(&pool, "2026-08-22T00:05:00Z").await.unwrap();
        let ids: Vec<&str> = stale.iter().map(|j| j.id.as_str()).collect();
        assert_eq!(ids, vec!["stale"]);
    }

    #[tokio::test]
    async fn mark_export_job_timed_out_only_touches_non_terminal_formats() {
        let pool = test_pool().await;
        insert_export_job(&pool, "exp1", "{}", "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        update_export_format_status(&pool, "exp1", ExportFormat::Gif, "done", 100, None, "2026-08-22T00:00:01Z")
            .await
            .unwrap();

        mark_export_job_timed_out(&pool, "exp1", "2026-08-22T00:02:00Z").await.unwrap();

        let job = get_export_job(&pool, "exp1").await.unwrap().unwrap();
        assert_eq!(job.gif_status, "done", "already-terminal format must not be overwritten");
        assert_eq!(job.mp4_status, "timed_out");
        assert_eq!(job.webm_status, "timed_out");
    }
}
