#!/usr/bin/env bash
# Brings up the full local dev stack in one command: Postgres + MinIO
# (docker-compose.dev.yml), the backend (cargo run), the ingest/export
# Lambda watcher (cargo lambda watch), and the frontend (npm run dev).
# See README.md's "Local development" section for one-time setup
# (backend/.env.local, the local-dev Google OAuth client, cargo-lambda).
#
# Ctrl+C stops the backend/lambda/frontend processes started here.
# Postgres/MinIO keep running in the background (fast to reattach to next
# time) — stop them yourself with:
#   docker compose -f docker-compose.dev.yml down

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root_dir"

if [ ! -f backend/.env.local ]; then
  echo "error: backend/.env.local is missing." >&2
  echo "       See README.md's \"Local development\" section to set it up." >&2
  exit 1
fi

if ! grep -qE '^\s*GOOGLE_CLIENT_ID=\S+' backend/.env.local; then
  echo "error: GOOGLE_CLIENT_ID isn't set (or is still commented out) in backend/.env.local." >&2
  echo "       Create a separate local-dev Google OAuth client and uncomment/fill in" >&2
  echo "       GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and APP_BASE_URL there — see" >&2
  echo "       README.md's \"Local development\" section for the exact Google Cloud" >&2
  echo "       Console steps." >&2
  exit 1
fi

if ! command -v cargo-lambda >/dev/null 2>&1; then
  echo "error: cargo-lambda isn't installed." >&2
  echo "       Run: cargo install cargo-lambda --locked" >&2
  exit 1
fi

pids=()

cleanup() {
  echo
  echo "==> Stopping backend/lambda/frontend (Postgres/MinIO stay up)..."
  for pid in "${pids[@]}"; do
    kill "$pid" >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Runs "$@" with its cwd set to $dir, tagging its output with [$tag].
# Uses `exec` inside the subshell so $! is the real command's own pid
# (not an extra subshell/pipeline pid) — that's what cleanup() kills.
run() {
  local dir="$1" tag="$2"
  shift 2
  (cd "$dir" && exec "$@") > >(sed -u "s/^/[$tag] /") 2>&1 &
  pids+=("$!")
}

echo "==> Starting Postgres + MinIO (docker-compose.dev.yml)..."
docker compose -f docker-compose.dev.yml up -d

echo "==> Starting backend, Lambda watcher, and frontend..."
run backend backend  cargo run
run backend lambda   cargo lambda watch
run frontend frontend npm run dev

echo
echo "==> Up. Backend on :8080, frontend on :5173. Press Ctrl+C to stop."
echo

wait
