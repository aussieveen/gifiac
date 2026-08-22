# Rust HTTP Framework Research: Axum vs Actix-Web

> **For project:** Gifiac — single-container homelab video-upload + FFmpeg export service
> **Date:** 2026-08-22
> **Versions researched:** Axum 0.8.9 · Actix-Web 4.15.0 · ffmpeg-next 9.0.0

---

## ✅ Recommendation: **Axum**

Use **Axum 0.8.9**. For this specific workload — streaming video uploads, FFmpeg progress over SSE, and a single-user homelab container — Axum wins on every axis that actually matters here. SSE is first-class in Axum's standard library (`axum::response::sse::Sse`), requiring zero third-party crates; in Actix-Web it requires the unofficial `actix-web-lab` crate (marked experimental). The FFmpeg integration pattern — spawn a dedicated OS thread, bridge back to the async world via a `tokio::sync::mpsc` channel, pipe that channel into `Sse::new(ReceiverStream::new(rx))` — is maximally idiomatic in Axum because Axum *is* Tokio; there is no intermediate arbiter/actor layer to reason about. Axum's multipart extractor (`multer` under the hood) streams chunks without buffering by default — one call to `DefaultBodyLimit::disable()` removes the 2 MB cap and data flows straight from the socket to disk. Actix-Web is not a bad choice and remains actively maintained (v4.15.0 shipped 2026-08-21), but its SSE gap and its heavier arbiter-threading model add friction for no benefit given the single-user, single-container constraints.

---

## 1. Multipart Upload Handling

### Axum

