use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Video {
    pub id: String,
    pub original_filename: String,
    pub extension: String,
    pub file_size_bytes: i64,
    pub duration_seconds: f64,
    pub width: i64,
    pub height: i64,
    pub uploaded_at: String,
}

pub struct NewVideo {
    pub id: String,
    pub original_filename: String,
    pub extension: String,
    pub file_size_bytes: i64,
    pub duration_seconds: f64,
    pub width: i64,
    pub height: i64,
    pub user_id: String,
}

/// `GET /api/videos` row shape (SPEC.md §12) — every `Video` field plus
/// `has_template`, resolved via a join so the video-picker badge doesn't
/// need a separate round-trip per video.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct VideoListItem {
    pub id: String,
    pub original_filename: String,
    pub extension: String,
    pub file_size_bytes: i64,
    pub duration_seconds: f64,
    pub width: i64,
    pub height: i64,
    pub uploaded_at: String,
    pub has_template: bool,
}

/// A video's saved export template (SPEC.md §12) — one per video, upserted
/// via `PUT /api/videos/{id}/template`.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct VideoTemplate {
    pub video_id: String,
    pub payload_json: String,
    pub saved_at: String,
}

/// The template's actual saved content, serialized into `payload_json`.
/// snake_case at the top level (matching the `gifs` table columns, same
/// convention as `ExportRequest`), camelCase `captions` (matching §4) via
/// `Caption`'s own rename. Deliberately excludes `name` — SPEC.md §12: "The
/// GIF `name` is not stored (it's per-GIF, not per-template)."
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TemplatePayload {
    pub captions: Vec<Caption>,
    pub gif_range_start: f64,
    pub gif_range_end: f64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilmstripMeta {
    pub frame_count: u32,
    pub cols: u32,
    pub rows: u32,
    pub frame_width: u32,
    pub frame_height: u32,
    pub interval: f64,
    pub image_url: String,
}

/// Caption data structure per SPEC.md §4 — camelCase on the wire, produced
/// by the frontend editor and consumed here by the ASS subtitle generator.
/// `width` and `outline_color` extend the original spec (user-requested:
/// a resizable text box so long captions can be kept on one line, and an
/// optional colored outline).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub id: String,
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
    pub font_family: String,
    pub font_size: f64,
    pub color: String,
    pub align: CaptionAlign,
    pub x: f64,
    pub y: f64,
    /// Caption box width, as a 0-1 fraction of the frame width, centered
    /// on `x`. Controls where text wraps — a wider box fits more text on
    /// one line. Defaulted (rather than required) so a request that omits
    /// it — an older client, a hand-built request — still deserializes.
    #[serde(default = "default_caption_width")]
    pub width: f64,
    /// `None` = no outline (optional, per user request — not every
    /// caption should be forced to have one). `#[serde(default)]` so a
    /// missing key means "no outline" rather than a deserialize error.
    #[serde(default)]
    pub outline_color: Option<String>,
    /// Multiplier applied to the (already font-size-corrected) ASS font
    /// size to get the pixel distance between line centers, for captions
    /// with more than one line (split on literal newlines in `text`).
    /// User-requested: ASS/libass has no native line-spacing control
    /// independent of font size (verified directly — `\fscy` scales both
    /// together, no combination decouples them), so multi-line captions
    /// render each line as its own positioned Dialogue event instead of
    /// relying on libass's fixed automatic line pitch, which measured at
    /// roughly a 1.0 multiplier here — and which is exactly what the user
    /// asked to have reduced, so `0.65` is the new default rather than a
    /// value that reproduces the old (complained-about) spacing.
    #[serde(default = "default_line_height")]
    pub line_height: f64,
}

fn default_caption_width() -> f64 {
    0.6
}

