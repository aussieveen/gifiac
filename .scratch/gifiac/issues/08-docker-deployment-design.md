Type: grilling
Status: resolved
Blocked by: 05, 07
Assignee: claude (this session)

## Question

How is Gifiac deployed as a Docker container on Unraid? Given the settled API (ticket 05) and S3 config (ticket 07), settle: whether the frontend is served as static files from the same Rust binary (via embedded assets or a mounted /public dir) or as a separate container; the Docker volume mounts needed (source video storage, SQLite file); the environment variables the container expects (S3 credentials, storage path, port); and the docker-compose.yml or Unraid template shape. This is the last decision before spec assembly.

## Answer

**Single container.** The React frontend is built to static files at image build time and served by the same Axum binary via `tower-http`'s `ServeDir`/`ServeFile` for anything outside `/api/...` — no separate frontend container. This confirms what [API surface design](05-api-surface-design.md) already assumed when it ruled out API versioning.

**Volume**: one mount covering everything persistent — host `/mnt/user/appdata/gifiac` → container `/data`, the standard Unraid appdata convention. Both source videos and the SQLite file live under it:
- `GIFIAC_VIDEO_DIR=/data/videos` (matches the default assumed in [Video ingest design](02-video-ingest-design.md))
- `GIFIAC_DB_PATH=/data/gifiac.db` (new — SQLite path wasn't pinned down earlier)

**Full environment variable list**:
| Env var | Default |
|---|---|
| `GIFIAC_VIDEO_DIR` | `/data/videos` |
| `GIFIAC_DB_PATH` | `/data/gifiac.db` |
| `R2_ACCOUNT_ID` | *(required)* |
| `R2_ACCESS_KEY_ID` | *(required)* |
| `R2_SECRET_ACCESS_KEY` | *(required)* |
| `R2_BUCKET_NAME` | *(required)* |
| `R2_PUBLIC_BASE_URL` | *(required)* |

**Port**: fixed internal `8080`, no env var — host-side port mapping is left to Unraid's own template UI (`-p 8123:8080` style), nothing to configure inside the container.

**Deployment artifact**: [docker-compose.yml](../assets/docker-compose.yml) — `debian:bookworm-slim`-based build (per [Rust framework selection](01-rust-framework-selection.md)), the single `/data` volume, fixed port mapping, and all R2 env vars pulled from a companion `.env` file (not hardcoded, keeps secrets out of the compose file itself).
