#!/usr/bin/env bash
set -euo pipefail

# DB バックアップスクリプト
# 使用方法: ./scripts/backup-db.sh
# 環境変数 DATABASE_URL が必要（op run 経由での実行を推奨）
# cron 例: 0 3 * * * op run --env-file=/path/to/.env -- /path/to/scripts/backup-db.sh

BACKUP_DIR="${BACKUP_DIR:-/var/backups/hayane}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo '{"level":"error","service":"backup","message":"DATABASE_URL is required"}' >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/hayane_${TIMESTAMP}.sql.gz"

if pg_dump "$DATABASE_URL" | gzip > "$BACKUP_FILE"; then
  SIZE=$(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE" 2>/dev/null || echo "unknown")
  echo "{\"level\":\"info\",\"service\":\"backup\",\"message\":\"Backup completed\",\"file\":\"${BACKUP_FILE}\",\"size_bytes\":${SIZE},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
else
  echo '{"level":"error","service":"backup","message":"pg_dump failed"}' >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi

# 古いバックアップを削除
DELETED=$(find "$BACKUP_DIR" -name "hayane_*.sql.gz" -mtime +"$RETENTION_DAYS" -delete -print | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "{\"level\":\"info\",\"service\":\"backup\",\"message\":\"Old backups deleted\",\"count\":${DELETED},\"retention_days\":${RETENTION_DAYS}}"
fi
