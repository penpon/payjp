# 受け入れ証跡（Go-Live / T-P0 / PCI）

本ディレクトリには、[tdd-acceptance-matrix-mvp.md](../tdd-acceptance-matrix-mvp.md) §5 および [2weeks-spec.md](../2weeks-spec.md) §14 に従い、手動・CI の証跡を保存する。  
PCI / 本番準備用の記録は [pci-readiness-gap-matrix.md](../pci-readiness-gap-matrix.md) の **external_evidence_needed** 項目と対応させる。

## 優先度（Go-Live 前）

| 優先度 | 種別 | テンプレート / 例 | 備考 |
|--------|------|-------------------|------|
| P0 | T-P0-01 … T-P0-07 | [TEMPLATE.md](./TEMPLATE.md) | 受け入れマトリクス正本 |
| P0 | Day10 本番スモーク | `YYYYMMDD-day10-smoke.md`（[TEMPLATE.md](./TEMPLATE.md) を流用可） | |
| P0 | 決済ページ・スクリプトレビュー | [TEMPLATE-pci-payment-page-review.md](./TEMPLATE-pci-payment-page-review.md) | [pci-payment-page-monitoring.md](../pci-payment-page-monitoring.md) と対 |
| P1 | PAY.JP MFA 確認 | [TEMPLATE-mfa-check.md](./TEMPLATE-mfa-check.md) | スクリーンショットはリポジトリ外 |
| P1 | 法務ページ本番値 | [TEMPLATE-legal-page-verification.md](./TEMPLATE-legal-page-verification.md) | [production-readiness-checklist.md](../ops/production-readiness-checklist.md) §1, §7 |
| P1 | ASV / PAY.JP 問い合わせ | `YYYYMMDD-asv-payjp-inquiry.md` | [pci-asv-scan-policy.md](../pci-asv-scan-policy.md) |
| P2 | 503 復旧 CLI リハーサル | `YYYYMMDD-cli-recovery-rehearsal.md` | |
| P2 | cancel 事前検証 | `YYYYMMDD-cancel-precheck.md` | |

## 命名規則

```
YYYYMMDD-<topic>.md
```

例: `20260416-T-P0-02.md`、`20260418-pci-payment-page-review.md`

## 汎用テンプレート

- [TEMPLATE.md](./TEMPLATE.md) — T-P0 やスモーク全般
- PCI 特化の短いテンプレートは上表の `TEMPLATE-*.md` をコピーする

**機密**（APIキー、生ログのトークン、個人情報）は **リポジトリに含めない**。要約とファイルパス（社内ストレージ）で代替する。

## 運用メモ

- Git で管理するのは **実施事実・日付・Pass/Fail・チケット参照** に留める。
- 本番スキャンレポート全文・身分を特定しうるスクリーンショットは **社内保管**（[pci-asv-scan-policy.md](../pci-asv-scan-policy.md)）。
