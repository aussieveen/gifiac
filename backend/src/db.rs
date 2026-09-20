use anyhow::Result;
use sqlx::postgres::{PgPool, PgPoolOptions};
use uuid::Uuid;

use crate::models::{
    Gif, NewGif, NewVideo, Session, TemplatePayload, User, Video, VideoListItem, VideoTemplate,
};

const VIDEO_COLUMNS: &str = "id, original_filename, extension, file_size_bytes, duration_seconds, width, height, uploaded_at";
const GIF_COLUMNS: &str = "id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, external_url, created_at, is_one_off";
/// The columns a fresh insert actually supplies — `is_one_off` is
/// deliberately excluded: every newly created GIF (export, import, or
/// link) starts out reusable, relying on the schema's `DEFAULT false`
/// rather than binding it explicitly. `user_id` isn't part of either
/// column list: it's an ownership-scoping parameter on every function
/// here, never part of what's `SELECT`ed back out to a response (SPEC-
/// CLOUD.md §3's ownership model is enforced in the query, not surfaced
/// to the frontend).
const INSERT_GIF_COLUMNS: &str = "id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, external_url, created_at";

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
    let sql = format!(
        "INSERT INTO gifs ({INSERT_GIF_COLUMNS}, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING {GIF_COLUMNS}"
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
        .bind(&gif.user_id)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
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

/// Whether this video has a saved template — checked before deleting it
/// (SPEC.md §12: "a video can only be deleted if it has no template",
/// replacing the earlier "no GIFs were made from it" guard entirely).
/// Not itself owner-scoped: every call site already resolved `video_id`
/// through an owner-scoped `get_video` first, so by the time this runs
/// the caller's ownership of the video is already established.
pub async fn has_template(pool: &PgPool, video_id: &str) -> Result<bool> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM templates WHERE video_id = $1")
        .bind(video_id)
        .fetch_one(pool)
        .await?;
    Ok(count > 0)
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

/// Upserts the template for `video_id` (SPEC.md §12: "Upserts (creates or
/// overwrites) the template with the request body"). `templates` now has
/// its own `id` (SPEC-CLOUD.md §4, distinct from `video_id`, for
/// `gifs.template_id` to eventually reference) — a fresh id is generated
/// on every call but only actually lands when there's no existing row to
/// conflict with; `ON CONFLICT` deliberately leaves `id` alone on an
/// overwrite so a template's identity survives being re-saved.
pub async fn upsert_template(
    pool: &PgPool,
    video_id: &str,
    payload: &TemplatePayload,
    saved_at: &str,
) -> Result<()> {
    let payload_json = serde_json::to_string(payload)?;
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO templates (id, video_id, payload_json, saved_at) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (video_id) DO UPDATE SET payload_json = excluded.payload_json, saved_at = excluded.saved_at",
    )
    .bind(id)
    .bind(video_id)
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

const USER_COLUMNS: &str = "id, handle, role, created_at, email, avatar_url";

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
) -> Result<User> {
    let mut tx = pool.begin().await?;
    sqlx::query("INSERT INTO users (id, role, created_at, email, avatar_url) VALUES ($1, 'user', $2, $3, $4)")
        .bind(user_id)
        .bind(created_at)
        .bind(email)
        .bind(avatar_url)
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
) -> Result<()> {
    sqlx::query("UPDATE users SET email = $1, avatar_url = $2 WHERE id = $3")
        .bind(email)
        .bind(avatar_url)
        .bind(user_id)
        .execute(pool)
        .await?;
    Ok(())
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
        upsert_template(&pool, "v1", &sample_template(), "2026-08-22T00:00:02Z")
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
    async fn has_template_reports_true_only_after_a_template_is_saved() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        assert!(!has_template(&pool, "v1").await.unwrap());

        upsert_template(&pool, "v1", &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();

        assert!(has_template(&pool, "v1").await.unwrap());
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

        upsert_template(&pool, "v1", &sample_template(), "2026-08-22T00:00:01Z")
            .await
            .unwrap();
        let first = get_template(&pool, "v1").await.unwrap().unwrap();
        assert_eq!(first.width, 480);

        let mut overwrite = sample_template();
        overwrite.width = 320;
        upsert_template(&pool, "v1", &overwrite, "2026-08-22T00:00:02Z")
            .await
            .unwrap();

        let second = get_template(&pool, "v1").await.unwrap().unwrap();
        assert_eq!(second.width, 320);
    }

    #[tokio::test]
    async fn delete_template_removes_it_and_reports_success() {
        let pool = test_pool().await;
        let user = seed_user(&pool).await;
        insert_video(&pool, &sample_video("v1", &user), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        upsert_template(&pool, "v1", &sample_template(), "2026-08-22T00:00:01Z")
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
}
