use serde::{Deserialize, Serialize};

/// `duration_seconds`/`width`/`height` are `None` until the ingest
/// Lambda's "analyzing" callback backfills them (wayfinder gifiac#32) —
/// probing moved off the synchronous upload request, so a video row can
/// now exist before they're known.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Video {
    pub id: String,
    pub original_filename: String,
    pub extension: String,
    pub file_size_bytes: i64,
    pub duration_seconds: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub uploaded_at: String,
}

pub struct NewVideo {
    pub id: String,
    pub original_filename: String,
    pub extension: String,
    pub file_size_bytes: i64,
    pub duration_seconds: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
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
    pub duration_seconds: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
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

/// `PUT /api/videos/{id}/template` body — a thin wrapper adding the two
/// real-column fields (`name`, `is_public`) that live outside
/// `TemplatePayload` itself (see that type's doc comment) alongside the
/// unchanged payload content, so this stays a single request body rather
/// than two separate calls.
#[derive(Debug, Deserialize)]
pub struct PutTemplateRequest {
    pub name: String,
    #[serde(default)]
    pub is_public: bool,
    #[serde(flatten)]
    pub payload: TemplatePayload,
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
    /// roughly a 1.0 multiplier here.
    #[serde(default = "default_line_height")]
    pub line_height: f64,
}

fn default_caption_width() -> f64 {
    0.6
}

fn default_line_height() -> f64 {
    1.1
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
/// Also `Clone`/`Serialize` so a `create_export` request can be stashed
/// verbatim into `export_jobs.request_json` (wayfinder gifiac#32) and
/// read back once the job's Lambda callbacks all land.
#[derive(Debug, Clone, Deserialize, Serialize)]
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
    /// Required (validated in `routes::exports::create_export`) whenever
    /// `save_as_template` is true — the "Template name" field revealed by
    /// the Make GIF modal's "Also save as a template" checkbox. `None`
    /// otherwise; not part of `TemplatePayload` itself (see that type's
    /// doc comment) since it's a real `templates.name` column, not
    /// payload content.
    #[serde(default)]
    pub template_name: Option<String>,
    /// The "Public template" toggle in the same modal section — only
    /// meaningful alongside `save_as_template`. Defaults `false` so an
    /// export that isn't saving a template at all doesn't need to specify
    /// it either way.
    #[serde(default)]
    pub template_is_public: bool,
    pub captions: Vec<Caption>,
    pub gif_range_start: f64,
    pub gif_range_end: f64,
}

/// The Archive's four filter chips (All/Public/Private/Hidden) each need
/// their own total — computed server-side in one conditional-aggregation
/// query (`db::gif_filter_counts`) rather than client-side over however
/// much of the paginated list happens to be loaded, which undercounts
/// once there's more than one page.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct GifFilterCounts {
    pub all: i64,
    pub public: i64,
    pub private: i64,
    pub hidden: i64,
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
    /// `None` for every non-linked gif (mp4/webm cover the "static frame"
    /// need there). For a linked gif: `pending` until the background
    /// thumbnail job (or backfill CLI) has attempted it, then `ready` or
    /// `failed` — see `0015_gif_thumbnails.sql`.
    pub thumbnail_status: Option<String>,
    /// Lineage to the template this gif was exported from via flow B
    /// ("start from a template") — `None` for a gif exported from a video
    /// directly (flow A), even when that video happens to have its own
    /// saved template. Drives the "Remix this GIF" button; never shown to
    /// other users as attribution.
    pub template_id: Option<String>,
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
    pub thumbnail_status: Option<String>,
    pub template_id: Option<String>,
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
            thumbnail_status: g.thumbnail_status,
            template_id: g.template_id,
        }
    }
}

/// A template's full row (SPEC-CLOUD.md §4 — public templates, second
/// attempt: narrower than the sharing layer 0008 added and 0010 removed,
/// see `0016_public_templates.sql`) — deliberately not `Serialize`:
/// `payload_json` is a raw serialized string, never meant to reach a
/// client as-is (see `TemplatePayload`/`TemplateSummary`/`TemplateDetail`,
/// which every route response actually returns). Used internally wherever
/// a template needs looking up by its own id rather than by its owning
/// video.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Template {
    pub id: String,
    pub video_id: Option<String>,
    pub user_id: String,
    pub name: String,
    pub is_public: bool,
    pub payload_json: String,
    pub saved_at: String,
}

