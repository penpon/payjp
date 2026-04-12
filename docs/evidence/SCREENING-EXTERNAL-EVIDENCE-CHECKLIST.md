# PAY.JP 審査・外部証跡チェックリスト（`external_evidence_needed` 対応）

**目的**: [pci-readiness-gap-matrix.md](../pci-readiness-gap-matrix.md) の **external_evidence_needed** および [production-readiness-checklist.md](../ops/production-readiness-checklist.md) の項目を、申請前に **実施・記録** するための一覧にする。  
**本ファイル**: 手順の索引（リポジトリ管理可）。**個人情報・画面キャプチャの全文**は社内保管とし、ここには **実施日・Pass-Fail・テンプレート名・チケット参照** のみを書く。

## 1. 法務ページ・公開 URL（審査員がログインなしで閲覧）

| 確認 | テンプレート / 参照 | 記録の付け方 |
|------|---------------------|--------------|
| 特商法・規約・PP・返金・問い合わせが本番 URL で開ける | [TEMPLATE-legal-page-verification.md](./TEMPLATE-legal-page-verification.md) | `YYYYMMDD-legal-page-verification.md` を作成 |
| 事業者名・住所・連絡先が PAY.JP 登録と一致 | 同上、§7 [production-readiness-checklist.md](../ops/production-readiness-checklist.md) | 差分は Issue / チケット番号のみ |
| 商材・料金・流れがログインなしで説明できる | 静的 [frontend/public/service.html](../../frontend/public/service.html)、トップ [frontend/index.html](../../frontend/index.html) | 本番 URL をテンプレートに記載 |

## 2. PAY.JP ダッシュボード（MFA 等）

| 確認 | テンプレート / 参照 | 記録の付け方 |
|------|---------------------|--------------|
| 本番鍵・Webhook・プラン ID | [production-readiness-checklist.md](../ops/production-readiness-checklist.md) §4 | 運用メモ（機密は書かない） |
| MFA（TOTP）有効 | [TEMPLATE-mfa-check.md](./TEMPLATE-mfa-check.md) | Pass/Fail と実施日。キャプチャはリポジトリ外 |

## 3. 決済・3DS・非保持（実機証跡）

| 確認 | テンプレート / 参照 | 記録の付け方 |
|------|---------------------|--------------|
| 3DS `verified` のみ課金 | [tdd-acceptance-matrix-mvp.md](../tdd-acceptance-matrix-mvp.md) T-P0、[TEMPLATE-pci-payment-page-review.md](./TEMPLATE-pci-payment-page-review.md) | `YYYYMMDD` 付きファイル |
| カード番号が自サーバに保存されない | コード根拠は [pci-readiness-summary.md](../pci-readiness-summary.md)。実機はスモーク記録 | T-P0 / Day10 スモーク |

## 4. ASV・TPSP・PAY.JP 問い合わせ

| 確認 | テンプレート / 参照 | 記録の付け方 |
|------|---------------------|--------------|
| ASV 方針・提出先 | [pci-asv-scan-policy.md](../pci-asv-scan-policy.md) | `YYYYMMDD-asv-payjp-inquiry.md` |
| TPSP 規約・AOC | [pci-tpsp-management.md](../pci-tpsp-management.md) | 機密は社外保管、要約のみ Git |

## 5. 審査説明メモ（社内・申請画面メモ用）

| 内容 | 参照 |
|------|------|
| 3DS・PAN 非保持・解約フロー | [payjp-screening-review-brief.md](../payjp-screening-review-brief.md) |

---

**実施完了後**: [docs/evidence/README.md](./README.md) の命名規則に従い、日付入りファイルを追加する。
