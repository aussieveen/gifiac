Type: grilling
Status: resolved
Assignee: claude (this session)

## Question

How does S3 integration work in Gifiac? Settle: which S3-compatible provider is being used (AWS S3, Cloudflare R2, or another), how the Rust backend authenticates (env vars in Docker), the bucket policy (public read for finished GIFs, or presigned URLs), the key prefix/naming convention for GIF and MP4 outputs, and whether any lifecycle rules are needed. Also: how does the frontend receive the final public URL after export — directly in the export-complete response, or via a separate fetch?

## Answer

**Provider: Cloudflare R2** (S3-compatible API), chosen specifically for zero egress fees — the user already has an AWS S3 account for another project, but GIFs/clips get repeatedly viewed and re-shared, and that access pattern would accumulate real AWS egress cost over time that R2 avoids entirely.

**Auth**: the `aws-sdk-s3` Rust crate (async/tokio-native, works against R2 by overriding the endpoint URL — no separate R2-specific crate needed). Docker env vars: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`. Credentials are read once at startup, never exposed to the frontend or logged.

**Bucket policy: public-read**, not presigned. This was the key architectural fork — presigned URLs expire, which actively conflicts with the already-settled "copy-link" distribution feature (a link pasted into Discord/texts needs to keep working indefinitely). A new env var, `R2_PUBLIC_BASE_URL`, holds the public base URL — defaults to R2's `.r2.dev` public dev URL; the user doesn't have a custom domain yet but may add one later, at which point this is a config change only, no code or data migration.

**Key naming**: confirmed as already fixed in [Export pipeline design](04-export-pipeline-design.md) — `gifs/{id}.gif`, `clips/{id}.mp4`, `clips/{id}.webm`, sharing the export's UUID.

**Lifecycle rules**: none for v1. GIFs are a permanent archive (no TTL), deletion is handled directly by `DELETE /api/gifs/{id}` removing the S3 objects, and outputs are small enough (short, 480px-capped clips) that multipart-upload-abort rules aren't a real concern.

**URL delivery: derived, not stored.** No new columns are added to the `gifs` table. Output URLs are computed on the fly, wherever needed (API responses, the export-complete SSE payload from [API surface design](05-api-surface-design.md)), as `{R2_PUBLIC_BASE_URL}/gifs/{id}.gif` / `{R2_PUBLIC_BASE_URL}/clips/{id}.mp4` / `.webm` — the same "derive from id, don't store a path" pattern already used for source video paths in [Video ingest design](02-video-ingest-design.md). Means a future switch to a custom domain requires zero data migration.
