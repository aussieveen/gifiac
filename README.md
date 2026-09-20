# Gifiac

A self-hosted GIF/clip creation and archival tool. Upload a video, scrub to a
moment, caption it Frinkiac-style, export as a GIF/MP4/WebM, and keep a
searchable archive of everything you've made — plus bulk-import GIFs you
already have from elsewhere (e.g. Giphy).

Single-user, no authentication, one Docker container. Built for a home
Unraid box, but runs anywhere Docker does.

For the full design and every decision behind it, see [`SPEC.md`](SPEC.md).

## Features

- **Upload & scrub** — drag-and-drop or pick a video, then scrub a
  film-strip timeline to find the moment you want.
- **Frinkiac-style caption editor** — draggable/resizable caption tracks,
  live preview, per-caption font/size/color/alignment, position captions
  directly on the frame.
- **Export pipeline** — one export produces a GIF, MP4, and silent-loop
  WebM together, with live progress over SSE.
- **Archive** — every export lands in a searchable, browsable archive
  (search matches name + caption text). GIFs made from a source video stay
  re-editable — reopen one and its captions come back exactly as they were.
- **Bulk import** — drop in GIFs you already have (e.g. downloaded from
  Giphy) and they're normalized into the same GIF/MP4/WebM trio and added
  to the archive.

## Architecture

