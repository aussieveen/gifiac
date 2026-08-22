use std::path::Path;

use anyhow::Result;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::models::{NewVideo, Video};

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
    sqlx::query_as::<_, Video>(
        r#"
        INSERT INTO videos
            (id, original_filename, extension, file_size_bytes, duration_seconds, width, height, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING id, original_filename, extension, file_size_bytes, duration_seconds, width, height, uploaded_at
        "#,
    )
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
    sqlx::query_as::<_, Video>(
        r#"
        SELECT id, original_filename, extension, file_size_bytes, duration_seconds, width, height, uploaded_at
        FROM videos WHERE id = ?
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(Into::into)
}

pub async fn list_videos(pool: &SqlitePool) -> Result<Vec<Video>> {
    sqlx::query_as::<_, Video>(
        r#"
        SELECT id, original_filename, extension, file_size_bytes, duration_seconds, width, height, uploaded_at
        FROM videos ORDER BY uploaded_at DESC
        "#,
    )
    .fetch_all(pool)
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
}
