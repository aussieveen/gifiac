Type: grilling
Status: resolved
Blocked by: 03
Assignee: claude (this session)

## Question

How does the FFmpeg export pipeline work? Given the caption data structure settled in ticket 03, how does the Rust backend burn captions into the video, generate a GIF (palette optimisation, frame rate, dimensions), generate a silent-loop MP4/WebM, and upload the results to S3? Settle: the FFmpeg filter graph for caption rendering and GIF palette, the S3 key naming convention, progress feedback mechanism to the frontend (SSE or WebSocket), and what the API returns when export completes (S3 URLs, metadata to persist to SQLite).

## Answer

**Caption burn-in**: the Rust backend serializes the caption array (from [Caption editor UX](03-caption-editor-ux.md)) into an ASS subtitle file — start/end/text map to ASS timing, font/size/color/align/x,y map to an ASS style plus `\pos()` override tags — then burns it in with FFmpeg's `subtitles=` (libass) filter. One filter regardless of how many captions, no chained `drawtext` per caption.

**GIF encoding**: standard two-pass `palettegen` → `paletteuse`. Provisional caps: **15fps, max width 480px** (scale down only, never up), full 256-color adaptive palette with Bayer dithering. These are flagged as tunable constants, not hardcoded magic numbers — expected to be revisited once real exported output has been reviewed.

**Outputs**: a single export job always produces **all three formats together** (GIF + MP4 + WebM), sharing one `export_id` (UUID v4). S3 keys, flat under a type prefix:
- `gifs/{export_id}.gif`
- `clips/{export_id}.mp4`
- `clips/{export_id}.webm`

(Bucket/credentials/public-vs-presigned-URL policy is the [S3 integration design](07-s3-integration-design.md) ticket's call — this only fixes the key naming.)

**Progress feedback**: SSE, confirming the Axum choice from [Rust framework selection](01-rust-framework-selection.md). Endpoint: `GET /api/exports/{export_id}/progress`. Events are **per-stage**, not one blended percentage: each event names the current stage (`palette_gen`, `encoding_gif`, `encoding_mp4`, `encoding_webm`, `uploading`) plus that stage's own 0-100%, driven off FFmpeg's `-progress` output per invocation.

**GIFs are re-editable, not one-way.** A `gifs` SQLite table persists the *structured* caption array (not just baked text), so an archive entry can be reopened in the caption editor and re-exported:

- `id` TEXT (UUID, PK — the export_id)
- `video_id` TEXT (FK → `videos`)
- `caption_text` TEXT — concatenated caption text, for archive search
- `captions_json` TEXT — full structured caption array, for re-editing
- `gif_range_start` / `gif_range_end` REAL
- `width` / `height` INTEGER — post-scaling output dimensions
- `created_at` TEXT (ISO8601)

S3 key/URL columns are deliberately omitted — added once [S3 integration design](07-s3-integration-design.md) settles the URL/access-policy question, so this table isn't restated there.

**Addendum (from [API surface design](05-api-surface-design.md))**: the `gifs` table also gains a required `name` TEXT column. Archive search is "name + caption-text" per the map, and a source video can be reused across multiple GIFs (same clip, different caption jokes) — a name derived from the source video's filename wouldn't distinguish them, so an explicit, user-editable per-GIF name is needed instead.
