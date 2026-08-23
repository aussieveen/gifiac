# syntax=docker/dockerfile:1
#
# Single-container build per SPEC.md §1/§10: the React frontend is built to
# static files here and served by the same Axum binary — no separate
# frontend container/process. debian:bookworm-slim (not Alpine/musl) because
# ffmpeg-sys-next needs system FFmpeg shared libraries at runtime, and
# cargo-chef caches the dependency-compile layer so it's only redone when
# Cargo.lock actually changes, not on every source edit (see §11 — this is
# what makes GitHub Actions' layer caching actually pay off).

# ---------- frontend build ----------
FROM node:22-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- backend dependency planning (cargo-chef) ----------
FROM rust:1-slim-bookworm AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app/backend

FROM chef AS planner
COPY backend/ .
RUN cargo chef prepare --recipe-path recipe.json

# ---------- backend build ----------
FROM chef AS builder
# ffmpeg-sys-next builds bindings against the system FFmpeg libs via
# pkg-config + bindgen (needs clang/libclang) — these are build-time only,
# not carried into the runtime image below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    clang \
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libavfilter-dev \
    libavdevice-dev \
    libswscale-dev \
    libswresample-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=planner /app/backend/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
COPY backend/ .
RUN cargo build --release

# ---------- runtime ----------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fontconfig \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# "Anton" (see backend/src/ass.rs's font-provisioning notes) — the same
# font file already bundled for the frontend's self-hosted @font-face,
# reused here as the single source of truth rather than fetching it a
# second time, registered system-wide so libass can find it by name.
COPY frontend/public/fonts/Anton-Regular.ttf /usr/local/share/fonts/Anton-Regular.ttf
RUN fc-cache -f

WORKDIR /app
COPY --from=builder /app/backend/target/release/gifiac-backend ./gifiac-backend
COPY --from=frontend-builder /app/frontend/dist ./static

EXPOSE 8080
CMD ["./gifiac-backend"]