| Item | Detail |
|---|---|
| Crate | `axum` (feature `multipart`), backed by [`multer`](https://docs.rs/multer) |
| API style | Streaming extractor: `Multipart` → `next_field()` → `field.chunk()` |
| Memory behaviour | **Truly streaming** — chunks are `Bytes` slices yielded one at a time; never buffered in full |
| Default body limit | **2 MB** (security default). Must opt out with `.layer(DefaultBodyLimit::disable())` |
| Large file pattern | Loop `field.chunk()`, write each chunk to `tokio::fs::File` |
| Ergonomics | `Multipart` must be the *last* extractor in the handler signature (consumes body) |

**Key snippet:**
```rust
// Cargo.toml: axum = { features = ["multipart"] }
async fn upload(mut multipart: Multipart) {
    while let Some(mut field) = multipart.next_field().await.unwrap() {
        while let Some(chunk) = field.chunk().await.unwrap() {
            // write chunk to disk — never fully buffered in memory
        }
    }
}

// Router setup — disable the 2 MB cap for video uploads:
Router::new()
    .route("/upload", post(upload))
    .layer(DefaultBodyLimit::disable())
```

### Actix-Web

| Item | Detail |
|---|---|
| Crate | [`actix-multipart`](https://docs.rs/actix-multipart) (separate crate, same org) |
| API — high level | `MultipartForm` derive macro + `TempFile` field → streams directly to a temp file on disk |
| API — low level | `Multipart` struct → `next_field()` → field is an `AsyncRead` stream |
| Memory behaviour | `TempFile` = **streams to disk automatically**; raw `Multipart` = streaming chunks |
| Size limit config | `MultipartFormConfig::default().total_limit(N)` on app data |

**Verdict:** Both are genuinely streaming and do not buffer the whole video in memory. Axum's API is slightly more explicit (you control the write loop); Actix's `TempFile` is more magic but convenient. Tie on capability.

---

## 2. SSE / WebSocket Support

### Axum — SSE ✅ First-class, in core

```rust
use axum::response::sse::{Event, KeepAlive, Sse};
use tokio_stream::wrappers::ReceiverStream;

async fn progress_stream(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel(32);
    // Hand tx to a spawned FFmpeg thread (see §5)
    let stream = ReceiverStream::new(rx).map(|msg| Ok(Event::default().data(msg)));
    Sse::new(stream).keep_alive(KeepAlive::default())
}
```

- `Sse<S>` implements `IntoResponse` directly — no wrapper, no extra crate.
- `KeepAlive` built in with configurable interval and text.
- WebSocket: `axum` crate `ws` feature (`tokio-tungstenite` under the hood). First-class.

### Actix-Web — SSE ⚠️ Third-party crate required

The official actix/examples SSE example uses `actix_web_lab::sse` — not anything in `actix-web` itself. `actix-web-lab` is maintained by the same primary maintainer (Rob Ede) but is marked experimental and lives outside the main crate.

```rust
// Requires: actix-web-lab = "0.22"  (NOT in actix-web core)
use actix_web_lab::sse;
```

**Verdict: Axum wins clearly.** SSE is the primary progress-streaming mechanism needed; Axum has it in core, Actix-Web does not.

---

## 3. Ecosystem Health (mid-2026)

| Metric | Axum | Actix-Web |
|---|---|---|
| Latest version | **0.8.9** (2026-04-14) | **4.15.0** (2026-08-21) |
| Total crates.io downloads | 435 M | 78 M |
| Recent downloads (last 90 days) | **108 M** | 9.7 M |
| Maintained by | Alice Ryhl (Tokio core team, Google) | Rob Ede (@robjtede) |
| MSRV | 1.80 | 1.88 |

Axum has roughly 11× more recent downloads and is maintained inside the Tokio organisation. Actix-Web is still actively maintained (4.15.0 shipped day of research) but has less momentum.

---

## 4. Docker Image Size

### The real size driver: FFmpeg, not the framework

`ffmpeg-next` links against system `libavcodec`, `libavformat`, `libavutil`, `libswscale`, `libswresample` — ~30–80 MB of shared libraries. **FFmpeg dominates the image size regardless of framework.**

A stripped `--release` Axum binary: **~5–10 MB**. Actix-Web: **~7–14 MB**. Difference is negligible.

### ⚠️ Do NOT use musl/Alpine

`ffmpeg-sys-next` links dynamically against system FFmpeg. Getting musl + FFmpeg requires a static FFmpeg build or complex cross-compilation. Not worth it for a homelab container.

### Recommended Dockerfile

Use `debian:bookworm-slim` + `cargo-chef` for fast layer caching:

```dockerfile
FROM lukemathwalker/cargo-chef:latest-rust-1 AS chef
WORKDIR /app

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY . .
RUN cargo build --release --bin gifiac

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/target/release/gifiac /usr/local/bin/gifiac
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/gifiac"]
```

Typical total image: **~200–400 MB** (debian:bookworm-slim ~80 MB + ffmpeg ~80–120 MB + Rust binary ~5–10 MB).

---

## 5. FFmpeg + Async: Threading Pattern

`ffmpeg-next` is **synchronous and blocking**. Use a **dedicated OS thread** (not `spawn_blocking`, which is for short-lived work) with a `tokio::sync::mpsc` channel to send progress back to the async world:

```rust
async fn start_export_job(/* job params */) -> impl Stream<Item = Result<Event, Infallible>> {
    let (tx, rx) = mpsc::channel::<String>(64);

    // Dedicated OS thread — ffmpeg job owns the thread for its lifetime
    thread::spawn(move || {
        // All ffmpeg-next calls happen here
        for frame in encoder {
            let progress = compute_progress(&frame);
            if tx.blocking_send(progress).is_err() {
                break; // client disconnected
            }
        }
    });

    ReceiverStream::new(rx).map(|msg| Ok(Event::default().data(msg)))
}
```

> **Why `thread::spawn` not `spawn_blocking`?** Tokio docs: _"For workloads that run indefinitely or for extended periods, prefer a dedicated thread."_ A multi-minute FFmpeg export is exactly this case.

This pattern works identically in Axum and Actix-Web. Axum wins only because the resulting `Stream` feeds directly into `Sse::new()` without needing an extra crate.

---

## 6. Summary Scorecard

| Criterion | Axum | Actix-Web | Winner |
|---|---|---|---|
| Multipart streaming (large files) | ✅ | ✅ | Tie |
| SSE (FFmpeg progress) | ✅ **core** | ⚠️ extra crate | **Axum** |
| WebSocket | ✅ core | ✅ core | Tie |
| FFmpeg integration ergonomics | ✅ simpler | ⚠️ SSE gap | **Axum** |
| Docker / binary size | ✅ ~5–10 MB | ✅ ~7–14 MB | Axum (marginal) |
| Ecosystem momentum | ✅ 108 M recent dl | ✅ 9.7 M recent dl | **Axum** |
| Simplicity | ✅ 11 K Rust lines | — more batteries | **Axum** |

---

## 7. Recommended `Cargo.toml`

```toml
[dependencies]
axum = { version = "0.8", features = ["multipart", "ws"] }
tokio = { version = "1", features = ["full"] }
tokio-stream = { version = "0.1", features = ["sync"] }
tower-http = { version = "0.6", features = ["cors", "trace", "fs"] }
tower = { version = "0.5" }
futures-util = "0.3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
ffmpeg-next = "9"
```

- `axum` `multipart` → pulls in `multer`
- `axum` `ws` → pulls in `tokio-tungstenite`
- `tokio-stream` → `ReceiverStream` for SSE
- `tower-http` `fs` → serve frontend static files from the same binary

---

## Sources

- `docs.rs/axum` 0.8.9 — multipart, SSE, DefaultBodyLimit, ws modules
- `docs.rs/actix-web` 4.15.0 — server model, features
- `docs.rs/actix-multipart` — TempFile, MultipartForm
- `docs.rs/actix-web-lab` — sse module (required for SSE in actix)
- `crates.io/api/v1/crates/axum` and `actix-web` — download stats
- `crates.io/api/v1/crates/ffmpeg-next` — v9.0.0, maintenance status
- `github.com/zmwangx/rust-ffmpeg` README + CHANGELOG
- `github.com/LukeMathWalker/cargo-chef` — Dockerfile pattern
- `tokio-rs/axum/main/examples/sse/src/main.rs` — SSE example
- `actix/examples/main/server-sent-events/src/main.rs` — SSE example (uses actix-web-lab)
- Tokio docs — `spawn_blocking` vs `thread::spawn` guidance
