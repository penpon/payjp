# 運用ドキュメント INDEX

本ディレクトリは運用手順・runbook・チェックリストを集約する。**実行本体**と**自動化**は別ディレクトリに分散配置している。

## 3 分散の役割

| 階層 | 場所 | 役割 |
|---|---|---|
| 実行本体 | `scripts/ops/` | host で実行される shell (check-* / backup-db / notify / restore-drill / daily-digest / offsite-upload / b2-quota-check / run-all-checks)。`lib/` に alert-codes-i18n.conf / thresholds.conf / common.sh / dedup.sh / op-webhook.sh |
| 自動化 | `deploy/ops-systemd/` | systemd unit + timer + `install.sh` (idempotent、systemd-creds で secret 管理)。`payjp-ops-backup.timer` (日次 03:00 JST)、`payjp-ops-check.timer` (5 分毎)、`payjp-ops-digest.timer` (日次 09:00 JST)、`payjp-ops-restore-drill.timer` (月次第 1 日曜 04:00 JST)、`payjp-ops-offsite.service` (backup 成功時に OnSuccess で起動) |
| 人間向け手順 | `docs/ops/` (本ディレクトリ) | runbook、checklist、incident 手順、alerts 定義、backup/restore 解説 |

## 主要ドキュメント

| ドキュメント | 用途 |
|---|---|
| [production-readiness-checklist.md](production-readiness-checklist.md) | Go-Live 前必須チェック |
| [backup-restore.md](backup-restore.md) | 二層 backup 戦略 (local + B2 offsite) と復元シナリオ |
| [alerts.md](alerts.md) | alert コード / threshold / cool-down / 対応手順 |
| [incident-contacts.md](incident-contacts.md) | 連絡先一覧 |
| [admin-access-cloudflare.md](admin-access-cloudflare.md) | Zero Trust + CF Tunnel 運用 |
| [external-monitoring.md](external-monitoring.md) | 3 層 liveness / upstream / domain 監視 (HC.io + HetrixTools + MonitoRSS) |
| [environment-variables.md](environment-variables.md) | `.env` 全変数の用途一覧 |
| [access-gate.md](access-gate.md) | access gate 運用 |
| [admin-console.md](admin-console.md) | admin console 運用 |
| [manual-role-revoke.md](manual-role-revoke.md) | 手動剥奪フロー (インシデント対応) |
| [resync-cli.md](resync-cli.md) | 同期 CLI 運用 |
| [apps-script-cancel.md](apps-script-cancel.md) | Google Apps Script 退会連携の運用 |

## 運用スクリプト一覧 (`scripts/ops/` より)

| スクリプト | 役割 |
|---|---|
| `run-all-checks.sh` | 全 check の集約起点、timer から起動 |
| `check-host.sh` | host レイヤ (disk / load / OOM / TLS 期限 / domain 期限) |
| `check-docker.sh` | docker コンテナ状態 |
| `check-app.sh` | アプリケーションレイヤ (HTTP / DB 接続 / backup age) |
| `check-nginx.sh` | nginx エラー率・upstream 障害 |
| `backup-db.sh` | local `pg_dump` (14 日保持) |
| `offsite-upload.sh` | age 暗号化 + B2 Compliance Lock 30d (backup 成功時 trigger) |
| `restore-drill.sh` | 月次 offsite 復元訓練 |
| `daily-digest.sh` | 日次サマリを `#payjp-ops-normal` へ送信 |
| `notify.sh` | Discord webhook dispatch、`lib/alert-codes-i18n.conf` で日本語化 |
| `b2-quota-check.sh` | B2 残容量監視 |
