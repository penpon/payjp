# 決済ページ監視・改ざん対応（11.6.1 相当の補償的統制）

**目的**: PCI DSS 11.6.1（決済ページの改ざん検知等）を、**現行の `payjp.js iframe` + CSP** のまま、審査で説明可能な形にする。  
ブラウザからの CSP レポート自動集約は未実装だが、**リポジトリと CI 上の静的検証**でスクリプト許可リスト・CSP 二重定義の整合を毎 PR 確認する。

**関連**: [pci-payment-page-script-register.md](pci-payment-page-script-register.md)、[pci-incident-response-plan.md](pci-incident-response-plan.md)、[pci-readiness-gap-matrix.md](pci-readiness-gap-matrix.md)

最終更新: 2026-04-12

## 0. 自動チェック（静的 + 任意の本番）

| コマンド | 内容 |
|----------|------|
| `npm run check:payment-security` | `frontend/member.html` / `frontend/dist/member.html` のスクリプト許可、`frontend/public/*.html` の Google Fonts 禁止（現在 HTML ファイルは存在せず no-op、将来の誤追加を抑止）、nginx CSP と `EXPECTED_CSP` の一致 |
| `PAYMENT_PAGE_URL=https://…/member npm run check:payment-security:live` | 本番 HTTPS 取得でヘッダ（CSP / HSTS / XFO）と HTML 許可リストを検証（PR CI では実行しない） |

実装: [`scripts/dev/check-payment-page-security.ts`](../../scripts/dev/check-payment-page-security.ts)。`EXPECTED_CSP` は nginx `security-headers.conf` と同期すること（`_headers` ファイルは廃止）。

## 1. 監視対象

| 対象 | 確認内容 |
|------|----------|
| リポジトリ上の `frontend/member.html` | 追加の `<script src>` がないこと。`pay.js` の URL が `https://js.pay.jp/v2/pay.js` のみであること |
| ビルド設定・エントリ | 新たな第三者スクリプトの注入がないこと（`package.json` / Vite 設定の変更レビュー） |
| CSP 定義 | [nginx/security-headers.conf](../../nginx/security-headers.conf) が `EXPECTED_CSP` と一致していること（nginx 単一真実源。CI の `npm run check:payment-security` で検証） |
| 本番応答ヘッダ | デプロイ後、`npm run check:payment-security:live`、または実ブラウザ / `curl -I` で CSP・HSTS 等が期待どおりであること |

## 2. 検知シナリオと対応

| 兆候 | 想定原因 | 初動 |
|------|----------|------|
| 未知のドメインからの `<script>` が本番 HTML に現れた | 侵害・誤デプロイ | [pci-incident-response-plan.md](pci-incident-response-plan.md) §4.1 Critical に準じて封じ込め・証拠保全 |
| CSP 違反がブラウザコンソールに多発 | 設定ミス、CDN キャッシュ不整合 | デプロイロールバック、nginx `security-headers.conf` と `EXPECTED_CSP` の差分確認 |
| `pay.js` の挙動異常（決済失敗急増） | PAY.JP 側または通信経路 | PAY.JP ステータス・サポート確認、必要に応じて [pci-incident-response-plan.md](pci-incident-response-plan.md) の外部連絡 |

## 3. レビュー頻度と担当

| 活動 | 頻度 | 担当 | 記録先 |
|------|------|------|--------|
| `member.html` とスクリプト台帳の突合 | Go-Live 直前、およびフロント変更のたび | 技術担当 | PR レビュー + 必要なら [evidence/TEMPLATE-pci-payment-page-review.md](../evidence/TEMPLATE-pci-payment-page-review.md) |
| CSP 二重定義の整合確認 | インフラ変更時 | 技術担当 | デプロイチェックリスト |
| 本番 URL のヘッダスポットチェック | 月次（運用負荷に応じて四半期に緩和可） | 技術担当 | メモを `docs/evidence/YYYYMMDD-*.md` に残す運用可 |

## 4. CSP レポート受信（report-uri / Reporting API）について

- **現状**: ブラウザから CSP 違反を **本サービスが自動集約するエンドポイント**は実装していない。API サーバ（[packages/server/src/app.ts](../../packages/server/src/app.ts)）は JSON API 用の厳格な CSP を返しており、**静的購読ページのオリジンとは別**である。
- **将来**: 同一オリジンで違反レポートを受け取る場合は、専用ルートの追加・個人情報の取扱い・レート制限を設計したうえで Change Request を検討する。
- **現行の補償**: 上記の定期レビュー、デプロイ前後のヘッダ確認、インシデント計画との連動。

## 5. エスカレーション

異常検知後の連絡先・手順は [pci-incident-response-plan.md](pci-incident-response-plan.md) および [ops/incident-contacts.md](../ops/incident-contacts.md) に従う。
