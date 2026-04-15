# docs/ ナビゲーション

このディレクトリには PAY.JP × Discord 連携サービス MVP の仕様・設計・運用・準拠関連のドキュメントが置かれている。

## フォルダ構成

| パス | 用途 |
|---|---|
| `2weeks-spec.md` | 機能仕様・Go-Live 判定 (**正本**) |
| `implementation-design-mvp.md` | API 契約・DB モデル・シーケンス (**正本**) |
| `tdd-acceptance-matrix-mvp.md` | T-P0-01 〜 T-P0-07 受け入れテスト表 (**正本**) |
| `admin-console-boundary.md` | admin console の境界 (CR-005) |
| `payjp-hosted-redirect-option.md` | 将来 PAY.JP hosted に切替する場合の検討メモ |
| `payjp-screening-review-brief.md` | PAY.JP 加盟店審査向け説明メモ |
| [`compliance/`](compliance/README.md) | PCI DSS v4.0.1 SAQ A 対応文書 9 本 + 索引 |
| `evidence/` | 実施記録・証跡 (日付付き)、テンプレートあり |
| `legal/` | 自作プライバシーポリシー PDF |
| [`ops/`](ops/README.md) | 運用ドキュメント (runbook / incident / checklist) |
| [`testing/`](testing/README.md) | テスト戦略 (E2E / system P0) |

## 仕様変更時のルール (3 本柱同期)

- 機能仕様の変更は `2weeks-spec.md` に Change Request として記録
- 同時に `implementation-design-mvp.md` と `tdd-acceptance-matrix-mvp.md` を同期更新
- MVP 非スコープの拡張 (admin UI 高機能化、DLQ、高度監視など) は新 CR 承認無しに入れない
- VCSDD 完了済の auth/billing/sync pure core / shell を変更する場合は sprint contract も更新
