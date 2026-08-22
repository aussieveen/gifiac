use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    pub video_dir: PathBuf,
    pub db_path: PathBuf,
    pub port: u16,
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            video_dir: std::env::var("GIFIAC_VIDEO_DIR")
                .unwrap_or_else(|_| "/data/videos".to_string())
                .into(),
            db_path: std::env::var("GIFIAC_DB_PATH")
                .unwrap_or_else(|_| "/data/gifiac.db".to_string())
                .into(),
            // Fixed per SPEC.md §10 — host-side port mapping is left to the
            // deployment tooling, so this is intentionally not env-driven.
            port: 8080,
        }
    }
}
