#!/usr/bin/env bash
set -euo pipefail

# Nightly PostgreSQL backup for the PAY.JP compose stack.
#
# Invoked by payjp-ops-backup.timer (systemd, runs as root).
# Outputs gzip'd pg_dump to $BACKUP_DIR, retention $BACKUP_RETENTION_DAYS.
# Uses `docker compose exec -T db` so the container can be renamed without
# touching this script. pg_dump runs inside the container where
# POSTGRES_PASSWORD is already available — no host-side DB secret needed.
#
# Manual run: sudo /opt/payjp-ops/bin/backup-db.sh
# Repo path:  scripts/ops/backup-db.sh
# Runbook:    docs/ops/alerts.md

BACKUP_DIR="${BACKUP_DIR:-/var/backups/payjp-db}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
COMPOSE_DIR="${COMPOSE_DIR:-/home/ubuntu/payjp}"
MIN_BACKUP_BYTES="${MIN_BACKUP_BYTES:-500}"

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "[payjp-db-backup] FATAL: $BACKUP_DIR missing — run deploy/ops-systemd/install.sh" >&2
  exit 1
fi

DATE="$(date -u +%Y%m%d_%H%M%SZ)"
OUT="${BACKUP_DIR}/payjp_${DATE}.sql.gz"

cd "$COMPOSE_DIR"
/usr/bin/docker compose exec -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' \
  | gzip -9 > "$OUT"

chmod 600 "$OUT"

SIZE="$(stat -c '%s' "$OUT")"
if [[ "$SIZE" -lt "$MIN_BACKUP_BYTES" ]]; then
  echo "[payjp-db-backup] WARN: suspiciously small backup ${SIZE}B (<${MIN_BACKUP_BYTES}B threshold)" >&2
  exit 1
fi

find "$BACKUP_DIR" -maxdepth 1 -name 'payjp_*.sql.gz' -mtime "+${BACKUP_RETENTION_DAYS}" -delete

echo "[payjp-db-backup] ok: $OUT (${SIZE} bytes, retention=${BACKUP_RETENTION_DAYS}d)"
