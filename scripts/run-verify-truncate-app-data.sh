#!/usr/bin/env bash
# 既知のパスワードで一時 Postgres を立ち上げ、migrate + truncate が成功することを検証する。
# リポジトリルートから: bash scripts/run-verify-truncate-app-data.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTAINER="payjp-verify-truncate-$$"
PORT=54329
PGUSER=verifyuser
PGPASSWORD=verifypass9
PGDB=verifydb

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found; skipping local verify" >&2
  exit 0
fi

docker run -d --name "$CONTAINER" \
  -e POSTGRES_USER="$PGUSER" \
  -e POSTGRES_PASSWORD="$PGPASSWORD" \
  -e POSTGRES_DB="$PGDB" \
  -p "127.0.0.1:${PORT}:5432" \
  postgres:17-alpine >/dev/null

echo "[verify-truncate] waiting for postgres..."
for _ in $(seq 1 40); do
  if docker exec "$CONTAINER" pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

export DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD}@127.0.0.1:${PORT}/${PGDB}?sslmode=disable"
export TRUNCATE_SKIP_DOTENV=1

echo "[verify-truncate] migrate + truncate (tsx)..."
if ! npx tsx scripts/verify-truncate-app-data-local.ts; then
  echo "[verify-truncate] FAILED: migrate+truncate" >&2
  exit 1
fi

echo "[verify-truncate] truncate-app-data CLI..."
if ! npm run truncate-app-data -- --yes; then
  echo "[verify-truncate] FAILED: truncate-app-data CLI" >&2
  exit 1
fi

echo "[verify-truncate] OK — migrate + truncate-app-data CLI succeeded against ephemeral Postgres."
