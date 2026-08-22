Type: grilling
Status: resolved
Blocked by: 02, 03
Assignee: claude (this session)

## Question

What is the complete REST API surface for Gifiac? Given the ingest flow (ticket 02) and editor data model (ticket 03), enumerate every endpoint: upload video, list/get videos, create export job, stream export progress, get archive (list GIFs, search by text/tag), get single GIF, delete GIF. For each endpoint: HTTP method + path, request shape, response shape. This becomes the contract the frontend and backend are both built to.

## Answer

Base path `/api/...`, no version segment (single deployable, one frontend built alongside the backend — no independent-client-versioning problem to solve). No auth on any endpoint (single-user).

**Videos**

| Method + path | Purpose |
|---|---|
| `POST /api/videos` | Upload (multipart) → full `videos` row once probing succeeds |
| `GET /api/videos` | List, newest first |
| `GET /api/videos/{id}` | Get one |
| `GET /api/videos/{id}/thumbnail` | Poster image (`{id}_thumb.jpg`) |
| `GET /api/videos/{id}/filmstrip` | JSON: `{frameCount, cols, rows, frameWidth, frameHeight, interval, imageUrl}` |
| `GET /api/videos/{id}/filmstrip.jpg` | The on-demand generated sprite image itself |

Static assets (thumbnail, sprite) served via `tower-http`'s `ServeDir`/`ServeFile`. **No video deletion endpoint** — considered and deliberately dropped: deleting a source video would silently break re-editing of any GIF made from it, so source videos are permanent via the API; disk cleanup, if ever needed, is manual on the Unraid filesystem.

**Exports**

| Method + path | Purpose |
|---|---|
| `POST /api/exports` | body: `{video_id, name, captions, gif_range_start, gif_range_end}` (`name` required, no default — the editor's title field starts empty) → `202 Accepted` `{export_id}`, kicks off the FFmpeg pipeline as a background job |
| `GET /api/exports/{export_id}/progress` | SSE, per-stage events (from [Export pipeline design](04-export-pipeline-design.md)); the **final event** (`event: complete`) carries the full completed `gifs` row as its payload, then the stream closes — no separate polling endpoint needed to learn the result |

**Archive (GIFs)**

| Method + path | Purpose |
|---|---|
| `GET /api/gifs?q={query}` | list/search — `q` matches against `name` and `caption_text`; omitted `q` returns everything, newest first |
| `GET /api/gifs/{id}` | single GIF, including `captions_json`, for viewing or loading back into the caption editor to re-edit |
| `PATCH /api/gifs/{id}` | body `{name}` — rename without a full re-export |
| `DELETE /api/gifs/{id}` | removes the SQLite row **and** its S3 objects (all three formats) |

**Schema addendum**: the `gifs` table (defined in [Export pipeline design](04-export-pipeline-design.md)) gains a required `name` TEXT column — archive search is "name + caption-text" per the map, and the export pipeline ticket's original schema didn't have a name field. Source videos can be reused across multiple GIFs (same clip, different caption jokes), so a name derived from the source video's filename wouldn't distinguish them — an explicit, editable per-GIF name is needed.

No pagination on `GET /api/gifs` for v1 — personal-scale archive; `limit`/`offset` can be added later if it ever matters.
