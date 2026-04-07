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

#### ブランチ運用

- Issue着手時は必ず作業ブランチを切る（例: `feat/issue-3-billing-routes`）
- main ブランチで直接実装しない

#### 実装フェーズ — タスク特性に応じてツールを選択

| ツール | 用途 | 適するIssue |
|---|---|---|
| `/feature-dev` | 設計判断が必要な新機能（7フェーズ構造化開発） | #16 退会フロー, #20 E2Eハーネス |
| `/ralph-loop` | 仕様確定済み＋テスト全パスが完了条件（TDD自動反復） | #17 共通エラーUI, #21-#22 E2Eシナリオ |
| `/ui-ux-pro-max` | フロントエンドUI/UX設計・スタイル・カラー・フォント選定 | #16, #17 frontend |

#### Issue 別推奨モデル

| Issue | 推奨モデル | 理由 |
|---|---|---|
| #16 退会フロー | opus high effort | 多コンポーネントUI（ボタン・モーダル・完了画面）＋詳細デザイン仕様を同時参照 |
| #17 共通エラーUI | sonnet high effort | 仕様確定済みリファクタ、エラーコード別UIの実装 |
| #18 Docker Compose | sonnet high effort | インフラ設定・構成確認、推論より実装重視 |
| #19 Cloudflare Pages | sonnet high effort | デプロイ設定確認、ドキュメント作業 |
| #20 E2Eハーネス | opus medium effort | 複数サービス統合アーキテクチャ設計、1M Windowで仕様＋全サービスコード同時参照 |
| #21 Webhook E2E | sonnet high effort | #20 で確立したパターンへの追加、シナリオ仕様明確 |
| #22 Cancel E2E | sonnet high effort | 同上 |
| #23 T-P0 Go-Live検証 | opus medium effort | T-P0-01〜07 の仕様文書を横断参照しながら検証、1M Windowで全T-P0仕様＋テスト結果を保持 |
| #24 運用文書 | sonnet high effort | 文書整理・ベンダー確認チェックリスト作成 |

フロントエンド実装・修正時は `/ui-ux-pro-max` を**必須で使用**し、デザインシステム・配色・タイポグラフィ・UXガイドラインの判断に利用すること。CSS・HTML・UIコンポーネントの変更が含まれる場合は必ず `/ui-ux-pro-max` を通すこと。

#### レビューフェーズ — 実装完了後に必ず順次実行

1. `/code-review` — コード品質・バグ・ロジックエラーの検出（スキル）
2. `/pr-review-toolkit:review-pr` — 包括レビュー：型設計・テスト網羅・コメント精度・サイレント障害（スキル）
3. `code-simplifier` — コード簡素化・可読性向上（Agent サブエージェント `pr-review-toolkit:code-simplifier`）

※ `security-guidance` はフックとして自動実行（Edit/Write時に発火）、手動呼び出し不要

#### コミット・PRフェーズ — レビュー指摘の修正完了後

- `/commit-commands:commit` — git commit を作成（pre-commitフックでbiome等が自動実行）
- PR作成時は `/commit-commands:commit-push-pr` を実行
- コミットメッセージに `Fixes #N` を含めてIssue自動クローズ

## ツール使い分け

- セマンティックコード操作: mcp-serena（シンボル検索・編集）
- ライブラリドキュメント: mcp-context7（PAY.JP / Discord API / Node.js 等）
- GitHub 操作: mcp-github（PR作成・マージ・ステータス）
- ブラウザ: mcp-playwright

## 品質ゲート（必須）

- VCSDD対象（ビジネスロジック変更時）: `/vcsdd-adversary` PASS 必須
- Issue対象（統合レイヤー）: `/code-review` → `/pr-review-toolkit:review-pr` → `pr-review-toolkit:code-simplifier`（3ステップ必須、`security-guidance` はフック自動実行）
- Go-Live 判定: T-P0-01〜T-P0-07 全 PASS 必須

## 実装上の固定ルール

- `inflight_operation_*` 解除は手動 CLI のみ（日次ジョブ・自動解除禁止）
- PAY.JP 書き込みは `operationId` 保存後に実施
- `__Host-` Cookie は §6 固定属性から変更不可
- 3DS `verified` 未確認の payjpToken は拒否（`attempted` も非許容）
- 不確定失敗は必ず `503 + operationId` を返し、クライアント自動再試行禁止