fn default_line_height() -> f64 {
    0.65
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionAlign {
    Left,
    Center,
    Right,
}

/// POST /api/exports body per SPEC.md §5 — snake_case top level (matching
/// the `gifs` table columns), camelCase `captions` (matching §4).
#[derive(Debug, Deserialize)]
pub struct ExportRequest {
    pub video_id: String,
    pub name: String,
    /// SPEC.md §12's "Create template" checkbox — must be handled inside
    /// the same export request as the video's own automatic cleanup
    /// below (SPEC-CLOUD.md §6: a video not used for a template doesn't
    /// outlive the gif it was used for). A separate follow-up `PUT
    /// .../template` call from the frontend, made only after this export
    /// completes, would race that cleanup and 404 — the video could
    /// already be gone by the time it arrived. `#[serde(default)]` so
    /// older/other clients that omit it still deserialize as `false`.
    #[serde(default)]
    pub save_as_template: bool,
    pub captions: Vec<Caption>,
    pub gif_range_start: f64,
    pub gif_range_end: f64,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Gif {
    pub id: String,
    pub video_id: Option<String>,
    pub name: String,
    pub caption_text: String,
    pub captions_json: Option<String>,
    /// `None` for a linked GIF (SPEC.md §13) — it has no source clip range.
    pub gif_range_start: Option<f64>,
    pub gif_range_end: Option<f64>,
    /// `None` for a linked GIF — not dimension-probed; the frontend sizes
    /// its thumbnail from the live image's natural dimensions instead.
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// Non-`None` marks a linked GIF: hotlinked to a third-party URL,
    /// never downloaded or re-hosted on R2 (SPEC.md §13).
    pub external_url: Option<String>,
    pub created_at: String,
    /// A GIF unlikely to be reused, per the user — toggled via `PATCH
    /// /api/gifs/{id}`, sorts to the bottom of the archive (SPEC.md §8).
    pub is_one_off: bool,
    /// Opted into the global library and the creator's public profile
    /// (SPEC-CLOUD.md §4/§8) — toggled via the same `PATCH /api/gifs/{id}`.
    pub is_public: bool,
    /// Bumped by `POST /api/gifs/{id}/use` (SPEC-CLOUD.md §8) every time a
    /// copy-link/copy-embed/download action fires — no dedup, auth only.
    pub use_count: i64,
}

impl Gif {
    /// SPEC.md §13: whether this is a linked GIF — hotlinked to a
    /// third-party URL, with no R2 objects of its own to derive/clean up.
    pub fn is_linked(&self) -> bool {
        self.external_url.is_some()
    }
}

/// `GET /api/library?sort=` (SPEC-CLOUD.md §8) — `Newest` was the only
/// option before M5c made `use_count` non-trivial.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LibrarySort {
    #[default]
    Newest,
    MostUsed,
}

/// A public gif plus its creator's handle (SPEC-CLOUD.md §8) — the same
/// "extend the base row with a joined column" shape `VideoListItem` uses
/// for `has_template`, kept separate from `Gif` since attribution is only
/// ever needed for the cross-user global-library query, not the far more
/// common owner-scoped one.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PublicGif {
    pub id: String,
    pub video_id: Option<String>,
    pub name: String,
    pub caption_text: String,
    pub captions_json: Option<String>,
    pub gif_range_start: Option<f64>,
    pub gif_range_end: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub external_url: Option<String>,
    pub created_at: String,
    pub is_one_off: bool,
    pub is_public: bool,
    pub use_count: i64,
    pub owner_handle: Option<String>,
    pub owner_slug: Option<String>,
}

impl From<PublicGif> for Gif {
    fn from(g: PublicGif) -> Self {
        Self {
            id: g.id,
            video_id: g.video_id,
            name: g.name,
            caption_text: g.caption_text,
            captions_json: g.captions_json,
            gif_range_start: g.gif_range_start,
            gif_range_end: g.gif_range_end,
            width: g.width,
            height: g.height,
            external_url: g.external_url,
            created_at: g.created_at,
            is_one_off: g.is_one_off,
            is_public: g.is_public,
            use_count: g.use_count,
        }
    }
}

/// A template's full row (SPEC-CLOUD.md §4, now private-to-creator-only —
/// the sharing layer 0008/0010 added and then removed) — deliberately not
/// `Serialize`: `payload_json` is a raw serialized string, never meant to
/// reach a client as-is (see `TemplatePayload`, which every route response
/// actually returns). Used internally wherever a template needs looking up
/// by its own id rather than by its owning video.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Template {
    pub id: String,
    pub video_id: Option<String>,
    pub user_id: String,
    pub payload_json: String,
    pub saved_at: String,
}

