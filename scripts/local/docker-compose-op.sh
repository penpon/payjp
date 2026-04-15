#!/usr/bin/env bash
# Run Docker Compose with 1Password secret references resolved.
# If .env contains op:// references, requires 1Password CLI (`op`) and a signed-in session.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
	echo "Error: .env not found. Copy from .env.example: cp .env.example .env" >&2
	exit 1
fi

if grep -q 'op://' .env 2>/dev/null; then
	if ! command -v op >/dev/null 2>&1; then
		echo "Error: .env contains op:// references but the 1Password CLI (op) is not installed." >&2
		echo "Install: https://developer.1password.com/docs/cli/" >&2
		echo "Or replace op:// lines in .env with literal values for local development." >&2
		exit 1
	fi
	echo "[docker-compose-op] Resolving op:// references via 1Password CLI (op run)..." >&2
	exec op run --env-file=.env -- docker compose "$@"
fi

exec docker compose "$@"
