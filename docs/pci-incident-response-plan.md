# インシデント対応計画 — PCI DSS SAQ A Req 12.10.1

最終更新: 2026-04-12  
次回レビュー: 2027-04-09（年次、またはインシデント発生後に見直し）

## 1. 役割・責任・連絡先

| 役割 | 担当 | 連絡先 | 責任 |
|---|---|---|---|
| インシデント責任者 | penpon | **1Password に保管した電話・メール**（リポジトリに書かない） | 判断・エスカレーション・対外連絡 |
| 技術対応 | penpon | 同上 | 封じ込め・調査・復旧 |

実連絡先の一覧と取得手順は [ops/incident-contacts.md](ops/incident-contacts.md) を参照する。

### 外部連絡先

| 連絡先 | 用途 | 連絡方法 |
|---|---|---|
| PAY.JP サポート | 決済関連インシデント・アカウント停止 | [pay.jp](https://pay.jp/) ログイン後のサポート・お問い合わせ（URLはログイン後に表示される画面を正とする） |
| Discord Developer Support | Bot・OAuth障害 | Discord Developer Portal |
| Cloudflare | CDN・DNS障害 | Cloudflare ダッシュボード |
| サーバーホスティング | インフラ障害 | 契約プロバイダのサポート（詳細は [ops/incident-contacts.md](ops/incident-contacts.md)） |

## 2. インシデント分類

| 重大度 | 定義 | 対応時間 | 例 |
|---|---|---|---|
| **Critical** | カードデータ漏洩の疑い、システム侵害 | 即時 | 不正アクセス検知、Webページ改ざん |
| **High** | サービス全停止（1時間超） | 1時間以内 | DB障害、API全断、ロール同期全停止 |
| **Medium** | 一部ユーザー影響 | 4時間以内 | 単一ユーザーの課金不整合、Webhook処理失敗 |
| **Low** | 運用上の警告 | 翌営業日 | ログエラー、非クリティカル警告 |

## 3. 検知方法

| 検知源 | 監視対象 | 閾値 |
|---|---|---|
| nginx アクセスログ | 異常な4xx/5xxスパイク | 通常の10倍以上 |
| アプリケーションログ | `payjp_events.processing_result = 'failed'` | 連続3件以上 |
| `member_impact_logs` | `resolved_at IS NULL` の件数 | 5件以上 |
| 決済ページ整合性（補償的統制） | `frontend/index.html` のスクリプトタグ、CSP 定義、本番ヘッダ | [pci-payment-page-monitoring.md](pci-payment-page-monitoring.md) の頻度・手順に従う |
| 手動確認 | PAY.JP ダッシュボード、Discordサーバー | 日次確認 |
| 外部通知 | ユーザーからの報告 | 随時 |

決済ページの改ざん・スクリプト混入に関する **許可リスト・監視頻度** は [pci-payment-page-script-register.md](pci-payment-page-script-register.md) および上記 `pci-payment-page-monitoring.md` を正とする。

## 4. インシデント対応手順

### 4.1 封じ込め

**Criticalの場合（カードデータ漏洩の疑い）:**
1. Webサーバーを即時停止（`docker compose down`）
2. 証拠保全: ログファイル・DBスナップショットを保全
3. PAY.JPに連絡しアカウント一時停止を依頼
4. DNS/Cloudflareでメンテナンスページに切り替え

**Highの場合（サービス停止）:**
1. 原因特定（DB / API / nginx / 外部サービス）
2. 該当コンポーネントの再起動を試行
3. 復旧しない場合はバックアップからのリストアを検討

**Webhook処理障害（Medium）:**
1. `member_impact_logs` で影響範囲を確認
2. 手動resync CLIで対応: `node resync-cli.js --all`
3. 6時間超継続の場合はエスカレーション（implementation-design-mvp.md §23準拠）

### 4.2 調査

- nginx / アプリケーションログから時系列を再構成
- `payjp_events` テーブルで処理結果の異常を確認
- DB接続ログで不正アクセスの痕跡を確認
- 必要に応じてサーバーのシステムログ（`/var/log/auth.log` 等）を確認

### 4.3 ペイメントブランド・アクワイアラへの通知

**カードデータ漏洩が確認または強く疑われる場合:**
1. PAY.JPに即時報告（加盟店契約の通知義務に準拠）
2. PAY.JPの指示に従いペイメントブランド（Visa / Mastercard等）への報告を実施
3. 通知内容: 発覚日時、影響範囲、封じ込め状況、初期調査結果

## 5. 復旧手順

| シナリオ | 手順 |
|---|---|
| DB障害 | `scripts/backup-db.sh` のバックアップから `pg_restore` でリストア |
| Webページ改ざん | Gitリポジトリから `git checkout` + フロントエンド再ビルド + nginx再起動 |
| PAY.JP API障害 | PAY.JP側復旧を待機 → 復旧後に `resync-cli --all` で同期 |
| Discord API障害 | Discord側復旧を待機 → 復旧後にロール同期を手動実行 |

## 6. データバックアップ

- バックアップ: `scripts/backup-db.sh`（日次、7日間保持）
- RTO（目標復旧時間）: 4時間
- RPO（目標復旧時点）: 24時間（日次バックアップ間隔）

## 7. 法的要件

- 個人情報保護法に基づく個人データ漏洩時の報告義務（個人情報保護委員会への報告）
- 報告期限: 速報は事態認知後速やかに、確報は30日以内
- 本人への通知義務

## 8. 事後レビュー

- インシデント収束後5営業日以内に事後レビューを実施
- レビュー内容:
  - 時系列（タイムライン）
  - 根本原因分析
  - 対応の適切性評価
  - 再発防止策
- レビュー結果を記録・保管する
