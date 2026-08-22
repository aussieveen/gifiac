use std::path::{Path, PathBuf};

use uuid::Uuid;

pub fn video_path(video_dir: &Path, id: &Uuid, extension: &str) -> PathBuf {
    video_dir.join(format!("{id}.{extension}"))
}

pub fn thumbnail_path(video_dir: &Path, id: &Uuid) -> PathBuf {
    video_dir.join(format!("{id}_thumb.jpg"))
}

pub fn filmstrip_sprite_path(video_dir: &Path, id: &Uuid) -> PathBuf {
    video_dir.join(format!("{id}_filmstrip.jpg"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> Uuid {
        Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap()
    }

    #[test]
    fn video_path_joins_id_and_extension() {
        let dir = Path::new("/data/videos");
        assert_eq!(
            video_path(dir, &id(), "mp4"),
            PathBuf::from("/data/videos/11111111-1111-4111-8111-111111111111.mp4")
        );
    }

    #[test]
    fn video_path_preserves_extension_case() {
        let dir = Path::new("/data/videos");
        assert_eq!(
            video_path(dir, &id(), "MOV"),
            PathBuf::from("/data/videos/11111111-1111-4111-8111-111111111111.MOV")
        );
    }

    #[test]
    fn thumbnail_path_appends_thumb_suffix() {
        let dir = Path::new("/data/videos");
        assert_eq!(
            thumbnail_path(dir, &id()),
            PathBuf::from("/data/videos/11111111-1111-4111-8111-111111111111_thumb.jpg")
        );
    }

    #[test]
    fn filmstrip_sprite_path_appends_filmstrip_suffix() {
        let dir = Path::new("/data/videos");
        assert_eq!(
            filmstrip_sprite_path(dir, &id()),
            PathBuf::from("/data/videos/11111111-1111-4111-8111-111111111111_filmstrip.jpg")
        );
    }
}
