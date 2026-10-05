use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub video_dir: PathBuf,
    /// A `postgres://` connection URL (SPEC-CLOUD.md §1: metadata DB moves
    /// from SQLite to Postgres via RDS) — replaces the old
    /// `GIFIAC_DB_PATH` file path.
    pub database_url: String,
    pub port: u16,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            video_dir: std::env::var("GIFIAC_VIDEO_DIR")
                .unwrap_or_else(|_| "/data/videos".to_string())
                .into(),
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "postgres://gifiac:gifiac@localhost:5432/gifiac".to_string()),
            // TEMPORARY local override for manual verification — port 8080
            // is occupied by unrelated infra on this machine. Revert before
            // committing: fixed per SPEC.md §10, host-side port mapping is
            // left to the deployment tooling, intentionally not env-driven.
            port: std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080),
        }
    }
}