/// `GET /api/templates/mine` and `/others` row shape — the New GIF page's
/// template grid. `duration_seconds`/`caption_count` are derived from
/// `payload_json` in Rust (it's opaque JSON text, not `jsonb`, so this
/// can't be computed in SQL) — see `db::template_summary_from_row`.
/// `owner_handle` is `None` on "mine" (no attribution needed for your own
/// templates) and `Some` on "others" (plain-text-only, per the design: no
/// link, no profile page).
#[derive(Debug, Clone, Serialize)]
pub struct TemplateSummary {
    pub id: String,
    pub name: String,
    pub is_public: bool,
    pub saved_at: String,
    pub duration_seconds: f64,
    pub caption_count: usize,
    /// The first caption's text (trimmed), if any — the New GIF page's
    /// tile overlays this on the thumbnail in the caption style, so a
    /// browsing user can tell templates apart without opening each one.
    pub first_caption_text: Option<String>,
    pub owner_handle: Option<String>,
}

/// `GET /api/templates/{id}` — the full detail a flow-B editor needs:
/// everything `TemplateSummary` has, plus the actual captions/dimensions
/// to seed the editor with. Trim range is deliberately *not* included as
/// editable state — the frontend derives its locked `[0, duration]`
/// timeline from `duration_seconds` alone, never from a range the user
/// could plausibly mutate.
#[derive(Debug, Clone, Serialize)]
pub struct TemplateDetail {
    pub id: String,
    pub name: String,
    pub is_public: bool,
    pub saved_at: String,
    pub duration_seconds: f64,
    pub width: i64,
    pub height: i64,
    pub captions: Vec<Caption>,
    pub owner_handle: Option<String>,
    /// Whether the current viewer is the template's creator — the New GIF
    /// page's detail pane uses this to decide whether to render the
    /// pencil-rename/public-toggle/delete owner controls at all, rather
    /// than relying on a 403 from those routes to hide them after the fact.
    pub is_own: bool,
}

/// `POST /api/templates/{id}/exports` body — deliberately has no trim
/// range, width, or height fields. Those are always locked to the
/// template's own saved values, read server-side from the `templates` row
/// itself (see `routes::templates::create_export`) — there is nothing for
/// a client to spoof because the type doesn't carry those fields at all.
/// Also `Clone`/`Serialize` — see `ExportRequest`'s matching doc comment.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TemplateExportRequest {
    pub name: String,
    pub captions: Vec<Caption>,
}

/// `PATCH /api/templates/{id}` body — same "independently optional
/// fields, at least one required" shape as `PatchGifRequest`
/// (`routes/gifs.rs`). Deliberately lightweight: renaming or flipping
/// public/private never touches `payload_json`, the trim range, or the
/// clip/thumbnail/filmstrip assets — no re-trim/re-save required.
#[derive(Debug, Deserialize)]
pub struct PatchTemplateRequest {
    pub name: Option<String>,
    pub is_public: Option<bool>,
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

/// `GET /api/admin/actions` row — a minimal, generic audit-trail entry
/// (see migration `0020_admin_actions.sql`). `details` stays a raw JSON
/// string rather than a typed field since different `action_type`s will
/// want different shapes; the admin UI just displays it as-is.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct AdminActionView {
    pub id: String,
    pub admin_user_id: String,
    pub action_type: String,
    pub target_id: String,
    pub details: String,
    pub created_at: String,
}

/// `GET /api/admin/users/{id}/templates` row (SPEC-CLOUD.md §7) — a lean,
/// `payload_json`-free view for an admin browsing/moderating someone
/// else's templates (trust & safety) — an admin can see and remove any
/// user's content regardless of its own public/private flag.
#[derive(Debug, Clone, Serialize)]
pub struct AdminTemplateView {
    pub id: String,
    pub video_id: Option<String>,
    pub name: String,
    pub is_public: bool,
    pub saved_at: String,
}

