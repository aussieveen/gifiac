#!/usr/bin/env bash
# Mirrors the real Cloudflare R2 bucket (finished GIF/MP4/WebM exports)
# down into the local MinIO stand-in's gifiac-test bucket, so DB rows
# imported from a production dump (see gifiac-*.sql.gz) have matching
# files to serve locally instead of 404ing.
#
# Reads real R2 credentials from backend/.env (gitignored, production
# config — the same file docker-compose.yml uses). Run this yourself;
# it touches real credentials, so it's deliberately not something run
# on your behalf.

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root_dir"

if [ ! -f backend/.env ]; then
  echo "error: backend/.env not found (need real R2 credentials to read the real bucket)." >&2
  exit 1
fi

# Deliberately not `source`/`.` — that executes the file as shell code,
# so any value containing `$`, backticks, or other shell metacharacters
# (plausible in a random-looking secret key) gets silently reinterpreted
# instead of taken literally, corrupting it before it ever reaches `mc`.
# `read` treats each line as plain data instead.
while IFS='=' read -r key value; do
  case "$key" in
    ''|'#'*) continue ;;
  esac
  export "$key=$value"
done < backend/.env

: "${R2_ACCOUNT_ID:?backend/.env is missing R2_ACCOUNT_ID}"
: "${R2_ACCESS_KEY_ID:?backend/.env is missing R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?backend/.env is missing R2_SECRET_ACCESS_KEY}"
: "${R2_BUCKET_NAME:?backend/.env is missing R2_BUCKET_NAME}"

if ! docker ps --format '{{.Names}}' | grep -q '^gifiac-dev-minio$'; then
  echo "error: gifiac-dev-minio isn't running — start it first:" >&2
  echo "       docker compose -f docker-compose.dev.yml up -d" >&2
  exit 1
fi

echo "==> Mirroring r2://${R2_BUCKET_NAME} -> local MinIO (gifiac-test)..."

# `mc alias set` takes the access key/secret as separate arguments rather
# than embedding them in a user:pass@host URL (MC_HOST_<alias>'s other
# form) — R2 secret keys routinely contain `/`/`+`, which silently breaks
# that URL form instead of erroring loudly, making the source look empty.
docker run --rm \
  --network gifiac_default \
  -e R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
  -e R2_ACCESS_KEY_ID \
  -e R2_SECRET_ACCESS_KEY \
  -e R2_BUCKET_NAME \
  --entrypoint sh \
  cgr.dev/chainguard/minio-client:latest-dev \
  -c '
    set -eu
    mc alias set r2 "$R2_ENDPOINT" "$R2_ACCESS_KEY_ID" "$R2_SECRET_ACCESS_KEY"
    mc alias set local http://minio:9000 gifiac gifiac-test-secret
    echo "--> objects currently in r2/$R2_BUCKET_NAME:"
    mc ls "r2/$R2_BUCKET_NAME" | head -5
    mc mirror --overwrite "r2/$R2_BUCKET_NAME" local/gifiac-test
  '

echo "==> Done. Verify with:"
echo "    docker run --rm --network gifiac_default --entrypoint sh cgr.dev/chainguard/minio-client:latest-dev -c 'mc alias set local http://minio:9000 gifiac gifiac-test-secret && mc ls local/gifiac-test'"
