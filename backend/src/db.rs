use std::path::Path;

use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::models::{Gif, NewGif, NewVideo, Video};

const VIDEO_COLUMNS: &str = "id, original_filename, extension, file_size_bytes, duration_seconds, width, height, uploaded_at";
const GIF_COLUMNS: &str = "id, video_id, name, caption_text, captions_json, gif_range_start, gif_range_end, width, height, created_at";

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

pub async fn list_videos(pool: &SqlitePool) -> Result<Vec<Video>> {
    let sql = format!("SELECT {VIDEO_COLUMNS} FROM videos ORDER BY uploaded_at DESC");
    sqlx::query_as::<_, Video>(sqlx::AssertSqlSafe(sql))
        .fetch_all(pool)
        .await
        .map_err(Into::into)
}

pub async fn insert_gif(pool: &SqlitePool, gif: &NewGif, created_at: &str) -> Result<Gif> {
    let sql = format!(
        "INSERT INTO gifs ({GIF_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING {GIF_COLUMNS}"
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
        .bind(created_at)
        .fetch_one(pool)
        .await
        .map_err(Into::into)
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
                gif_range_start: 1.0,
                gif_range_end: 4.0,
                width: 480,
                height: 270,
            },
            "2026-08-22T00:00:01Z",
        )
        .await
        .unwrap();

        assert_eq!(gif.id, "g1");
        assert_eq!(gif.video_id.as_deref(), Some("v1"));
        assert_eq!(gif.name, "My GIF");
        assert_eq!(gif.width, 480);
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
                gif_range_start: 0.0,
                gif_range_end: 0.0,
                width: 200,
                height: 200,
            },
            "2026-08-22T00:00:01Z",
        )
        .await
        .unwrap();

        assert!(gif.video_id.is_none());
        assert!(gif.captions_json.is_none());
    }
}
