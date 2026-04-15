# Contributing

## ブランチ運用

- `main` で直接実装しない
- 作業ブランチ命名: `feat/issue-N-<subject>` (Issue 駆動) / `chore/<topic>` / `docs/<topic>` / `fix/<topic>`
- worktree 用ディレクトリは `feature/<branch-name>/` (`.gitignore` 済、**削除禁止**)

## PR フロー

1. `npm test` / `node_modules/.bin/tsc --noEmit` が pass (lefthook pre-commit で自動、`--no-verify` 禁止)
2. `npm run lint` で Biome violation ゼロ
3. PR タイトル形式: `<type>(<scope>): <summary>` (conventional commits)
4. PR 本文: `.github/PULL_REQUEST_TEMPLATE.md` の checklist を埋める
5. `Fixes #N` で Issue を自動クローズ

## 仕様変更 (3 本柱同期)

`docs/2weeks-spec.md` / `docs/implementation-design-mvp.md` / `docs/tdd-acceptance-matrix-mvp.md` の変更は **Change Request として全 3 ファイルを同期**する。MVP 非スコープ機能 (admin UI 拡張、DLQ、高度監視) は新 CR 承認なしに入れない。

## ビジネスロジック変更

`packages/auth-service` / `billing-service` / `sync-service` の pure core / shell 層は **VCSDD パイプライン**を経由する:

- `/vcsdd-spec` → `/vcsdd-spec-review` → `/vcsdd-tdd` → `/vcsdd-impl` → `/vcsdd-adversary` → `/vcsdd-harden` → `/vcsdd-converge`
- VCSDD 完了済 feature の contract 変更は sprint contract 更新も必須 (`.vcsdd/features/<feature>/contracts/sprint-N.md`)

## 環境

- Node.js 22+、Docker + Docker Compose
- `.env` に `op://` 参照を含む場合: `npm run docker:up` もしくは `bash scripts/local/docker-compose-op.sh up --build` (1Password CLI sign-in 必須)
- `.env*` は Claude / ローカルツールで読み取り禁止。値は `op read` / `op run` で per-item / per-process 注入

## Code Review

- 実装完了ごとに **3 段レビュー**:
  1. `/code-review` — コード品質・バグ・ロジックエラー
  2. `/pr-review-toolkit:review-pr` — 型設計・テスト網羅・コメント精度・silent failure
  3. `code-simplifier` (`pr-review-toolkit:code-simplifier`) — 簡素化・可読性
- `security-guidance` hook は Edit/Write 時に自動発火 (手動起動不要)

## 参考

- ディレクトリ構成: [docs/README.md](docs/README.md)
- 運用手順: [docs/ops/README.md](docs/ops/README.md)
- 環境変数: [docs/ops/environment-variables.md](docs/ops/environment-variables.md)
- 脆弱性報告: [SECURITY.md](SECURITY.md)
- ツール選択・レビューエージェント: `.claude/rules/agents.md`, `.claude/rules/workflow.md`
