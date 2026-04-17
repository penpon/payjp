# PCI Readiness Summary（リポジトリ証跡ベース）

**目的**: 審査・Go-Live 説明用の **一行判断** と、論点ごとの分類をまとめる。  
**最終更新**: 2026-04-12

## 総合判断

- **カード非保持・3DS・operationId 失敗クローズ・ヘッダ基本統制** はコードと文書で説明可能。
- **11.6.1 完全自動化**（CSP レポート集約等）は未実装。一方 **CI の静的検証**（[`scripts/dev/check-payment-page-security.ts`](../../scripts/dev/check-payment-page-security.ts)）でスクリプト許可・CSP 整合を毎 PR 確認する。運用手順・台帳は [pci-payment-page-monitoring.md](pci-payment-page-monitoring.md)・[pci-payment-page-script-register.md](pci-payment-page-script-register.md)。
- **MFA・ASV・法務本番値・TPSP 証跡の実物** は Git 外作業。一覧は [pci-readiness-gap-matrix.md](pci-readiness-gap-matrix.md)。申請前の実施順は [docs/evidence/SCREENING-EXTERNAL-EVIDENCE-CHECKLIST.md](../evidence/SCREENING-EXTERNAL-EVIDENCE-CHECKLIST.md)。

## 論点別ラベル

| ラベル | 意味 |
|--------|------|
| **fixed_in_repo** | 実装・設定・本リポジトリの Markdown で説明可能 |
| **compensating_control** | 運用手順・定期レビュー・台帳で説明（自動検知は別） |
| **requires_external_evidence** | ダッシュボード・スキャン・法務・社内保管が必要 |

| 論点 | ラベル | 参照 |
|------|--------|------|
| PAN 非送信・トークンのみ | fixed_in_repo | [frontend/src/billing-ui.ts](../../frontend/src/billing-ui.ts)、[packages/server/src/routes/billing.routes.ts](../../packages/server/src/routes/billing.routes.ts) |
| 3DS verified・503 + operationId | fixed_in_repo | [packages/billing-service](../../packages/billing-service) |
| 静的 CSP・決済ページ表面 | fixed_in_repo | [nginx/security-headers.conf](../../nginx/security-headers.conf)（単一真実源）、[frontend/member.html](../../frontend/member.html)（`/member`、PAY.JP SPA マウント） |
| pay.js SRI なし | compensating_control（制限の明示） | [pci-script-security-confirmation.md](pci-script-security-confirmation.md) |
| 11.6.1 改ざん検知 | compensating_control + CI 静的ガード | [pci-payment-page-monitoring.md](pci-payment-page-monitoring.md)、[pci-incident-response-plan.md](pci-incident-response-plan.md)、[`scripts/dev/check-payment-page-security.ts`](../../scripts/dev/check-payment-page-security.ts) |
| Go-Live 証跡の実填 | requires_external_evidence | [docs/evidence/README.md](../evidence/README.md) |
| PAY.JP MFA | requires_external_evidence | [TEMPLATE-mfa-check.md](../evidence/TEMPLATE-mfa-check.md) |
| ASV | requires_external_evidence | [pci-asv-scan-policy.md](pci-asv-scan-policy.md) |
| 法務ページ本番値 | requires_external_evidence | [TEMPLATE-legal-page-verification.md](../evidence/TEMPLATE-legal-page-verification.md) |
| WAF・CSP/HSTS「強化」を新要件としての追加 | out_of_scope（MVP） | [2weeks-spec.md](../2weeks-spec.md) §3 非スコープ item 6（既存ヘッダ・文書整備は本リリースの PCI 準備作業として実施） |

## 正本仕様との関係

MVP の機能正本（[2weeks-spec.md](../2weeks-spec.md)、[implementation-design-mvp.md](../implementation-design-mvp.md)、[tdd-acceptance-matrix-mvp.md](../tdd-acceptance-matrix-mvp.md)）は **本サマリでは変更しない**。将来 hosted/redirect 等へ切り替える場合は Change Request として別途更新する（[payjp-hosted-redirect-option.md](../payjp-hosted-redirect-option.md)）。
