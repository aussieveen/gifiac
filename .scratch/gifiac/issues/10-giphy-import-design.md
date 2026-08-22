Type: grilling
Status: resolved
Assignee: claude (this session)

## Question

How does the one-time Giphy migration actually work in Gifiac? [Giphy import feasibility research](09-giphy-import-feasibility.md) confirmed it's technically possible (beta API key, `q=@username` search, direct GIF + MP4 download URLs) but flagged a real caveat: Giphy's API Terms of Service prohibit caching/storing API-obtained media without partner approval, and separately forbid using API content to build "a database, directory, or index containing GIFs" — with no carve-out for the user's own uploads. This has to be put to the user directly, first, before any design work: proceed accepting that risk (low real-world enforcement likelihood for a private one-time personal export, per the research), or take a different path (e.g. manually downloading GIFs one-by-one via the Giphy website UI instead of the API, sidestepping the API ToS specifically)?

Once that's settled, design the rest:
- Schema: `gifs.video_id` currently a required FK to `videos` (Video ingest design) — imported GIFs have no source video. Nullable `video_id`? A sentinel? A separate table?
- `captions_json`/`caption_text`: imported GIFs have no structured caption data (Giphy has no tags/keyword field, only `title`/`alt_text`). What goes in `caption_text` for search purposes — just the Giphy title? Left empty?
- Format: Giphy exposes GIF + MP4 (no WebM) per item. Does Gifiac transcode a WebM locally to match its own output-format convention, or store GIF+MP4 only for imported items?
- Mechanism: a one-off migration script/CLI run once by the user, or a proper "Import from Giphy" UI feature reachable anytime? (The user's stated need is one-time, but revisit whether a reusable feature is worth it regardless.)
- Where do imported files land — same R2 bucket/key convention as exported GIFs (`gifs/{id}.gif`, `clips/{id}.mp4`), with a fresh UUID per imported item?

## Answer

**Scope broadened**: the user chose to sidestep the Giphy API ToS question entirely by **manually downloading** GIFs (via Giphy's own website UI, and potentially other sources too) rather than pulling via the API. This makes the feature generic bulk import of local GIF files, not a Giphy-specific integration — the [Giphy import feasibility research](09-giphy-import-feasibility.md) findings stand as a correct record of why the API path wasn't taken, but no code will actually talk to Giphy's API.

**Import mechanism**: bulk browser upload — a multi-file picker/drag-and-drop, reusing the same multipart-POST pattern as [Video ingest design](02-video-ingest-design.md), extended to accept multiple files in one request and return an array of created `gifs` rows.

**Schema**: no new columns. `gifs.video_id` and `gifs.captions_json` (from [Export pipeline design](04-export-pipeline-design.md)) become **nullable** — an imported GIF has `video_id = NULL`, `captions_json = NULL`. The archive's "re-edit" action is hidden/disabled whenever `video_id` is null (the same handling already implied by the video-deletion discussion in Video ingest design). `name` defaults to the uploaded filename with its extension stripped, immediately renameable via the existing `PATCH /api/gifs/{id}`. `caption_text` is left empty for imports — archive search falls back to matching `name` only.

**Format**: imported files are run through the **same FFmpeg transcode step already built for the export pipeline**, filling in whichever of GIF/MP4/WebM are missing from what was uploaded (a manually-downloaded file is typically GIF-only). Every `gifs` row ends up with all three formats regardless of whether it was created or imported — keeps the archive's preview/download experience uniform.

**Storage**: identical convention to exports — a fresh UUID v4 per imported item, `gifs/{id}.gif` / `clips/{id}.mp4` / `clips/{id}.webm`. No separate "imports" namespace; from the API/archive's perspective an imported GIF is just a `gifs` row like any other.
