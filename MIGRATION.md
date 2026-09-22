# Migrating Simon's existing archive

SPEC-CLOUD.md §12 — a hard requirement, not optional: Simon's existing
single-user archive (SQLite metadata + R2-hosted GIF/MP4/WebM outputs, on
the Unraid box) must migrate into the new system as his account's content.

This is a one-time, scriptable migration, run once after `terraform apply`
(see `terraform/README.md`) has stood up the new instance and it's
serving. It uses `backend/src/bin/migrate_archive.rs`, built into the same
Docker image as the server (`./migrate_archive`, alongside
`./gifiac-backend`).

## What it does, and doesn't, move

- `videos`/`gifs` rows copy across as-is — same ids, same timestamps —
  tagged with Simon's new-system `user_id`.
- R2 GIF/MP4/WebM outputs **aren't touched**. Both the old single-user app
  and the new one derive the same object keys from a gif's own id
  (`gifs/{id}.gif`, `clips/{id}.mp4`, `clips/{id}.webm`) — as long as the
  new deploy's `R2_BUCKET_NAME`/credentials point at the *same* R2 bucket
  Simon already uses, his existing outputs are already in the right place
  under the right keys. Nothing to copy.
- Old `video_templates` rows (an offset range into the source video)
  are **not** copied as rows — SPEC-CLOUD.md §4 changed what a template
  *is*: each one gets actually re-clipped with ffmpeg into the new
  self-contained clip/thumbnail asset. This is why the migration needs the
  old video files on disk, not just the old database.
- Raw source video files themselves are **not** migrated into the new S3
  bucket. They're ephemeral processing scratch space in the new system
  (7-day lifecycle rule, SPEC-CLOUD.md §6) — old videos are only needed
  here as scratch input for the one ffmpeg re-clip above; there's nothing
  that needs them to persist afterward.

Safe to re-run: every row is skipped if it's already present (by id for
videos/gifs, by video_id for templates), so an interrupted run can just be
invoked again.

## Prerequisites

1. **Manual RDS snapshot**, immediately before running this (SPEC-CLOUD.md
   §10 Backup/DR, §12): AWS Console → RDS → the `gifiac` instance → Actions
   → Take snapshot. Don't skip this — it's the rollback path if the
   migration does something wrong.
2. **The new app is deployed and reachable** (`terraform apply` done, DNS
   pointed at the ALB, cert issued — see `terraform/README.md`).
3. **Simon's account already exists in the new system.** Log into the app
   once via Google OAuth — this creates his `users` row. Find its id from
   the browser's network tab: the response body of `GET /api/auth/me`
   includes `"id"`. That's the `--user-id` this migration needs; the
   script refuses to run against an id it can't find in `users`, so there's
   no risk of silently creating orphaned rows under a made-up id.
4. **The old archive's files, staged on the new EC2 instance.** There's no
   SSH (SSM Session Manager only, see `terraform/security_groups.tf`), so
   getting files onto the instance goes through S3 rather than `scp`:

   ```bash
   # On the old Unraid box (or wherever the archive currently lives):
   tar czf archive.tar.gz gifiac.db videos/

   # Using your own AWS credentials (not the app's) — the source-video
   # bucket is a convenient scratch spot since the instance's IAM role
   # can already read from it (see terraform/iam.tf):
   aws s3 cp archive.tar.gz s3://$(terraform -chdir=terraform output -raw source_videos_bucket_name)/migrate-scratch/archive.tar.gz

   # Open a shell on the instance (no SSH needed):
   aws ssm start-session --target <instance-id>
   ```

   Then, in that session:

   ```bash
   sudo mkdir -p /opt/gifiac/data/migrate
   sudo aws s3 cp s3://<bucket>/migrate-scratch/archive.tar.gz /opt/gifiac/data/migrate/archive.tar.gz
   sudo tar xzf /opt/gifiac/data/migrate/archive.tar.gz -C /opt/gifiac/data/migrate
   ```

   (`/opt/gifiac/data` is the same host path the app's own container has
   bind-mounted at `/data` — see `docker-compose.yml` — so anything placed
   there is reachable from inside the container as `/data/migrate/...`.)

## Running it

Still in the SSM session on the instance:

```bash
docker compose exec gifiac ./migrate_archive \
  --old-sqlite /data/migrate/gifiac.db \
  --old-video-dir /data/migrate/videos \
  --user-id <id-from-prerequisite-3>
```

`DATABASE_URL`/`GIFIAC_VIDEO_DIR` don't need to be passed — the container
already has them set (same env the server itself runs with), so the
migration writes to the same RDS instance and the same `/data/videos`
the app serves from.

It prints a summary of what it did:

```
loaded N videos, M gifs, K templates from /data/migrate/gifiac.db
videos: ... inserted, ... already present
gifs: ... inserted, ... already present
templates: ... clipped, ... failed, ... already present
```

A per-template failure (e.g. a missing or corrupt old video file) doesn't
abort the run — it's logged and counted, and everything else still
migrates. Exit code is non-zero if anything failed, so check for that in
scripting; re-running after fixing the underlying issue (e.g. restaging a
missing video file) picks up only what's still missing.

## Cleanup

Once the summary looks right (spot-check a few gifs/templates in the
app itself):

```bash
sudo rm -rf /opt/gifiac/data/migrate
aws s3 rm s3://<bucket>/migrate-scratch/archive.tar.gz
```