/// `GET /api/admin/users` row (SPEC-CLOUD.md §7): a user plus the
/// per-user usage stats admins need to spot the heaviest users ahead of
/// ever needing quotas — `gif_count`/`latest_gif_at` come from a join,
/// same "extend the base row" shape `VideoListItem`/`PublicGif` use.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AdminUserView {
    pub id: String,
    pub handle: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub role: String,
    pub disabled: bool,
    pub created_at: String,
    pub gif_count: i64,
    pub latest_gif_at: Option<String>,
}

/// `GET /api/admin/users/{id}/templates` row (SPEC-CLOUD.md §7) — a lean,
/// `payload_json`-free view for an admin browsing/moderating someone
/// else's templates (trust & safety, independent of the sharing layer
/// that used to sit on top of this — templates are private-to-creator
/// now, but an admin can still see and remove any user's content).
#[derive(Debug, Clone, Serialize)]
pub struct AdminTemplateView {
    pub id: String,
    pub video_id: Option<String>,
    pub saved_at: String,
}

impl From<Template> for AdminTemplateView {
    fn from(t: Template) -> Self {
        Self {
            id: t.id,
            video_id: t.video_id,
            saved_at: t.saved_at,
        }
    }
}

/// SPEC-CLOUD.md §2: a user's row is created on first login, independent
/// of which provider identity created it (see `Identity`).
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub handle: Option<String>,
    /// Persisted, collision-resistant lowercase URL slug (migration
    /// 0012) — computed once at handle-set time (`db::set_handle`), not
    /// derived on the fly. Only meaningful once `handle` is set; the two
    /// are always written together.
    pub slug: Option<String>,
    pub role: String,
    pub created_at: String,
    /// Refreshed from the OAuth payload on every login — not part of
    /// SPEC-CLOUD.md §2's original `users` table, added alongside
    /// `avatar_url` once it became clear neither was captured anywhere
    /// (see `0003_user_profile_fields.sql`).
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    /// SPEC-CLOUD.md §5: captured from the Google OAuth payload's `name`
    /// field to seed the handle picker's suggested slug — not itself
    /// shown anywhere.
    pub display_name: Option<String>,
    /// SPEC-CLOUD.md §7: an admin-disabled account. Blocks further login
    /// (checked in `routes::auth::callback`) — the actual session
    /// revocation is a separate step (`db::delete_sessions_for_user`),
    /// not derived from this flag on every request.
    pub disabled: bool,
}

/// The shape of `GET /api/auth/me` — deliberately narrower than the full
/// `User` row (no need to leak internal fields the frontend doesn't use
/// yet), and the point at which a client learns its own `role` for
/// admin-gating later (SPEC-CLOUD.md §7). `suggested_handle` is computed,
/// not stored — only meaningful while `handle` is still `None`, see
/// `routes::auth::me`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentUserView {
    pub id: String,
    pub handle: Option<String>,
    /// The real, possibly-suffixed slug (migration 0012) — the frontend
    /// must use this for building `/u/{slug}` links rather than deriving
    /// one from `handle` itself, since a collision suffix makes the two
    /// divergeable (e.g. handle "Sim_Mc" but slug "sim_mc2").
    pub slug: Option<String>,
    pub role: String,
    pub avatar_url: Option<String>,
    pub suggested_handle: Option<String>,
}

impl From<User> for CurrentUserView {
    fn from(user: User) -> Self {
        let suggested_handle = user
            .handle
            .is_none()
            .then(|| user.display_name.as_deref().map(crate::handle::slugify))
            .flatten();
        Self {
            id: user.id,
            handle: user.handle,
            slug: user.slug,
            role: user.role,
            avatar_url: user.avatar_url,
            suggested_handle,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub created_at: String,
    pub last_active_at: String,
}

/// The subset of Google's OIDC `userinfo` response this app actually uses.
#[derive(Debug, Clone, Deserialize)]
pub struct GoogleUserInfo {
    pub sub: String,
    pub email: Option<String>,
    pub picture: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GoogleTokenResponse {
    pub access_token: String,
}

pub struct NewGif {
    pub id: String,
    pub video_id: Option<String>,
    pub name: String,
    pub caption_text: String,
    pub captions_json: Option<String>,
    pub gif_range_start: Option<f64>,
    pub gif_range_end: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub external_url: Option<String>,
    pub user_id: String,
}
