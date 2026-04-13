#!/usr/bin/env bash
# ローカル開発用 DB データ削除スクリプト（スキーマ保持）
#
# payjp-db-1 コンテナに docker exec で直接接続し、アプリテーブルを TRUNCATE する。
# schema_migrations は保持される。
#
# Usage:
#   bash scripts/truncate-local-db.sh          # 確認プロンプトあり
#   bash scripts/truncate-local-db.sh --yes    # 確認スキップ
set -euo pipefail

CONTAINER="payjp-db-1"
PGUSER="hayane"
PGDB="hayane"

TRUNCATE_SQL="TRUNCATE member_impact_logs, cancel_form_tokens, member_sessions, payjp_events, discord_link_sessions, oauth_states, access_gate_sessions, invite_sessions, invite_tokens, members CASCADE;"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: コンテナ '$CONTAINER' が見つかりません。docker compose up してください。" >&2
  exit 1
fi

if [[ "${1:-}" != "--yes" ]]; then
  echo "WARNING: $CONTAINER の全アプリデータを削除します（スキーマは保持）。"
  read -r -p "続行しますか？ [y/N]: " answer
  if [[ "$answer" != "y" && "$answer" != "Y" ]]; then
    echo "中止しました。"
    exit 0
  fi
fi

docker exec "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -c "$TRUNCATE_SQL"
echo "完了: アプリテーブルを TRUNCATE しました（schema_migrations は保持）。"
