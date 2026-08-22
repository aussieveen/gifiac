Type: grilling
Status: resolved
Assignee: claude (this session)

## Question

How does video ingest work in Gifiac? Settle: how the user uploads a video to the tool (drag-and-drop in the browser, file picker, or both), where on the Unraid filesystem the original is stored (path conventions, naming), how the API stores the reference in SQLite (columns needed), and how a thumbnail / frame strip is generated for the editor to display. This decision feeds into the API surface and the editor UX tickets.

## Answer

**Upload mechanism**: browser upload only (no filesystem-scan/watch mode). Both drag-and-drop and a file picker are supported, feeding the same upload handler. Single multipart POST (`axum::extract::Multipart`, streamed straight to disk, no buffering) — no chunked/resumable upload; this is a single-user LAN tool, not worth the complexity.

**Disk storage**: root at `/data/videos`, configurable via `GIFIAC_VIDEO_DIR` env var. Flat directory (no date/UUID-prefix sharding — expected scale is hundreds/low-thousands of videos). File stored as `{video_id}.{extension}`, where `video_id` is a server-generated UUID v4. The user-supplied filename is never trusted as a disk path — it's kept only for display.

**SQLite `videos` table**:
- `id` TEXT (UUID v4, PK)
- `original_filename` TEXT
- `extension` TEXT
- `file_size_bytes` INTEGER
- `duration_seconds` REAL
- `width` INTEGER
- `height` INTEGER
- `uploaded_at` TEXT (ISO8601)

No status column and no stored file-path column: FFmpeg probing (duration/width/height) happens **synchronously** inside the upload request, so a row is only inserted once probing succeeds (nothing to track "pending"). The on-disk video path and thumbnail path are always derived from `id` + `extension`, never stored redundantly.

**Thumbnail**: one poster frame generated synchronously at upload time (`ffmpeg -ss 1 -frames:v 1`), stored at `{VIDEO_DIR}/{id}_thumb.jpg`. The Frinkiac-style film-strip scrubber is **deferred** — not generated at upload — since the caption editor ticket (Caption editor UX) hasn't yet settled what shape/resolution/frame-interval the strip needs; strip generation becomes an on-demand detail settled once that ticket resolves.
