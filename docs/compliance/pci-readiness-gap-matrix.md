# PCI / PAY.JP Readiness Gap Matrix

**目的**: 審査・Go-Live に向け、各論点を **実装済み / 文書のみ / 外部証跡が必要 / MVP非スコープ・未対応** に分類する。  
**正本**: [docs/2weeks-spec.md](../2weeks-spec.md)、[docs/implementation-design-mvp.md](../implementation-design-mvp.md)、[docs/tdd-acceptance-matrix-mvp.md](../tdd-acceptance-matrix-mvp.md) は本マトリクスでは変更しない。

最終更新: 2026-04-12

## 凡例

| 分類 | 意味 |
|------|------|
| **implemented** | リポジトリのコード・設定で説明可能 |
| **documented_only** | 運用・設計は文書化済みだが、自動検知や本番証跡は別途 |
| **external_evidence_needed** | ダッシュボード・ASV・法務ページ等、Git 外で完了証跡を取る必要あり |
| **out_of_scope_mvp** | 現行 MVP 仕様で明示的に対象外または将来拡張 |

## マトリクス

| # | 論点 | 分類 | 根拠（リポジトリ） | 補足 |
|---|------|------|-------------------|------|
| 1 | カード非保持（PAN 非送信） | implemented | [frontend/src/billing-ui.ts](../../frontend/src/billing-ui.ts)、[packages/server/src/routes/billing.routes.ts](../../packages/server/src/routes/billing.routes.ts) | トークンのみ送信 |
| 2 | PAY.JP.js iframe / `pay.js` | implemented | [frontend/member.html](../../frontend/member.html)（`/member`） | 外部スクリプトは `js.pay.jp` のみ（[pci-payment-page-script-register.md](pci-payment-page-script-register.md)） |
| 3 | 3DS `verified` 強制 | implemented | [packages/billing-service/src/core/index.ts](../../packages/billing-service/src/core/index.ts) | |
| 4 | `operationId` 保存・曖昧失敗 503 | implemented | [packages/billing-service/src/shell/subscribe.ts](../../packages/billing-service/src/shell/subscribe.ts) | |
| 5 | API のセキュリティヘッダ（JSON API） | implemented | [packages/server/src/app.ts](../../packages/server/src/app.ts) | `default-src 'none'` 等（購読 UI とは別オリジン想定） |
| 6 | 静的フロントの CSP / ヘッダ | implemented | [nginx/security-headers.conf](../../nginx/security-headers.conf)（単一真実源。`_headers` ファイルは廃止） | [pci-script-security-confirmation.md](pci-script-security-confirmation.md) と整合 |
| 7 | `pay.js` の SRI | documented_only | [docs/compliance/pci-script-security-confirmation.md](pci-script-security-confirmation.md) | PAY.JP がハッシュ非公開のため未付与を明示 |
| 8 | Req 11.6.1 相当（改ざん検知） | documented_only | [docs/compliance/pci-payment-page-monitoring.md](pci-payment-page-monitoring.md)、[docs/compliance/pci-incident-response-plan.md](pci-incident-response-plan.md) | 自動 CSP レポート受信は MVP では未実装。補償的統制として手順・レビューを文書化 |
| 9 | Go-Live 証跡パッケージ | external_evidence_needed | [docs/evidence/README.md](../evidence/README.md) | テンプレートはリポジトリ。実施記録は日付入りファイルで追記 |
| 10 | PAY.JP ダッシュボード MFA | external_evidence_needed | [docs/ops/production-readiness-checklist.md](../ops/production-readiness-checklist.md) | コードからは証明不可 |
| 11 | ASV スキャン | external_evidence_needed | [docs/compliance/pci-asv-scan-policy.md](pci-asv-scan-policy.md) | 実行・レポート保管は社外 |
| 12 | PAY.JP への ASV/提出先確認 | external_evidence_needed | [docs/compliance/pci-asv-scan-policy.md](pci-asv-scan-policy.md) | 回答は `docs/evidence/` にメモ |
| 13 | TPSP 規約・AOC 確認 | external_evidence_needed | [docs/compliance/pci-tpsp-management.md](pci-tpsp-management.md) | 機密はリポジトリ外 |
| 14 | 法務ページ本番値 | external_evidence_needed | [docs/ops/production-readiness-checklist.md](../ops/production-readiness-checklist.md) | [TEMPLATE-legal-page-verification.md](../evidence/TEMPLATE-legal-page-verification.md) |
| 15 | WAF / 高度自動監視 | out_of_scope_mvp | [docs/2weeks-spec.md](../2weeks-spec.md) | MVP 非スコープ |

## 次のアクション（本マトリクスからの派生）

- **リポジトリ内**: 決済ページ表面の最小化、スクリプト台帳・監視手順、証跡テンプレート整備（本リリースのドキュメント群）。
- **リポジトリ外**: MFA、ASV、PAY.JP 問い合わせ、法務ページ・規約の実確認と記録保管。
- **審査申請前**: `external_evidence_needed` の実施順・テンプレ対応表は [docs/evidence/SCREENING-EXTERNAL-EVIDENCE-CHECKLIST.md](../evidence/SCREENING-EXTERNAL-EVIDENCE-CHECKLIST.md)。審査説明メモは [docs/payjp-screening-review-brief.md](../payjp-screening-review-brief.md)。

総合サマリは [pci-readiness-summary.md](pci-readiness-summary.md) を参照。
