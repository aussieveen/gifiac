# Research: Lambda packaging strategy for ffmpeg

Ticket: gifiac#33 (child of map #32).

## The deciding fact

The codebase's ffmpeg usage isn't uniform:

- `backend/src/ffmpeg/probe.rs` uses the **`ffmpeg-next`** crate — Rust bindings that dynamically link against the system ffmpeg shared libraries (`libavcodec`, `libavformat`, `libavutil`, `libavfilter`, `libavdevice`, `libswscale`, `libswresample`) at runtime. This is not a subprocess call.
- Every other ffmpeg touchpoint (`thumbnail.rs`, `webp.rs`, `mod.rs`'s `run_ffmpeg_with_progress`, and the export pipeline) shells out to the **`ffmpeg` CLI binary** and `webpmux` via `tokio::process::Command` — ordinary subprocess calls.
- Caption rendering (ASS/libass, per `ass.rs`) needs `fontconfig` plus a registered font (`Anton-Regular.ttf`) available system-wide (`fc-cache`).

The existing `Dockerfile`'s runtime stage (`debian:bookworm-slim` + `apt-get install ffmpeg fontconfig ca-certificates webp` + the font + `fc-cache`) solves all of this today by giving the process a full, real Linux userspace with both the CLI binary and the matching shared libraries installed together.

## Why this rules out zip + layer

Lambda's zip-deployment model (code + up to 5 layers, 250MB unzipped total) is a fine fit for the subprocess-CLI usage alone — community ffmpeg Lambda layers exist (static, musl-ish builds, ~70–90MB) and would work for `thumbnail.rs`/`webp.rs`/export encoding.

It does **not** fit the `ffmpeg-next` probe path. Those community layers ship a static CLI binary, not the dev shared libraries (`.so` files) `ffmpeg-next` needs to dynamically link against at runtime, built at a specific ABI/version. Replicating that via a layer means hand-building and version-pinning `.so`s against Amazon Linux 2023's glibc ourselves — fragile, and an ongoing maintenance burden with no precedent in this codebase. Nothing about the destination (moving ffmpeg off EC2) calls for also rewriting `probe.rs` off `ffmpeg-next` to make it fit — that would be solving a packaging constraint by changing working code, not the other way round.

## Why container image fits

A container-image Lambda (up to 10GB, any base image that implements the Lambda Runtime API via the Runtime Interface Client) lets the Lambda's runtime environment be the same `debian:bookworm-slim` + apt-get userspace the project already builds and tests today. Concretely: take the existing Dockerfile's runtime stage, add the Rust Lambda Runtime Interface Client (the `aws-lambda-rust-runtime` / `cargo-lambda` pattern), and the same `probe_video`/`generate_thumbnail`/export code runs unmodified — both the CLI-subprocess calls and the `ffmpeg-next` dynamic linking work exactly as they do in the current Docker image, because it *is* the current Docker image's environment.

Size isn't a concern: the current runtime image (ffmpeg + fontconfig + webp + a Rust binary + static frontend assets) is nowhere near the container Lambda's 10GB ceiling.

## arm64 is free, and already proven

The project already natively cross-builds and publishes `linux/arm64` Docker images in CI (`.github/workflows/docker-publish.yml`, matrix with `ubuntu-24.04-arm` as a real arm64 runner — not QEMU emulation). Lambda supports arm64 (Graviton2) container images directly. Building the Lambda image on the same CI matrix, targeting arm64, keeps architecture parity with the current `t4g.micro` EC2 instance and reuses an already-solved cross-compilation problem rather than opening a new one for x86_64.

## Cold starts

Container-image Lambdas have historically had somewhat higher cold-start latency than zip (image pull/unpack), though Lambda caches the image on its own infrastructure after first pull, so steady-state cold starts are a few hundred ms to low seconds, not a pull every time.

- **Export** (background work, no one is staring at a spinner waiting specifically on Lambda init) can absorb this without any special handling.
- **Ingest** is more latency-sensitive since the user is watching the upload modal, but the modal's own "Analyzing" stage already gives cover for a short cold start — it reads as processing time, not a stall. If cold starts turn out to be user-visible in practice, provisioned concurrency on the ingest function is the standard mitigation; that's a tuning knob for the sizing ticket, not a blocker to the packaging decision itself.

## Recommendation

**Container-image Lambda, built for arm64, reusing the existing Dockerfile runtime stage as its base.** This is the only option that supports `ffmpeg-next`'s dynamic linking requirement in probe.rs without rewriting working code, has essentially no package-size risk, and rides on CI arm64 build infrastructure the project has already stood up and proven for the Docker image.
