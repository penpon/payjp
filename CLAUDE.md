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

## 開発ワークフロー（VCSDD 主軸）

- サービス単位でフィーチャー管理（auth / billing / sync）
- フェーズ順: `/vcsdd-spec` → `/vcsdd-spec-review` → `/vcsdd-tdd` → `/vcsdd-impl` → `/vcsdd-adversary` → `/vcsdd-harden` → `/vcsdd-converge`
- コミット: `/vcsdd-commit`（フェーズ完了時）

## ツール使い分け

- セマンティックコード操作: mcp-serena（シンボル検索・編集）
- ライブラリドキュメント: mcp-context7（PAY.JP / Discord API / Node.js 等）
- GitHub 操作: mcp-github（PR作成・マージ・ステータス）
- ブラウザ: mcp-playwright

## 品質ゲート（必須）

- コミット前: `/quality-check`
- PR 作成前: `/vcsdd-adversary` PASS 必須
- Go-Live 判定: T-P0-01〜T-P0-07 全 PASS 必須

## 実装上の固定ルール

- `inflight_operation_*` 解除は手動 CLI のみ（日次ジョブ・自動解除禁止）
- PAY.JP 書き込みは `operationId` 保存後に実施
- `__Host-` Cookie は §6 固定属性から変更不可
- 3DS `verified` 未確認の payjpToken は拒否（`attempted` も非許容）
- 不確定失敗は必ず `503 + operationId` を返し、クライアント自動再試行禁止