impl From<Template> for AdminTemplateView {
    fn from(t: Template) -> Self {
        Self {
            id: t.id,
            video_id: t.video_id,
            name: t.name,
            is_public: t.is_public,
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
    /// field to seed the handle picker's suggested slug. Also shown on
    /// the public profile header in place of the handle, when set.
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
    /// Bundled onto the current-user payload rather than fetched
    /// separately (see PreferencesView) — every place that already calls
    /// `GET /api/auth/me` (e.g. a gif grid deciding whether to render
    /// hover-preview mode) gets it for free, no second round-trip.
    pub preferences: PreferencesView,
}

impl CurrentUserView {
    pub fn from_user_and_preferences(user: User, preferences: PreferencesView) -> Self {
        // Google signups get a suggested slug from `display_name`; email
        // signups have none, so fall back to the address's local part
        // (SPEC-EMAIL-AUTH.md §4) — everything before `@`, slugified the
        // same way.
        let suggested_handle = user.handle.is_none().then(|| {
            user.display_name
                .as_deref()
                .or_else(|| user.email.as_deref().and_then(|e| e.split('@').next()))
                .map(crate::handle::slugify)
        }).flatten();
        Self {
            id: user.id,
            handle: user.handle,
            slug: user.slug,
            role: user.role,
            avatar_url: user.avatar_url,
            suggested_handle,
            preferences,
        }
    }
}

/// A user's preferences (the new Preferences page) — `disable_gif_autoplay`
/// is the first option: stop gifs looping unsolicited in grid/library
/// views (the detail pane always loops regardless, see the frontend). A
/// user who's never saved a preference has no `user_preferences` row at
/// all; `PreferencesView::default()` (all off) is what they read as.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesView {
    pub disable_gif_autoplay: bool,
}

/// `PUT /api/preferences` body — every field optional so a client can
/// update just the one preference it has UI for without needing to know
/// (and resubmit) every other preference that might exist by then.
#[derive(Debug, Deserialize)]
pub struct UpdatePreferencesRequest {
    pub disable_gif_autoplay: Option<bool>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Session {
    pub id: String,
    pub user_id: String,
    pub created_at: String,
    pub last_active_at: String,
}

/// The subset of Google's OIDC `userinfo` response this app actually uses.
/// `email_verified` (SPEC-EMAIL-AUTH.md §5) gates whether `email` is
/// trusted enough to link a Google identity to an email-login account, or
/// vice versa — Google returns it as part of the standard OIDC claim set.
#[derive(Debug, Clone, Deserialize)]
pub struct GoogleUserInfo {
    pub sub: String,
    pub email: Option<String>,
    #[serde(default)]
    pub email_verified: bool,
    pub picture: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GoogleTokenResponse {
    pub access_token: String,
}

/// `POST /api/auth/email/start` body (SPEC-EMAIL-AUTH.md §4).
/// `turnstile_token` is optional so a request from a dev environment with
/// no Turnstile site key configured (nothing for the frontend to render a
/// widget against) still deserializes — `email_auth::EmailAuthConfig`
/// decides whether a missing token is actually an error. Needs
/// `rename_all`, unlike `EmailVerifyRequest` below (whose fields are
/// single words, so camelCase and snake_case happen to coincide): without
/// it, the frontend's `turnstileToken` JSON key never matches this
/// struct's `turnstile_token` field, and `#[serde(default)]` silently
/// swallows the mismatch into `None` instead of a deserialization error —
/// so every request looked like a legitimately missing token.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailStartRequest {
    pub email: String,
    #[serde(default)]
    pub turnstile_token: Option<String>,
}

/// `POST /api/auth/email/verify` body.
#[derive(Debug, Deserialize)]
pub struct EmailVerifyRequest {
    pub email: String,
    pub code: String,
}

/// A `login_codes` row (SPEC-EMAIL-AUTH.md §2).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LoginCode {
    pub id: String,
    pub email: String,
    pub code_hash: String,
    pub attempts: i32,
    pub request_ip: String,
    pub created_at: String,
    pub expires_at: String,
    pub consumed_at: Option<String>,
}

/// `GET /api/config` — the small set of public, non-secret runtime values
/// the frontend needs before it's signed in (SPEC-EMAIL-AUTH.md §6/§9).
/// Deliberately minimal: add a field here only when the frontend actually
/// needs another one, not as a general settings bag.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub turnstile_site_key: Option<String>,
    /// The Import GIFs modal's size ceiling for a single GIF (linked or
    /// uploaded) — served at runtime rather than duplicated as a frontend
    /// constant, so the two can never drift (see `crate::MAX_GIF_BYTES`).
    pub max_gif_bytes: u64,
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
    /// Every creation path except `routes::gifs::link_gif` always passes
    /// `false` here — a link import is the only one where the creator
    /// chooses visibility up front, via the Import GIFs modal's per-row
    /// Public switch, rather than publishing after the fact through `PATCH
    /// /api/gifs/{id}`.
    pub is_public: bool,
    pub user_id: String,
    pub template_id: Option<String>,
}

// --- Lambda ingest/export jobs (wayfinder gifiac#32) ---

