#!/usr/bin/env bash
# Production-style stack: frontend build + Docker Compose (db, api, nginx, admin-api).
# Requires repo-root `.env`. Secrets may use 1Password references (op://...); `op run` resolves them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
	echo "Error: .env not found. Copy from .env.example: cp .env.example .env" >&2
	exit 1
fi

if grep -q 'op://' .env 2>/dev/null; then
	if ! command -v op >/dev/null 2>&1; then
		echo "Error: .env contains op:// references but the 1Password CLI (op) is not installed." >&2
		exit 1
	fi
fi

eval "$(op signin)"

# Inject .env (with op:// resolved) into npm / docker compose. Compose passes SUBSCRIBE_GATE_* into api (see docker-compose.yml).
op run --env-file=.env -- npm run build:frontend

printf '%s\n' '[build.sh] Starting Docker Compose in attached mode; the command will keep streaming service logs while the stack is running.'

exec op run --env-file=.env -- docker compose up --build
