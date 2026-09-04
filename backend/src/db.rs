use std::path::Path;

use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::models::{Gif, NewGif, NewVideo, TemplatePayload, Video, VideoListItem, VideoTemplate};

const VIDEO_COLUMNS: &str = "id, original_filename, extension, file_size_bytes, duration_seconds, width, height, uploaded_at";
const GIF_COLUMNS: &str = "id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, external_url, created_at, is_one_off";
/// The columns a fresh insert actually supplies — `is_one_off` is
/// deliberately excluded: every newly created GIF (export, import, or
/// link) starts out reusable, relying on the schema's `DEFAULT 0` rather
/// than binding it explicitly.
const INSERT_GIF_COLUMNS: &str = "id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, external_url, created_at";

pub async fn create_pool(db_path: &Path) -> Result<SqlitePool> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let options = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new().connect_with(options).await?;
    Ok(pool)
}

pub async fn run_migrations(pool: &SqlitePool) -> Result<()> {
    sqlx::migrate!("./migrations").run(pool).await?;
    Ok(())
}

pub async fn insert_video(pool: &SqlitePool, video: &NewVideo, uploaded_at: &str) -> Result<Video> {
    let sql = format!(
        "INSERT INTO videos ({VIDEO_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING {VIDEO_COLUMNS}"
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
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

pub async fn get_video(pool: &SqlitePool, id: &str) -> Result<Option<Video>> {
    let sql = format!("SELECT {VIDEO_COLUMNS} FROM videos WHERE id = ?");
    sqlx::query_as::<_, Video>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// `has_template` is resolved at the join level (SPEC.md §12) rather than
/// with a per-video follow-up query.
pub async fn list_videos(pool: &SqlitePool) -> Result<Vec<VideoListItem>> {
    let sql = "SELECT v.id, v.original_filename, v.extension, v.file_size_bytes, v.duration_seconds, v.width, v.height, v.uploaded_at, (t.video_id IS NOT NULL) AS has_template \
         FROM videos v LEFT JOIN video_templates t ON t.video_id = v.id ORDER BY v.uploaded_at DESC";
    sqlx::query_as::<_, VideoListItem>(sql)
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn insert_gif(pool: &SqlitePool, gif: &NewGif, created_at: &str) -> Result<Gif> {
    let sql = format!(
        "INSERT INTO gifs ({INSERT_GIF_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING {GIF_COLUMNS}"
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
        .fetch_one(pool)
        .await
        .map_err(Into::into)
}

/// SPEC.md §5: `q` matches `name` and `caption_text` **together** — one
/// combined filter, no separate name/tag params. `None`/empty returns
/// everything, newest first, no pagination (v1). Sorted `is_one_off ASC`
/// first (SPEC.md §8): reusable GIFs come before one-offs, each group
/// newest-first — the frontend renders the "One-offs" divider wherever
/// the flag flips in this single ordered list.
pub async fn list_gifs(pool: &SqlitePool, q: Option<&str>) -> Result<Vec<Gif>> {
    match q.map(str::trim).filter(|q| !q.is_empty()) {
        Some(q) => {
            let sql = format!(
                "SELECT {GIF_COLUMNS} FROM gifs WHERE name LIKE ? ESCAPE '\\' OR caption_text LIKE ? ESCAPE '\\' ORDER BY is_one_off ASC, created_at DESC"
            );
            let pattern = format!("%{}%", escape_like(q));
            sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
                .bind(&pattern)
                .bind(&pattern)
                .fetch_all(pool)
                .await
                .map_err(Into::into)
        }
        None => {
            let sql = format!("SELECT {GIF_COLUMNS} FROM gifs ORDER BY is_one_off ASC, created_at DESC");
            sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
                .fetch_all(pool)
                .await
                .map_err(Into::into)
        }
    }
}

/// Escapes SQLite `LIKE` wildcards (`%`, `_`) in user-supplied search text,
/// paired with `ESCAPE '\'` at the call site, so a search containing them
/// is matched literally instead of as a pattern.
fn escape_like(input: &str) -> String {
    input.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

pub async fn get_gif(pool: &SqlitePool, id: &str) -> Result<Option<Gif>> {
    let sql = format!("SELECT {GIF_COLUMNS} FROM gifs WHERE id = ?");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Renames a GIF in place (SPEC.md §5 `PATCH /api/gifs/{id}` — no
/// re-export needed). Returns `None` if no row matched, so the route can
/// tell "renamed" apart from "doesn't exist" without a separate lookup.
pub async fn rename_gif(pool: &SqlitePool, id: &str, name: &str) -> Result<Option<Gif>> {
    let sql = format!("UPDATE gifs SET name = ? WHERE id = ? RETURNING {GIF_COLUMNS}");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(name)
        .bind(id)
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
pub async fn set_gif_one_off(pool: &SqlitePool, id: &str, is_one_off: bool) -> Result<Option<Gif>> {
    let sql = format!("UPDATE gifs SET is_one_off = ? WHERE id = ? RETURNING {GIF_COLUMNS}");
    sqlx::query_as::<_, Gif>(sqlx::AssertSqlSafe(sql))
        .bind(is_one_off)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(Into::into)
}

/// Returns `true` if a row was actually deleted, so the route can 404 on a
/// nonexistent id rather than reporting a no-op delete as success.
pub async fn delete_gif(pool: &SqlitePool, id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM gifs WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Whether this video has a saved template — checked before deleting it
/// (SPEC.md §12: "a video can only be deleted if it has no template",
/// replacing the earlier "no GIFs were made from it" guard entirely).
pub async fn has_template(pool: &SqlitePool, video_id: &str) -> Result<bool> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM video_templates WHERE video_id = ?")
        .bind(video_id)
        .fetch_one(pool)
        .await?;
    Ok(count > 0)
}

pub async fn delete_video(pool: &SqlitePool, id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM videos WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

pub async fn get_template(pool: &SqlitePool, video_id: &str) -> Result<Option<TemplatePayload>> {
    let row: Option<VideoTemplate> =
        sqlx::query_as("SELECT video_id, payload_json, saved_at FROM video_templates WHERE video_id = ?")
            .bind(video_id)
            .fetch_optional(pool)
            .await?;
    row.map(|r| serde_json::from_str(&r.payload_json).map_err(Into::into))
        .transpose()
}

/// Upserts the template for `video_id` (SPEC.md §12: "Upserts (creates or
/// overwrites) the template with the request body").
pub async fn upsert_template(
    pool: &SqlitePool,
    video_id: &str,
    payload: &TemplatePayload,
    saved_at: &str,
) -> Result<()> {
    let payload_json = serde_json::to_string(payload)?;
    sqlx::query(
        "INSERT INTO video_templates (video_id, payload_json, saved_at) VALUES (?, ?, ?) \
         ON CONFLICT (video_id) DO UPDATE SET payload_json = excluded.payload_json, saved_at = excluded.saved_at",
    )
    .bind(video_id)
    .bind(payload_json)
    .bind(saved_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Returns `true` if a template was actually deleted.
pub async fn delete_template(pool: &SqlitePool, video_id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM video_templates WHERE video_id = ?")
        .bind(video_id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> SqlitePool {
        // A single pooled connection over `:memory:` — sqlx gives each
        // pooled connection its own private in-memory database, so a pool
        // size > 1 here would see "no such table" once a query landed on a
        // connection other than the one migrations ran on.
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        run_migrations(&pool).await.unwrap();
        pool
    }

    fn sample_video(id: &str) -> NewVideo {
        NewVideo {
            id: id.to_string(),
            original_filename: "clip.mp4".to_string(),
            extension: "mp4".to_string(),
            file_size_bytes: 1024,
            duration_seconds: 12.5,
            width: 1920,
            height: 1080,
        }
    }

    #[tokio::test]
    async fn insert_then_get_round_trips_all_fields() {
        let pool = test_pool().await;
        let inserted = insert_video(&pool, &sample_video("v1"), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        assert_eq!(inserted.id, "v1");
        assert_eq!(inserted.original_filename, "clip.mp4");
        assert_eq!(inserted.width, 1920);

        let fetched = get_video(&pool, "v1").await.unwrap().unwrap();
        assert_eq!(fetched.id, inserted.id);
        assert_eq!(fetched.duration_seconds, 12.5);
    }

    #[tokio::test]
    async fn get_missing_video_returns_none() {
        let pool = test_pool().await;
        assert!(get_video(&pool, "missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_videos_orders_newest_first() {
        let pool = test_pool().await;
        insert_video(&pool, &sample_video("older"), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_video(&pool, &sample_video("newer"), "2026-08-21T00:00:00Z")
            .await
            .unwrap();

        let videos = list_videos(&pool).await.unwrap();
        let ids: Vec<&str> = videos.iter().map(|v| v.id.as_str()).collect();
        assert_eq!(ids, vec!["newer", "older"]);
    }

    #[tokio::test]
    async fn list_videos_reports_has_template_only_for_videos_with_a_saved_template() {
        let pool = test_pool().await;
        insert_video(&pool, &sample_video("v1"), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        insert_video(&pool, &sample_video("v2"), "2026-08-22T00:00:01Z")
            .await
            .unwrap();
        upsert_template(&pool, "v1", &sample_template(), "2026-08-22T00:00:02Z")
            .await
            .unwrap();

        let videos = list_videos(&pool).await.unwrap();
        let has_template = |id: &str| videos.iter().find(|v| v.id == id).unwrap().has_template;
        assert!(has_template("v1"));
        assert!(!has_template("v2"));
    }

    #[tokio::test]
    async fn insert_gif_round_trips_including_nullable_fields() {
        let pool = test_pool().await;
        insert_video(&pool, &sample_video("v1"), "2026-08-22T00:00:00Z")
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
            },
            "2026-08-22T00:00:01Z",
        )
        .await
        .unwrap();

        assert_eq!(gif.external_url.as_deref(), Some("https://example.com/a.gif"));
        assert!(gif.gif_range_start.is_none());
        assert!(gif.width.is_none());
    }

    fn sample_gif(id: &str, name: &str, caption_text: &str) -> NewGif {
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
        insert_gif(&pool, &sample_gif("older", "a", ""), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("newer", "b", ""), "2026-08-21T00:00:00Z")
            .await
            .unwrap();

        let gifs = list_gifs(&pool, None).await.unwrap();
        let ids: Vec<&str> = gifs.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["newer", "older"]);
    }

    #[tokio::test]
    async fn list_gifs_matches_name_or_caption_text() {
        let pool = test_pool().await;
        insert_gif(&pool, &sample_gif("g1", "Cat jumping", ""), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("g2", "Dog running", "cat sound"), "2026-08-21T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("g3", "Bird flying", ""), "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        let gifs = list_gifs(&pool, Some("cat")).await.unwrap();
        let ids: Vec<&str> = gifs.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(ids, vec!["g2", "g1"]); // matched via caption_text and name respectively, newest first
    }

    #[tokio::test]
    async fn list_gifs_treats_a_blank_query_as_no_filter() {
        let pool = test_pool().await;
        insert_gif(&pool, &sample_gif("g1", "a", ""), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        let gifs = list_gifs(&pool, Some("   ")).await.unwrap();
        assert_eq!(gifs.len(), 1);
    }

    #[tokio::test]
    async fn get_gif_returns_none_for_a_missing_id() {
        let pool = test_pool().await;
        assert!(get_gif(&pool, "missing").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn rename_gif_updates_the_name_and_returns_the_updated_row() {
        let pool = test_pool().await;
        insert_gif(&pool, &sample_gif("g1", "old name", ""), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        let renamed = rename_gif(&pool, "g1", "new name").await.unwrap().unwrap();
        assert_eq!(renamed.name, "new name");
        assert_eq!(get_gif(&pool, "g1").await.unwrap().unwrap().name, "new name");
    }

    #[tokio::test]
    async fn rename_gif_returns_none_for_a_missing_id() {
        let pool = test_pool().await;
        assert!(rename_gif(&pool, "missing", "x").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn new_gifs_default_to_not_one_off() {
        let pool = test_pool().await;
        let gif = insert_gif(&pool, &sample_gif("g1", "a", ""), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        assert!(!gif.is_one_off);
    }

    #[tokio::test]
    async fn set_gif_one_off_flips_the_flag_and_back() {
        let pool = test_pool().await;
        insert_gif(&pool, &sample_gif("g1", "a", ""), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        let marked = set_gif_one_off(&pool, "g1", true).await.unwrap().unwrap();
        assert!(marked.is_one_off);
        assert!(get_gif(&pool, "g1").await.unwrap().unwrap().is_one_off);

        let unmarked = set_gif_one_off(&pool, "g1", false).await.unwrap().unwrap();
        assert!(!unmarked.is_one_off);
    }

    #[tokio::test]
    async fn set_gif_one_off_returns_none_for_a_missing_id() {
        let pool = test_pool().await;
        assert!(set_gif_one_off(&pool, "missing", true).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_gifs_sorts_one_off_gifs_after_reusable_ones() {
        let pool = test_pool().await;
        // Newest first within each group, but one-offs always after
        // reusable GIFs regardless of creation time (SPEC.md §8).
        insert_gif(&pool, &sample_gif("old-reusable", "a", ""), "2026-08-19T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("new-one-off", "b", ""), "2026-08-22T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("new-reusable", "c", ""), "2026-08-21T00:00:00Z")
            .await
            .unwrap();
        insert_gif(&pool, &sample_gif("old-one-off", "d", ""), "2026-08-20T00:00:00Z")
            .await
            .unwrap();
        set_gif_one_off(&pool, "new-one-off", true).await.unwrap();
        set_gif_one_off(&pool, "old-one-off", true).await.unwrap();

        let gifs = list_gifs(&pool, None).await.unwrap();
        let ids: Vec<&str> = gifs.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["new-reusable", "old-reusable", "new-one-off", "old-one-off"]
        );
    }

    #[tokio::test]
    async fn delete_gif_removes_the_row_and_reports_success() {
        let pool = test_pool().await;
        insert_gif(&pool, &sample_gif("g1", "a", ""), "2026-08-20T00:00:00Z")
            .await
            .unwrap();

        assert!(delete_gif(&pool, "g1").await.unwrap());
        assert!(get_gif(&pool, "g1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_gif_reports_false_for_a_missing_id() {
        let pool = test_pool().await;
        assert!(!delete_gif(&pool, "missing").await.unwrap());
    }

    #[tokio::test]
    async fn has_template_reports_true_only_after_a_template_is_saved() {
        let pool = test_pool().await;
        insert_video(&pool, &sample_video("v1"), "2026-08-22T00:00:00Z")
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
        insert_video(&pool, &sample_video("v1"), "2026-08-22T00:00:00Z")
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
        insert_video(&pool, &sample_video("v1"), "2026-08-22T00:00:00Z")
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
        insert_video(&pool, &sample_video("v1"), "2026-08-22T00:00:00Z")
            .await
            .unwrap();

        assert!(delete_video(&pool, "v1").await.unwrap());
        assert!(get_video(&pool, "v1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_video_reports_false_for_a_missing_id() {
        let pool = test_pool().await;
        assert!(!delete_video(&pool, "missing").await.unwrap());
    }
}
