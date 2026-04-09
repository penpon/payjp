# PAY.JP × Discord 連携サービス — Claude 設定

## 仕様文書の正本階層

1. `2weeks-spec.md` — 機能仕様（Go-Live判定の正本）
2. `implementation-design-mvp.md` — 実装設計（API契約・DBモデル・シーケンス固定）
3. `tdd-acceptance-matrix-mvp.md` — TDD受け入れ条件（T-P0-01〜T-P0-07）

仕様変更は必ず `2weeks-spec.md` への Change Request として記録し、3文書を同期する。MVP非スコープ項目（管理画面・DLQ・高度監視等）は追加しない。

## 技術スタック（確定）

- Language: TypeScript 統一（フロント・バック・CLI）
- Runtime: Node.js
- Monorepo: npm workspaces
- DB: PostgreSQL
- Discord: `@discordjs/rest`（常駐 bot 不要、REST API のみ）
- PAY.JP: `payjp` npm
- Formatter/Linter: Biome（auto-format.sh が自動適用）

## ディレクトリ構造

```
packages/
  shared/          # 型定義・DBスキーマ・共通ユーティリティ
  auth-service/    # Discord OAuth (R1)
  billing-service/ # PAY.JP課金 (R2-R5)
  sync-service/    # Webhook + ロール同期 + 手動CLIツール (R6-R8)
frontend/          # 購読UI
feature/           # git worktree 用（削除禁止）
.vcsdd/            # VCSDDパイプライン状態（削除禁止）
```

## 開発ワークフロー

### ビジネスロジック層（完了）— VCSDD

3サービスの Pure Core + Shell は VCSDD パイプラインで完成済み。
ビジネスロジックの追加・変更が発生した場合は引き続き VCSDD を使用する。

- フェーズ順: `/vcsdd-spec` → `/vcsdd-spec-review` → `/vcsdd-tdd` → `/vcsdd-impl` → `/vcsdd-adversary` → `/vcsdd-harden` → `/vcsdd-converge`
- コミット: `/vcsdd-commit`（フェーズ完了時）

### 統合レイヤー（進行中）— Issue駆動 + TDD

HTTP サーバー / DB接続 / フロントエンド / E2E / デプロイは GitHub Issue 単位で開発する。

- Milestone: `MVP Go-Live`（2026-04-20）
- Issue一覧: #1〜#10（依存関係は各Issueのbodyに記載）
- Issue着手時は `/issue-start <番号>` で開始する

詳細なワークフロー手順・ツール選択マトリクス・Issue別推奨モデルは `.claude/rules/workflow.md` を参照。

## ツール使い分け

- セマンティックコード操作: mcp-serena（シンボル検索・編集）
- ライブラリドキュメント: mcp-context7（PAY.JP / Discord API / Node.js 等）
- GitHub 操作: mcp-github（PR作成・マージ・ステータス）
- ブラウザ: mcp-playwright

## カスタムコマンド

| コマンド | 用途 |
|---|---|
| `/issue-start <番号>` | Issue着手セットアップ（ブランチ作成→仕様読み込み→計画） |
| `/daily-check` | プロジェクト日次健全性チェック |
| `/debug` | 再現→根本原因→修正→検証のデバッグワークフロー |
| `/session-end` | セッション終了時のメモリ更新・状態保存 |

## 品質ゲート（必須）

- VCSDD対象（ビジネスロジック変更時）: `/vcsdd-adversary` PASS 必須
- Issue対象（統合レイヤー）: `/code-review` → `/pr-review-toolkit:review-pr` → `pr-review-toolkit:code-simplifier`（3ステップ必須、`security-guidance` はフック自動実行）
- Go-Live 判定: T-P0-01〜T-P0-07 全 PASS 必須

## セキュリティ・実装固定ルール

詳細は `.claude/rules/security.md` を参照。要点:
- 3DS `verified` 必須、`operationId` 保存後にPAY.JP書き込み、不確定失敗は `503 + operationId`
- `__Host-` Cookie §6 固定属性変更不可
- `.env*` 読み取り禁止、シークレットは `op read` で個別取得
