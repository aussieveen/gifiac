Type: grilling
Status: resolved
Assignee: claude (this session)

## Question

How does the Gifiac Docker image get built and published so it can be easily installed on the user's Unraid server, without building it locally there? [Docker deployment design](08-docker-deployment-design.md) settled the container's shape (single container, one volume, env vars, fixed port, a `docker-compose.yml` using `build: .`) but didn't cover CI/CD — the compose file as drafted requires a local build, which doesn't serve "easily install on Unraid."

Settle:
- Which container registry (GitHub Container Registry / ghcr.io is the natural default since the code will live on GitHub, vs Docker Hub).
- What triggers a build/publish (push to main, a version tag, a GitHub release)?
- Image tagging strategy (`latest` + version tags? just `latest`?).
- Target architecture — Unraid servers are typically `linux/amd64`; confirm whether multi-arch (e.g. also `arm64`) is worth building or out of scope for a single known-target homelab box.
- How the GitHub Actions workflow itself is shaped (build-and-push job, caching strategy for reasonable CI time given the FFmpeg-heavy `debian:bookworm-slim` base).
- Update [docker-compose.yml](../assets/docker-compose.yml) to reference the published registry image instead of `build: .`, and note whether Unraid's Docker UI (Community Applications-style template, or manual "Add Container") is the intended install path versus Docker Compose Manager.

## Answer

**Registry: GitHub Container Registry (ghcr.io)**, package made **public**. No separate account or secret to manage — auth reuses the repo's built-in `GITHUB_TOKEN` — and public avoids Unraid needing any registry credentials to pull, since nothing sensitive is baked into the image itself (R2 credentials arrive as env vars at container start, not at build time).

**Trigger: push to `main` only.** No manual release/tagging step required to ship an update.

**Tagging**: every build publishes **both** `latest` and an auto-generated `yyyy.mm.dd.hh.mm` timestamp tag — day-to-day tracking uses `latest`, but a specific build can always be pinned/rolled back to by its timestamp tag without needing a git tag to have been made in advance.

**Architecture: `linux/amd64` only.** The one known deployment target (the user's Unraid box) is x86-64; multi-arch would roughly double CI time on a FFmpeg-heavy image for no payoff.

**Workflow**: [`docker-publish.yml`](../assets/docker-publish.yml) (drafted, place at `.github/workflows/docker-publish.yml`) — single job, triggered on push to `main`. `docker/build-push-action` with GitHub Actions layer caching (`cache-from`/`cache-to: type=gha`) so unchanged layers (FFmpeg install, unchanged `cargo-chef` dependency compiles — see [Rust framework selection](01-rust-framework-selection.md)) are skipped on subsequent builds. `docker/login-action` authenticates with the built-in `GITHUB_TOKEN`. `docker/metadata-action` generates the `latest` + timestamp tags.

**Install path**: [`docker-compose.yml`](../assets/docker-compose.yml) (updated) now references `ghcr.io/YOUR_GITHUB_USERNAME/gifiac:latest` instead of `build: .`. Primary install path is Unraid's **Docker Compose Manager** plugin pointed at this file; a manual "Add Container" using the same image reference works as a fallback since it's a single container with no multi-service orchestration.
