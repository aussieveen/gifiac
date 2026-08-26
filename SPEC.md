# Gifiac — Specification

A self-hosted GIF/clip creation and archival tool. Upload a video, scrub to a moment, caption it Frinkiac-style, export as a GIF/MP4/WebM, and keep a searchable archive of everything you've made — plus bulk-import GIFs you already have from elsewhere (e.g. Giphy).

Single-user, no authentication. Deployed as one Docker container on Unraid.

This document is the complete build spec, assembled from a structured decision process (see `.scratch/gifiac/map.md` and its ten resolved tickets for the full reasoning behind each choice, plus two interactive prototypes under `.scratch/gifiac/prototypes/`).

---

## 1. Architecture

- **Backend**: Rust, [Axum](https://github.com/tokio-rs/axum) 0.8, `ffmpeg-next` for native FFmpeg bindings.
- **Frontend**: React + TypeScript, built to static files and served by the same Axum binary (`tower-http::ServeDir`/`ServeFile`) for anything outside `/api/...`. **One container, one process** — no separate frontend service.
- **Metadata DB**: SQLite.
- **Source video storage**: local disk (Unraid share), never uploaded to S3.
- **Finished output storage**: Cloudflare R2 (S3-compatible object storage), public-read.
- **Deployment**: single Docker image, `debian:bookworm-slim` base (not Alpine/musl — `ffmpeg-sys-next` needs system FFmpeg libs at runtime), built with `cargo-chef`. Typical image size ~200–400MB, dominated by FFmpeg.

**Why Axum over Actix-Web**: SSE (needed for FFmpeg progress streaming) is first-class in Axum's core (`axum::response::sse::Sse`); Actix-Web needs the unofficial `actix-web-lab` crate for the same thing. Both handle multipart uploads and WebSocket fine — SSE support was the deciding factor.

**Cargo starters**: `axum = { version = "0.8", features = ["multipart", "ws"] }`, `tokio-stream`, `tower-http`, `ffmpeg-next = "9"`, `aws-sdk-s3`, `sqlx` (or equivalent) for SQLite.

---

## 2. Data model (SQLite)

### `videos`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | PK, UUID v4 |
| `original_filename` | TEXT | as uploaded, display only |
| `extension` | TEXT | e.g. `mp4`, `mov` |
| `file_size_bytes` | INTEGER | |
| `duration_seconds` | REAL | probed via FFmpeg |
| `width` | INTEGER | probed via FFmpeg |
| `height` | INTEGER | probed via FFmpeg |
| `uploaded_at` | TEXT | ISO8601 |

No status column, no stored file-path column. A row is only inserted once FFmpeg probing succeeds synchronously in the upload request — there's no "pending" state to track. The on-disk video path and thumbnail path are always **derived** from `id` + `extension`, never stored redundantly:
- Video file: `{GIFIAC_VIDEO_DIR}/{id}.{extension}`
- Poster thumbnail: `{GIFIAC_VIDEO_DIR}/{id}_thumb.jpg`

### `gifs`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT | PK, UUID v4 (same as the export/import id) |
| `video_id` | TEXT | FK → `videos.id`, **nullable** (NULL for imported and linked GIFs with no source video) |
| `name` | TEXT | required; user-editable title |
| `caption_text` | TEXT | concatenated caption text, for archive search (empty for imports and linked GIFs) |
| `captions_json` | TEXT | full structured caption array, **nullable** (NULL for imports and linked GIFs); used to reopen the GIF in the caption editor for re-editing |
| `gif_range_start` | REAL | seconds, source-clip in-point, **nullable** (NULL for linked GIFs) |
| `gif_range_end` | REAL | seconds, source-clip out-point, **nullable** (NULL for linked GIFs) |
| `width` | INTEGER | post-scaling output dimensions, **nullable** (NULL for linked GIFs — not probed; the frontend sizes the thumbnail from the live image's natural dimensions) |
| `height` | INTEGER | **nullable**, same as `width` |
| `external_url` | TEXT | **nullable**; non-NULL marks a **linked GIF** — hotlinked to a third-party URL, never downloaded or re-hosted on R2 (see §13). Drives the "external" badge in the archive. |
| `created_at` | TEXT | ISO8601 |

No S3 key/URL columns for GIFs created or imported natively. Output file locations are **always derived** from `id` (see §6):
- `{R2_PUBLIC_BASE_URL}/gifs/{id}.gif`
- `{R2_PUBLIC_BASE_URL}/clips/{id}.mp4`
- `{R2_PUBLIC_BASE_URL}/clips/{id}.webm`

**Exception**: a linked GIF (`external_url` set) has no R2 objects at all — its public location *is* `external_url` itself, and only the GIF format exists (see §13).

**Design principle used throughout**: never store a path/URL that's mechanically derivable from an id plus a known convention/env var. This means switching the video storage root or the R2 public base URL later is a config change, never a data migration.

**GIFs are re-editable, not one-way.** Because `captions_json` persists the full structured caption array (not just baked/burned text), any archive entry with a non-null `video_id` can be reopened in the caption editor, edited, and re-exported.

---

## 3. Video ingest

- **Upload**: browser only — both drag-and-drop and a file picker feed the same handler. Single multipart POST (`axum::extract::Multipart`), streamed straight to disk, no buffering, no chunked/resumable upload (single-user LAN tool, not worth the complexity).
- **Storage**: root at `{GIFIAC_VIDEO_DIR}` (default `/data/videos`), flat directory (no sharding — expected scale is hundreds/low-thousands of videos). File named `{video_id}.{extension}`; the user-supplied filename is never trusted as a path, only kept for display as `original_filename`.
- **Probing**: FFmpeg probing (duration/width/height) happens **synchronously** in the upload request handler. The `videos` row is only inserted once probing succeeds.
- **Thumbnail**: one poster frame generated synchronously at upload time (`ffmpeg -ss 1 -frames:v 1`), stored at `{id}_thumb.jpg`.
- **Film-strip** (for the caption editor's scrubber): **generated on-demand**, not at upload. Density: one thumbnail every 0.25s, delivered as a single sprite-sheet image (one FFmpeg `tile` filter invocation, one HTTP request) rather than individual per-frame images — trivially cacheable, avoids the frontend firing dozens of parallel requests.
- **No video deletion endpoint.** Deleting a source video would silently break re-editing of any GIF made from it. Source videos are permanent via the API; manual disk cleanup on Unraid is the only path if ever needed.

---

## 4. Caption editor (frontend)

Frinkiac-style visual timeline editor. Reference prototype: `.scratch/gifiac/prototypes/caption-editor/` (Variant A won; run `npm install && npm run dev` inside that directory to see it live).

**Layout**: one editor mode only (no Simple/Advanced toggle).
- **Live preview** (top-left): shows the current frame with active captions overlaid.
- **Style panel** (top-right): edits whichever caption is currently selected — multi-line text box, font-family dropdown, size slider, color swatch, left/center/right alignment buttons, an "All tracks" checkbox to apply the current style to every caption at once.
- **Timeline lanes**: one draggable/resizable track row per caption below the preview. Drag the pill body to move it in time; drag its left/right edges to resize. A `+` button adds a new caption at the current playhead; a red `✕` deletes a track.
- **Film-strip scrubber** (bottom): click/drag moves the playhead. A separate yellow-highlighted, drag-handled range on the same strip sets the GIF export in/out points, independent of caption timing. Zoom in/out controls adjust density.
- **Position**: captions are draggable directly on the live preview to set `x`/`y` — defaults to bottom-center on creation.
- **Make GIF**: a prominent button in the controls row beside the film-strip; requires a non-empty `name` (see §5, `POST /api/exports`).

**Caption data structure** (produced by the editor, consumed by the export pipeline and the API):

```json
{
  "id": "string",
  "startTime": 0.5,
  "endTime": 2.5,
  "text": "Just testing.",
  "fontFamily": "Impact, sans-serif",
  "fontSize": 28,
  "color": "#ffffff",
  "align": "center",
  "x": 0.5,
  "y": 0.88
}
```

`startTime`/`endTime` are seconds relative to the source clip; `x`/`y` are 0–1 fractional position within the frame.

---

## 5. REST API

Base path: `/api/...`, **no version segment** — one deployable, frontend and backend always built and shipped together, so there's no independent-client-versioning concern. **No auth** on any endpoint (single-user).

### Videos

| Method + path | Purpose |
|---|---|
| `POST /api/videos` | Upload (multipart) → full `videos` row once probing succeeds |
| `GET /api/videos` | List, newest first |
| `GET /api/videos/{id}` | Get one |
| `GET /api/videos/{id}/thumbnail` | Poster image |
| `GET /api/videos/{id}/filmstrip` | JSON: `{frameCount, cols, rows, frameWidth, frameHeight, interval, imageUrl}` |
| `GET /api/videos/{id}/filmstrip.jpg` | The sprite image itself |

No `DELETE /api/videos/{id}` — see §3.

### Exports

| Method + path | Purpose |
|---|---|
| `POST /api/exports` | body: `{video_id, name, captions, gif_range_start, gif_range_end}` (`name` required, no default) → `202 Accepted` `{export_id}`; kicks off the FFmpeg pipeline as a background job |
| `GET /api/exports/{export_id}/progress` | SSE, per-stage events. Final event (`event: complete`) carries the full completed `gifs` row, then the stream closes — no separate polling endpoint needed |

### Archive (GIFs)

| Method + path | Purpose |
|---|---|
| `GET /api/gifs?q={query}` | list/search — `q` matches `name` and `caption_text` together; omitted `q` returns everything, newest first. No pagination for v1. |
| `GET /api/gifs/{id}` | single GIF, including `captions_json`, for viewing or re-editing |
| `PATCH /api/gifs/{id}` | body `{name}` — rename without a full re-export. `external_url` is not editable — to fix a wrong or moved link, delete and re-add (see §13). |
| `DELETE /api/gifs/{id}` | removes the SQLite row **and** its R2 objects (all three formats) — for a linked GIF (`external_url` set) there are no R2 objects, so only the row is removed |

### Bulk import

| Method + path | Purpose |
|---|---|
| `POST /api/gifs/import` | multipart, **multiple files** in one request → array of created `gifs` rows. See §7. |

(Endpoint path/shape for bulk import wasn't pinned to an exact contract during wayfinding beyond "reuse the video-upload multipart pattern, multi-file, array response" — finalize the exact request/response field names during implementation, consistent with the `POST /api/videos` precedent.)

### Link import

| Method + path | Purpose |
|---|---|
| `POST /api/gifs/link` | JSON body `{url, name}` → creates a single `gifs` row with `external_url` set (no file body, no multipart). See §13. |

Deliberately a separate endpoint from `POST /api/gifs/import`: that endpoint is multipart/multi-file with a transcode pipeline behind it; this one is a single JSON object with a lightweight validation check and no processing pipeline at all.

---

## 6. Export pipeline (FFmpeg)

- **Caption burn-in**: the caption array is serialized into an **ASS subtitle file** — start/end/text map to ASS timing; font/size/color/align/x,y map to an ASS style plus `\pos()` override tags. Burned in with FFmpeg's `subtitles=` (libass) filter — one filter regardless of caption count, no chained `drawtext` per caption.
- **GIF encoding**: standard two-pass `palettegen` → `paletteuse`. Provisional caps: **15fps, max width 480px** (scale down only, never up), full 256-color adaptive palette with Bayer dithering. **These are tunable constants, not hardcoded values** — expected to be revisited once real exported output has been reviewed.
- **Outputs**: a single export job always produces **all three formats together** — GIF + MP4 + silent-loop WebM — sharing one `export_id` (UUID v4).
- **Progress feedback**: SSE, per-stage events. Stages: `palette_gen`, `encoding_gif`, `encoding_mp4`, `encoding_webm`, `uploading` — each with its own 0–100%, driven off FFmpeg's `-progress` output per invocation.
- **R2 key naming**, sharing the export's UUID:
  - `gifs/{id}.gif`
  - `clips/{id}.mp4`
  - `clips/{id}.webm`

---

## 7. Bulk import (Giphy and other sources)

**Not a live Giphy API integration.** Feasibility research (`.scratch/gifiac/assets/09-giphy-import-feasibility.md`) found the Giphy API technically capable of enumerating a user's own uploads (`q=@username` search, no OAuth needed) and exposing direct GIF+MP4 download URLs — but Giphy's API Terms of Service prohibit caching/storing API-obtained media without partner approval and forbid using API content to build "a database, directory, or index containing GIFs," with no carve-out for the requesting user's own uploads. Rather than accept that ambiguous ToS risk, the decision was to sidestep the API entirely: **the user manually downloads GIFs** (via Giphy's own website, or any other source) to their machine first.

This makes bulk import a generic feature, not Giphy-specific. (Note: this section covers *file-based* import, where the GIF is uploaded and re-hosted on R2 — fully owned, no archive badge. For adding a GIF by pasting a URL without downloading it, see §13, URL-linked GIFs — a distinct feature with its own endpoint.)

- **Mechanism**: bulk browser upload — a multi-file picker/drag-and-drop, reusing the same multipart-POST pattern as video ingest, extended to accept multiple files in one request (`POST /api/gifs/import`) and return an array of created `gifs` rows.
- **Schema**: no new columns (see §2). An imported GIF has `video_id = NULL` and `captions_json = NULL`. `name` defaults to the uploaded filename with its extension stripped, immediately renameable via `PATCH /api/gifs/{id}`. `caption_text` is left empty — archive search falls back to matching `name` only for imported items.
- **Re-edit is unavailable for imports**: the archive UI hides/disables the "edit captions" action whenever `video_id` is null.
- **Format normalization**: imported files (typically GIF-only) are run through the **same FFmpeg transcode step as the export pipeline**, filling in whichever of GIF/MP4/WebM are missing — every `gifs` row ends up with all three formats, whether created in Gifiac or imported.
- **Storage**: identical R2 key convention as exports — a fresh UUID v4 per imported item, `gifs/{id}.gif` / `clips/{id}.mp4` / `clips/{id}.webm`. No separate "imports" namespace; an imported GIF is just a `gifs` row like any other from the API/archive's point of view.

---

## 8. Archive / browse UX

Reference prototype: `.scratch/gifiac/prototypes/archive-browse/` (Variant C won).

**Default landing page.** The archive is what loads first when the app opens — not the video-picker/New-GIF flow — since browsing/finding existing GIFs is the more common action. The New-GIF flow is reached via the persistent nav bar (always shows both "New GIF" and "Archive", regardless of which view is active), so it's never more than one click away.

**Layout: master-detail.** A static thumbnail grid on the left (no hover effects on the grid itself); clicking a thumbnail opens it in a **detail panel** on the right.

**External badge**: a small icon overlay on any grid thumbnail (and in the detail panel) whose GIF is a **linked GIF** (`external_url` set, see §13) — i.e. media that lives outside our controlled R2 and could disappear if the source goes down. File-based imports (§7) do **not** get this badge; once re-hosted on R2 they're fully owned, same as natively-created GIFs.

**Detail panel**:
- Preview thumbnail **auto-plays as soon as a GIF is selected** (not gated behind hover) — restarts when selecting a different item. For a linked GIF, this is simply the live `<img src={external_url}>`.
- Inline-editable `name` field (rename via `PATCH /api/gifs/{id}`, no full re-export needed).
- Caption text, created date.
- Centralized actions: **Copy link** (writes the derived public R2 URL to the clipboard — or, for a linked GIF, the `external_url` itself), **Download**, **Delete**. For a linked GIF, **Download is replaced by Open original** (opens `external_url` in a new tab) — there's no R2-hosted file to serve as a clean download.

**Search**: a single search bar, live-filtering as you type, matching `GET /api/gifs?q={query}` exactly — one combined query against `name` + `caption_text`, no separate name/tag filters.

---

## 9. S3 (R2) integration

- **Provider: Cloudflare R2** (S3-compatible), chosen over the user's existing AWS S3 account specifically for **zero egress fees** — GIFs get repeatedly viewed and re-shared, and that access pattern would accumulate real cost on AWS that R2 avoids.
- **Auth**: `aws-sdk-s3` crate (async, works against R2 via a custom endpoint override — no separate R2 SDK). Credentials read once at startup from env vars, never exposed to the frontend or logged.
- **Bucket policy: public-read**, not presigned. Presigned URLs expire, which conflicts directly with "copy-link" needing to produce a link that works indefinitely once pasted somewhere (Discord, texts, etc).
- **Public base URL**: `R2_PUBLIC_BASE_URL` env var — defaults to R2's `.r2.dev` public dev URL. No custom domain yet; swapping to one later is a config change only, zero data migration (URLs are derived, never stored — see §2).
- **Lifecycle rules**: none. GIFs are a permanent archive (no TTL); deletion is handled directly by `DELETE /api/gifs/{id}`; outputs are small enough that multipart-upload-abort rules aren't a real concern.

---

## 10. Docker deployment

**Single container.** React frontend built to static files at image build time, served by the same Axum binary.

**Volume**: one mount, the standard Unraid appdata pattern.
- Host: `/mnt/user/appdata/gifiac` → Container: `/data`

**Environment variables**:

| Env var | Default |
|---|---|
| `GIFIAC_VIDEO_DIR` | `/data/videos` |
| `GIFIAC_DB_PATH` | `/data/gifiac.db` |
| `R2_ACCOUNT_ID` | *(required)* |
| `R2_ACCESS_KEY_ID` | *(required)* |
| `R2_SECRET_ACCESS_KEY` | *(required)* |
| `R2_BUCKET_NAME` | *(required)* |
| `R2_PUBLIC_BASE_URL` | *(required)* |

**Port**: fixed internal `8080`. Host-side port mapping is left to Unraid's own template UI — nothing to configure inside the container.

**Deployment artifact**: [`docker-compose.yml`](.scratch/gifiac/assets/docker-compose.yml) (`debian:bookworm-slim` base, the single `/data` volume, fixed port mapping). References the CI-published registry image (see §11) rather than building locally. R2 credentials are supplied via a companion `backend/.env` file, not hardcoded into the compose file.

---

## 11. CI: building and publishing the image

The image is built and published by GitHub Actions so it can be installed on Unraid without a local build. Workflow drafted at [`docker-publish.yml`](.scratch/gifiac/assets/docker-publish.yml) — place it at `.github/workflows/docker-publish.yml` in the repo.

- **Registry**: [GitHub Container Registry](https://ghcr.io) (`ghcr.io`), package made **public** — no separate account/secret to manage (auth reuses the repo's built-in `GITHUB_TOKEN`), and no registry credentials needed on the Unraid side to pull. Nothing sensitive is baked into the image; R2 credentials arrive as env vars at container start, not build time.
- **Trigger**: push to `main` only. No manual release/tagging step required to ship an update.
- **Tagging**: every build publishes both `latest` and an auto-generated `yyyy.mm.dd.hh.mm` timestamp tag — track `latest` day-to-day, or pin/roll back to a specific build by its timestamp tag.
- **Architecture**: `linux/amd64` only — matches the one known deployment target (the user's Unraid box); multi-arch would roughly double CI time on a FFmpeg-heavy image for no payoff.
- **Caching**: `docker/build-push-action` with GitHub Actions layer caching (`cache-from`/`cache-to: type=gha`), so unchanged layers — the FFmpeg `apt-get install` layer, unchanged `cargo-chef` dependency compiles (see §1) — are skipped on subsequent builds rather than recompiled from scratch each push.
- **Install path**: `docker-compose.yml` (§10) references `ghcr.io/YOUR_GITHUB_USERNAME/gifiac:latest`. Primary install path is Unraid's **Docker Compose Manager** plugin pointed at that file; a manual "Add Container" using the same image reference works as a fallback, since it's a single container with no multi-service orchestration.

---

## 12. Video templates *(designed, not yet implemented)*

A templating system so a video's full export setup can be saved and reused with minimal edits.

### Behaviour

- **One template per video.** A single set of saved parameters is attached to a video; it cannot have multiple templates.
- **Pre-fills the editor automatically.** Opening a video that has a template loads the caption editor with all template data pre-filled. The user can freely change anything before exporting.
- **Export form UX:**
  - When a video has *no* template: a **"Create template"** checkbox appears on the Make GIF form. Checking it saves the current export parameters as the video's template when the GIF is exported.
  - When working *from* a template: the "Create template" checkbox is hidden; a standalone **"Overwrite template"** button replaces it. Overwriting is independent of exporting — the user can update the template without triggering a new GIF export.
- **What is stored:** the full export form payload — captions array, GIF range (in/out points), and output dimensions. The GIF `name` is **not** stored (it's per-GIF, not per-template).
- **Video deletion guard:** a video can only be deleted if it has **no template**. The previous guard (blocking deletion if any GIF was made from the video) is removed and replaced entirely by this rule.
- **Template badge:** videos with a saved template display a small badge/icon on their card in the video picker.

### Data model

New table `video_templates`:

| Column | Type | Notes |
|---|---|---|
| `video_id` | TEXT | PK + FK → `videos.id`; unique constraint enforces one template per video |
| `payload_json` | TEXT | Full export payload as a JSON blob: `{captions, gif_range_start, gif_range_end, width, height}` |
| `saved_at` | TEXT | ISO8601 |

No separate path/URL columns; the template is always associated via `video_id`.

### REST API

| Method + path | Purpose |
|---|---|
| `GET /api/videos/{id}/template` | Returns the template payload, or `404` if none exists |
| `PUT /api/videos/{id}/template` | Upserts (creates or overwrites) the template with the request body |
| `DELETE /api/videos/{id}/template` | Deletes the template, allowing the video to be deleted |

The `GET /api/videos` list response gains a `has_template: bool` field per item (resolved at the SQL join level, no extra round-trips) to power the video-card badge.

---

## 13. URL-linked GIFs *(designed, not yet implemented)*

A way to add a GIF to the archive by pasting a URL and a title, instead of uploading a file. Distinct from bulk import (§7): the GIF is **never downloaded or re-hosted** — it's a pure hotlink to wherever it already lives.

### Behaviour

- **Pure hotlink, no re-hosting.** The `gifs` row stores the URL (`external_url`, see §2); Gifiac never fetches and stores the file body. The archive thumbnail and detail-panel preview render it directly as a live `<img src={external_url}>`. If the source disappears, the entry breaks — that tradeoff is accepted in exchange for zero storage cost and zero processing.
- **GIF format only.** No MP4/WebM sibling formats are generated — generating them would require fetching the source file server-side, which contradicts "pure hotlink." This is a deliberate exception to §7's "every `gifs` row ends up with all three formats" rule; it applies only to file-based imports and native exports, not to linked GIFs.
- **Lightweight validation on submit.** The server does a HEAD (or ranged GET) request against the submitted URL to confirm it resolves and looks like an image, with basic SSRF guards (reject private/loopback/link-local IP ranges). This is a sanity check only — no width/height are probed or persisted; the frontend sizes the thumbnail from the live image's natural dimensions.
- **Fixed at creation.** The URL can't be edited afterwards via `PATCH` — only `name` is patchable (see §5). To fix a typo'd or moved link, delete the row and re-add it. This keeps `PATCH`'s contract uniform across every GIF type.
- **External badge.** Any linked GIF is marked with a small icon in the archive grid and detail panel (see §8), since its media isn't under our control the way file-based imports and native exports are.
- **Detail panel actions**: Copy link (copies `external_url`) and **Open original** (opens `external_url` in a new tab) in place of Download — see §8.
- **Re-edit unavailable**, same existing rule as file-based imports: `video_id IS NULL` hides the "edit captions" action in the archive UI (§7).
- **Search**: `caption_text` is empty, so `GET /api/gifs?q=` falls back to matching `name` only — same existing rule as imports (§7), no new search logic needed.

### Data model

No new table — a single nullable `external_url` column on the existing `gifs` table (see §2 for the full column list and nullability notes). `video_id`, `captions_json`, `gif_range_start`/`gif_range_end`, `width`/`height` are all NULL for a linked GIF; `caption_text` is empty.

### REST API

| Method + path | Purpose |
|---|---|
| `POST /api/gifs/link` | JSON body `{url, name}` → validates the URL, creates a single `gifs` row with `external_url` set. See §5. |

`name` is required (no default), same as `POST /api/exports`. No multipart, no file body, no background job — this is a synchronous, single-row operation.

---

## 14. Out of scope

- Multi-user / authentication.
- YouTube URL import (nice-to-have, explicitly deferred).
- A live Giphy API integration (ruled out on Terms-of-Service grounds — see §7; manual download + bulk upload was chosen instead).
- Editing a linked GIF's `external_url` after creation (see §13) — delete and re-add instead.
- Downloading/re-hosting a linked GIF's file on R2 (see §13) — deliberately kept as a pure hotlink.

---

## Appendix: process record

This spec was assembled from an eleven-ticket structured decision process. Full reasoning, alternatives considered, and the exact grilling conversations behind each decision are preserved in:

- `.scratch/gifiac/map.md` — the index of all decisions
- `.scratch/gifiac/issues/01` through `11` — one ticket per decision, each with its question and full answer
- `.scratch/gifiac/assets/` — supporting research documents, the docker-compose.yml, and the docker-publish.yml workflow
- `.scratch/gifiac/prototypes/caption-editor/` and `.scratch/gifiac/prototypes/archive-browse/` — the two interactive UI prototypes referenced above
