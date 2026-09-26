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

/// A template's self-contained clip (SPEC-CLOUD.md §4) — derived from the
/// template's own id, same convention as every other asset path here,
/// rather than a separately stored key (see
/// `0005_drop_template_asset_keys.sql`). Always `.mp4` regardless of the
/// source video's extension — nothing needs this file to match the
/// source's container format, it's re-encoded either way.
pub fn template_clip_path(video_dir: &Path, template_id: &Uuid) -> PathBuf {
    video_dir.join(format!("{template_id}_template.mp4"))
}

pub fn template_thumbnail_path(video_dir: &Path, template_id: &Uuid) -> PathBuf {
    video_dir.join(format!("{template_id}_template_thumb.jpg"))
}

/// A template's own filmstrip sprite, generated from its already-trimmed
/// clip (not the source video) — so it only ever spans the template's own
/// range, never the full original video.
pub fn template_filmstrip_path(video_dir: &Path, template_id: &Uuid) -> PathBuf {
    video_dir.join(format!("{template_id}_template_filmstrip.jpg"))
}

/// The private source-video S3 bucket's object key (SPEC-CLOUD.md §6) —
/// the `raw/` prefix is what the 7-day lifecycle rule targets, kept
/// separate from the (not-yet-migrated, see M4's plan notes) template-clip
/// prefix so that rule can't reach the wrong asset class.
pub fn video_object_key(id: &Uuid, extension: &str) -> String {
    format!("raw/{id}.{extension}")
}

/// R2 object keys for a GIF export's three output formats (SPEC.md §6) —
/// derived from the export id, sharing the same UUID across all three.
pub fn gif_object_key(id: &Uuid) -> String {
    format!("gifs/{id}.gif")
}

pub fn mp4_object_key(id: &Uuid) -> String {
    format!("clips/{id}.mp4")
}

pub fn webm_object_key(id: &Uuid) -> String {
    format!("clips/{id}.webm")
}

/// A linked GIF's generated poster-frame thumbnail (see
/// `0015_gif_thumbnails.sql`) — same derived-from-id convention as the
/// other object keys above, never separately stored.
pub fn thumbnail_object_key(id: &Uuid) -> String {
    format!("thumbnails/{id}.jpg")
}

/// R2 object keys for a saved template's backup in the private,
/// versioned template-assets bucket (SPEC-CLOUD.md §10) — derived from
/// the template's own id, same convention as its local-disk path
/// (`template_clip_path`/etc.) and as `gif_object_key`/etc. above.
pub fn template_clip_object_key(template_id: &Uuid) -> String {
    format!("templates/{template_id}.mp4")
}

pub fn template_thumbnail_object_key(template_id: &Uuid) -> String {
    format!("templates/{template_id}_thumb.jpg")
}

pub fn template_filmstrip_object_key(template_id: &Uuid) -> String {
    format!("templates/{template_id}_filmstrip.jpg")
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

    #[test]
    fn template_clip_path_appends_template_suffix_and_is_always_mp4() {
        let dir = Path::new("/data/videos");
        assert_eq!(
            template_clip_path(dir, &id()),
            PathBuf::from("/data/videos/11111111-1111-4111-8111-111111111111_template.mp4")
        );
    }

    #[test]
    fn template_thumbnail_path_appends_template_thumb_suffix() {
        let dir = Path::new("/data/videos");
        assert_eq!(
            template_thumbnail_path(dir, &id()),
            PathBuf::from("/data/videos/11111111-1111-4111-8111-111111111111_template_thumb.jpg")
        );
    }

    #[test]
    fn template_filmstrip_path_appends_template_filmstrip_suffix() {
        let dir = Path::new("/data/videos");
        assert_eq!(
            template_filmstrip_path(dir, &id()),
            PathBuf::from("/data/videos/11111111-1111-4111-8111-111111111111_template_filmstrip.jpg")
        );
    }

    #[test]
    fn thumbnail_object_key_uses_the_thumbnails_prefix() {
        assert_eq!(
            thumbnail_object_key(&id()),
            "thumbnails/11111111-1111-4111-8111-111111111111.jpg"
        );
    }

    #[test]
    fn template_asset_object_keys_share_the_template_id() {
        assert_eq!(
            template_clip_object_key(&id()),
            "templates/11111111-1111-4111-8111-111111111111.mp4"
        );
        assert_eq!(
            template_thumbnail_object_key(&id()),
            "templates/11111111-1111-4111-8111-111111111111_thumb.jpg"
        );
        assert_eq!(
            template_filmstrip_object_key(&id()),
            "templates/11111111-1111-4111-8111-111111111111_filmstrip.jpg"
        );
    }

    #[test]
    fn object_keys_share_the_export_id_across_formats() {
        assert_eq!(
            gif_object_key(&id()),
            "gifs/11111111-1111-4111-8111-111111111111.gif"
        );
        assert_eq!(
            mp4_object_key(&id()),
            "clips/11111111-1111-4111-8111-111111111111.mp4"
        );
        assert_eq!(
            webm_object_key(&id()),
            "clips/11111111-1111-4111-8111-111111111111.webm"
        );
    }

    #[test]
    fn video_object_key_uses_the_raw_prefix_and_the_videos_own_extension() {
        assert_eq!(
            video_object_key(&id(), "mov"),
            "raw/11111111-1111-4111-8111-111111111111.mov"
        );
    }
}
