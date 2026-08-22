# Gifiac — Wayfinder Map

Type: wayfinder:map

## Destination

A complete spec for Gifiac — a self-hosted GIF/clip creation and archival tool — sufficient to hand off to a developer and start building. The spec covers: Rust API (+ FFmpeg bindings) backend, React/TypeScript frontend, Frinkiac-style visual timeline caption editor, video-to-GIF/MP4 export, S3-backed finished-GIF storage, source videos kept on disk, SQLite metadata, caption-text search, copy-link + download distribution, Docker deployment on Unraid. Single-user, no auth. Also covers **bulk import** of GIFs the user manually downloads locally (from Giphy and potentially other sources) into the Gifiac archive — not a live Giphy API integration (ruled out on ToS grounds, see Giphy import feasibility research). Also covers **CI-built Docker images**: a GitHub Actions pipeline builds and publishes the image so it can be installed on Unraid without a local build.

## Notes

Domain: personal tooling / homelab. Every session should read this map first, then claim the first frontier ticket.

Settled before mapping:
- Backend: Rust + FFmpeg native bindings (ffmpeg-next crate)
- Frontend: React + TypeScript
- Finished GIF/MP4 storage: S3 bucket
- Source video storage: Unraid local disk
- Metadata DB: SQLite
- Deployment: Docker container on Unraid
- Output formats: GIF + silent-loop MP4/WebM
- Archive retrieval: name + caption-text search
- Distribution: copy S3/CDN URL to clipboard, or download file locally
- Users: single-user, no login

## Decisions so far

- [Rust framework selection](issues/01-rust-framework-selection.md) — **Axum 0.8.9**: SSE is first-class in core (vs Actix-Web needing experimental `actix-web-lab`); simpler FFmpeg-thread-to-SSE wiring; `debian:bookworm-slim` Docker base (not Alpine — FFmpeg needs system libs).
- [Video ingest design](issues/02-video-ingest-design.md) — Browser upload (drag-and-drop + file picker) via single multipart POST to `/data/videos/{uuid}.{ext}`; `videos` SQLite table with no path/status columns (derived, probed synchronously); poster thumbnail generated at upload, film-strip deferred to the caption editor ticket.
- [Caption editor UX](issues/03-caption-editor-ux.md) — Timeline-lane editor (Frinkiac-style), one mode only: draggable/resizable caption tracks, separate GIF in/out range on the film-strip, style panel with drag-on-preview positioning. Caption data structure: `{id, startTime, endTime, text, fontFamily, fontSize, color, align, x, y}`.
- [Export pipeline design](issues/04-export-pipeline-design.md) — Captions burned in via a generated ASS subtitle file + `subtitles=` filter; GIF capped at 15fps/480px (tunable); one export job produces GIF+MP4+WebM together under `gifs/{id}.gif` / `clips/{id}.mp4|webm`; per-stage SSE progress; GIFs are **re-editable** — `gifs` SQLite table stores `captions_json`, not just baked text (later gained a required `name` column, see API surface design).
- [API surface design](issues/05-api-surface-design.md) — Full REST contract under `/api/...`, no versioning, no auth: video upload/list/get/thumbnail/filmstrip (no delete — breaks re-edit), `POST /api/exports` + single completing SSE stream (no separate poll), `GET/PATCH/DELETE /api/gifs` for the archive with `?q=` search. No pagination for v1.
- [Archive/browse UX](issues/06-archive-browse-ux.md) — Master-detail: static thumbnail grid + a detail panel (opens on click) holding the auto-playing preview, inline rename, and all actions (copy link, download, delete) centralized. Single search bar matching name + caption text.
- [S3 integration design](issues/07-s3-integration-design.md) — **Cloudflare R2** (zero egress fees) via `aws-sdk-s3`, env vars `R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET_NAME`. **Public-read bucket** (not presigned — copy-link needs permanent URLs), `R2_PUBLIC_BASE_URL` env var (defaults to `.r2.dev`, swappable to a custom domain later). No lifecycle rules. URLs **derived from id**, never stored in SQLite.
- [Docker deployment design](issues/08-docker-deployment-design.md) — **Single container**: frontend static files served by the same Axum binary. One volume (`/mnt/user/appdata/gifiac` → `/data`) for both source videos and SQLite. Full env var list settled (video dir, DB path, all R2 vars). Fixed internal port 8080. [docker-compose.yml](assets/docker-compose.yml) drafted as a linked asset.
- [Giphy import feasibility research](issues/09-giphy-import-feasibility.md) — **Possible with caveats**: technically sound (beta API key, `@username` search, direct GIF+MP4 URLs), but Giphy's API ToS prohibits caching/storing API-obtained media and building a "database... of GIFs," with no carve-out for a user's own uploads. Legal/policy blocker, not technical.
- [Giphy import design](issues/10-giphy-import-design.md) — User chose **manual download** over the API (sidesteps the ToS issue, generalizes beyond Giphy). Bulk browser upload (multi-file, same pattern as video ingest); `gifs.video_id`/`captions_json` made nullable for imports (no new columns); missing GIF/MP4/WebM formats auto-transcoded via the existing export pipeline; same S3 key convention as exports.
- [CI/CD image build & publish design](issues/11-ci-image-publish-design.md) — **GHCR, public**, push-to-`main` only, publishes both `latest` and a `yyyy.mm.dd.hh.mm` timestamp tag per build. `linux/amd64` only. [docker-publish.yml](assets/docker-publish.yml) drafted (GHA layer caching); [docker-compose.yml](assets/docker-compose.yml) updated to pull the published image instead of `build: .`.

## Not yet specified

_(none — destination reached. [SPEC.md](../../SPEC.md) assembled from all ten resolved tickets.)_

## Out of scope

- Multi-user / auth
- YouTube URL import (noted as nice-to-have but explicitly out of this spec)