/// Tracks the probe+thumbnail+filmstrip pipeline that runs in the ingest
/// Lambda. Stage-only (no percent column) — the 3 stages are coarse
/// enough that a percent bar would be fake precision.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct IngestJob {
    pub id: String,
    pub video_id: String,
    pub stage: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// One row per export, with 3 fixed per-format column triples instead of
/// a child table — simpler reads/writes for a fixed, small set of
/// formats (gif/mp4/webm) not expected to grow casually. No stored
/// overall status: callers derive it (gif failure fails the whole job
/// even if mp4/webm succeeded; mp4/webm otherwise fail independently).
///
/// `request_json` stashes the original export request (video/template,
/// captions, owner, save-as-template flag) so the callback handler that
/// finalizes the job once all 3 formats go terminal has what it needs,
/// surviving a backend restart mid-export.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct ExportJob {
    pub id: String,
    pub request_json: String,
    pub gif_status: String,
    pub gif_percent: i32,
    pub gif_error: Option<String>,
    pub mp4_status: String,
    pub mp4_percent: i32,
    pub mp4_error: Option<String>,
    pub webm_status: String,
    pub webm_percent: i32,
    pub webm_error: Option<String>,
    /// The gif output's actual post-scale dimensions, reported by the
    /// export Lambda's "done" callback — `None` until that callback
    /// arrives, populated only for the `gif` format.
    pub gif_width: Option<i64>,
    pub gif_height: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

/// Everything `export_jobs.request_json` stashes between `create_export`/
/// `create_template_export` and the callback handler that finalizes the
/// job once all 3 formats go terminal (wayfinder gifiac#32) — enough to
/// rebuild what `run_pipeline`/`run_template_pipeline` used to do inline
/// after a direct, in-process `transcode_and_upload` call returned.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind")]
pub enum ExportJobContext {
    Video {
        video_id: String,
        owner_id: String,
        request: ExportRequest,
    },
    Template {
        template_id: String,
        owner_id: String,
        request: TemplateExportRequest,
    },
}

/// `POST /api/videos` response shape once ingest moved off the
/// synchronous upload path (wayfinder gifiac#32) — 202-style, mirroring
/// export's existing `ExportAccepted` shape. `job_id` is what `GET
/// /api/videos/{job_id}/ingest-progress` subscribes to.
#[derive(Debug, Serialize)]
pub struct UploadAccepted {
    pub video_id: String,
    pub job_id: String,
}

/// Addresses `export_jobs`' 3 per-format column triples generically — the
/// Lambda callback endpoint and the stuck-job sweep both need to update
/// "the format param says gif" without a match arm per format at every
/// call site.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Gif,
    Mp4,
    Webm,
}

impl ExportFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            ExportFormat::Gif => "gif",
            ExportFormat::Mp4 => "mp4",
            ExportFormat::Webm => "webm",
        }
    }
}

impl std::str::FromStr for ExportFormat {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "gif" => Ok(ExportFormat::Gif),
            "mp4" => Ok(ExportFormat::Mp4),
            "webm" => Ok(ExportFormat::Webm),
            other => Err(anyhow::anyhow!("unknown export format: {other}")),
        }
    }
}

/// Named, unordered grouping of gifs (collections-design/COLLECTIONS.md
/// §1), replacing the old flat `favourites` table. Every user has exactly
/// one `kind = "favourites"` row — reserved name, can't be renamed or
/// deleted — plus however many `kind = "custom"` ones they've created.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub kind: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Collection {
    pub fn is_favourites(&self) -> bool {
        self.kind == "favourites"
    }
}

/// `GET /api/collections` row shape — a collection plus how many
/// currently-visible gifs it holds (collections-design/COLLECTIONS.md §2:
/// "Counts include only GIFs the user can currently view").
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct CollectionWithCount {
    #[serde(flatten)]
    #[sqlx(flatten)]
    pub collection: Collection,
    pub gif_count: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression test for a real production bug: without `rename_all =
    // "camelCase"` on EmailStartRequest, this camelCase body (exactly
    // what the frontend sends) silently deserialized turnstile_token as
    // None via #[serde(default)] instead of failing loudly — every
    // real request looked like it was missing its Turnstile token.
    #[test]
    fn email_start_request_reads_the_frontends_camel_case_turnstile_token() {
        let body = serde_json::json!({
            "email": "jess@example.com",
            "turnstileToken": "a-real-token",
        });
        let req: EmailStartRequest = serde_json::from_value(body).unwrap();
        assert_eq!(req.turnstile_token.as_deref(), Some("a-real-token"));
    }
}
