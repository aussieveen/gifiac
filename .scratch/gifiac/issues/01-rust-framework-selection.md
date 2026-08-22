Type: research
Status: resolved

## Question

Which Rust HTTP framework — Axum or Actix-Web — is the better fit for Gifiac's API, given that it will handle large video file uploads (multipart), stream FFmpeg job progress to the frontend (SSE or WebSocket), and serve as the only backend process in a single Docker container?

Research both frameworks' multipart upload handling, async streaming capabilities, ecosystem health (2025), and Docker image size implications. Produce a markdown summary recommending one with clear reasoning.

## Answer

**Use Axum 0.8.9.**

SSE (needed to stream FFmpeg progress to the browser) is first-class in Axum's core — `axum::response::sse::Sse`. In Actix-Web it requires the unofficial, experimental `actix-web-lab` crate. Both frameworks stream multipart video uploads without buffering in memory; both support WebSocket in core. The FFmpeg integration pattern is the same for both (dedicated `thread::spawn` + `tokio::sync::mpsc` channel → `ReceiverStream` → `Sse`), but the SSE endpoint is one fewer dependency in Axum.

Do **not** use musl/Alpine for the Docker image — `ffmpeg-sys-next` requires system FFmpeg libs at runtime. Use `debian:bookworm-slim` + `cargo-chef`. Typical image size: ~200–400 MB (dominated by FFmpeg, not the Rust binary).

Recommended `Cargo.toml` starters: `axum = { version = "0.8", features = ["multipart", "ws"] }`, `tokio-stream` (for `ReceiverStream`), `tower-http` (CORS, static file serving), `ffmpeg-next = "9"`.

Asset: [01-rust-framework-research.md](../assets/01-rust-framework-research.md)