- **Backend**: Rust, [Axum](https://github.com/tokio-rs/axum), native
  FFmpeg bindings via `ffmpeg-next`.
- **Frontend**: React + TypeScript, built to static files and served by the
  same Axum binary — one process, one container.
- **Metadata DB**: SQLite, migrations run automatically at startup.
- **Source video storage**: local disk, never uploaded anywhere.
- **Finished output storage**: Cloudflare R2 (S3-compatible, public-read),
  chosen for zero egress fees on repeatedly-viewed/shared GIFs.

```
backend/    Rust/Axum API + FFmpeg pipeline + SQLite
frontend/   React/TypeScript SPA (Vite)
```

See [`SPEC.md`](SPEC.md) for the full data model, REST API, and export
pipeline details.

## Deployment (Docker)

This is the intended way to run Gifiac day-to-day. The image is built and
published to [GHCR](https://ghcr.io) automatically by
[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)
on every push to `main` — no local build required.

1. You'll need a [Cloudflare R2](https://developers.cloudflare.com/r2/)
   bucket (public-read) and its API credentials — finished GIFs/clips are
   stored there, not on disk.
2. Copy [`docker-compose.yml`](docker-compose.yml) and
   [`.env.example`](.env.example) to your host, and copy `.env.example` to
   `backend/.env`, filling in your R2 credentials.
3. In `docker-compose.yml`, replace `YOUR_GITHUB_USERNAME` in the `image:`
   line with the GitHub user/org this repo lives under.
4. Adjust the volume host path (`/mnt/user/appdata/gifiac` by default,
   an Unraid appdata convention) and the host port (`8123` by default) to
   taste.
5. Start it:

   ```sh
   docker compose up -d
   ```

Gifiac stores source videos under the `/data` volume mount — back that up
alongside the Postgres database, which lives outside the container; the
finished GIFs/clips live in R2.

### Configuration

| Env var | Default | Notes |
|---|---|---|
| `GIFIAC_VIDEO_DIR` | `/data/videos` | Source video storage root |
| `DATABASE_URL` | `postgres://gifiac:gifiac@localhost:5432/gifiac` | Postgres connection URL |
| `R2_ACCOUNT_ID` | *(required)* | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | *(required)* | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | *(required)* | R2 API token secret |
| `R2_BUCKET_NAME` | *(required)* | Target R2 bucket, public-read |
| `R2_PUBLIC_BASE_URL` | *(required)* | Public base URL GIF/clip links are derived from |
| `GOOGLE_CLIENT_ID` | *(required)* | Google OAuth client id |
| `GOOGLE_CLIENT_SECRET` | *(required)* | Google OAuth client secret |
| `APP_BASE_URL` | *(required)* | Public site origin (e.g. `https://gifiac.example.com`) — builds the Google redirect URI and the post-login redirect target. `http://localhost:5173` in local dev; session cookies are only marked `Secure` when this is `https://` |

The container listens on port `8080` internally; map it to whatever host
port you like (`docker-compose.yml` maps `8123:8080` by default).

## Local development

Run the backend and frontend as two separate dev processes; Vite proxies
`/api` to the backend so both behave as one origin, matching production.

**Prerequisites**:
- Rust (edition 2024 — a recent stable toolchain)
- Node.js 22+
- FFmpeg development libraries + `pkg-config` + `clang` (needed to build
  `ffmpeg-next`'s bindings). On Debian/Ubuntu:

  ```sh
  sudo apt-get install pkg-config clang \
    libavcodec-dev libavformat-dev libavutil-dev \
    libavfilter-dev libavdevice-dev libswscale-dev libswresample-dev
  ```

  (See the [`Dockerfile`](Dockerfile) for the exact package list used in
  CI/production — other package managers will have equivalently-named
  `-dev`/`-devel` packages.)

**Backend** (from `backend/`):

Local dev/test dependencies (Postgres + a MinIO stand-in for R2, used only
by the test suite) run via [`docker-compose.dev.yml`](docker-compose.dev.yml):

```sh
docker compose -f docker-compose.dev.yml up -d
```

This matches `config.rs`'s default `DATABASE_URL`
(`postgres://gifiac:gifiac@localhost:5432/gifiac`) and
`backend/tests/common::test_storage`'s hardcoded MinIO endpoint/bucket
exactly, so no env var overrides are needed to use either as-is.

```sh
export GIFIAC_VIDEO_DIR=./data/videos
export R2_ACCOUNT_ID=...          # real Cloudflare R2 credentials — MinIO
export R2_ACCESS_KEY_ID=...       # above is a test-only stand-in, not
export R2_SECRET_ACCESS_KEY=...   # something `cargo run` talks to; a
export R2_BUCKET_NAME=...         # running server still needs real R2.
export R2_PUBLIC_BASE_URL=...
export GOOGLE_CLIENT_ID=...        # real Google OAuth client — see
export GOOGLE_CLIENT_SECRET=...    # SPEC-CLOUD.md §2 for the flow
export APP_BASE_URL=http://localhost:5173

cargo run
```

Schema migrations are applied automatically on startup against
`DATABASE_URL` — no manual migration step. The server listens on `:8080`.

Backend tests (`cargo test`) need the same Postgres instance reachable —
override its admin connection via `TEST_DATABASE_URL` if you're not using
`docker-compose.dev.yml` — since each test creates and migrates its own
throwaway database against it for isolation. Tests exercising R2 uploads
need the MinIO service from that same compose file running too.

Useful commands while working on the backend:

```sh
cargo test              # run the test suite
cargo clippy --all-targets
```

**Frontend** (from `frontend/`):

```sh
npm install
npm run dev              # dev server on :5173, proxies /api to :8080
```

```sh
npm run build             # production build → frontend/dist
npm test                  # vitest
npm run lint               # oxlint
```

### Building the Docker image locally

```sh
docker build -t gifiac:local .
```

The build context is the repo root (the Dockerfile builds both the
frontend and backend in separate stages before assembling the runtime
image) — run it from there, not from `backend/` or `frontend/`.

## CI/CD

[`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)
builds and pushes the image to GHCR on every push to `main`, tagged both
`latest` and a `yyyy.mm.dd.hh.mm` timestamp (so you can pin/roll back to a
specific build). Layer caching (`type=gha`) keeps rebuilds fast by skipping
unchanged dependency-compile and `apt-get` layers.

## Out of scope

- Multi-user / authentication
- YouTube URL import
- A live Giphy API integration (Giphy's API ToS prohibits storing
  API-obtained media — see [`SPEC.md`](SPEC.md) §7 for the reasoning;
  bulk import via manual download + upload was chosen instead)
