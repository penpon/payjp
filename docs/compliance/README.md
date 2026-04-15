# PCI / コンプライアンス関連ドキュメント

PAY.JP iframe (`payjp.js`) 型の決済ページを前提とした、PCI DSS v4.0.1 SAQ A 適用のための文書集約。

## 目次

| # | ファイル | 目的 |
|---|---|---|
| 1 | [pci-readiness-summary.md](pci-readiness-summary.md) | 総合サマリ (短文、判定・ラベル) |
| 2 | [pci-readiness-gap-matrix.md](pci-readiness-gap-matrix.md) | 全論点を implemented / documented_only / external_evidence_needed / out_of_scope_mvp に分類 |
| 3 | [pci-access-control-policy.md](pci-access-control-policy.md) | 本番資産へのアクセス制御方針 |
| 4 | [pci-incident-response-plan.md](pci-incident-response-plan.md) | インシデント分類・連絡・時系列記録フロー |
| 5 | [pci-asv-scan-policy.md](pci-asv-scan-policy.md) | ASV スキャン方針・PAY.JP 問い合わせ手順 |
| 6 | [pci-tpsp-management.md](pci-tpsp-management.md) | TPSP (PAY.JP) 規約・AOC 管理 |
| 7 | [pci-payment-page-monitoring.md](pci-payment-page-monitoring.md) | 決済ページ監視手順 (補償的統制) |
| 8 | [pci-payment-page-script-register.md](pci-payment-page-script-register.md) | 決済ページ読込スクリプト台帳 |
| 9 | [pci-script-security-confirmation.md](pci-script-security-confirmation.md) | `pay.js` SRI 制約・補完統制 |

## 正本との関係

仕様正本は docs 直下:
- [../2weeks-spec.md](../2weeks-spec.md)
- [../implementation-design-mvp.md](../implementation-design-mvp.md)
- [../tdd-acceptance-matrix-mvp.md](../tdd-acceptance-matrix-mvp.md)

本ディレクトリのドキュメントは仕様正本を変更せず、PCI 準備観点で **補完する文書**。

## 外部参照元 (公式 PDF)

- PCI DSS v4.0.1 公式: https://www.pcisecuritystandards.org/document_library/
- SAQ A v4.0.1 r1: 同上 (検索キーワード `SAQ A v4.0.1`)

公式 PDF はリポジトリに含めない (常に最新版を URL から取得)。

## 証跡 (別ディレクトリ)

実施・レビュー・外部問い合わせの記録は [../evidence/](../evidence/) に日付付きで保存する。テンプレートは evidence/README.md 参照。
