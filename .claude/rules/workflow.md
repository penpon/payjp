# 開発ワークフロー詳細

## ブランチ運用
- Issue着手時は必ず作業ブランチを切る（例: `feat/issue-3-billing-routes`）
- main ブランチで直接実装しない

## 実装フェーズ — タスク特性に応じてツールを選択

| ツール | 用途 | 適するIssue |
|---|---|---|
| `/feature-dev` | 設計判断が必要な新機能（7フェーズ構造化開発） | #16 退会フロー, #20 E2Eハーネス |
| `/ralph-loop` | 仕様確定済み＋テスト全パスが完了条件（TDD自動反復） | #17 共通エラーUI, #21-#22・#37-#43・#46-#49 E2Eシナリオ |
| `/ui-ux-pro-max` | UI/UX品質基準（アクセシビリティ・配色・フォントペアリング） | #16, #17 frontend |
| `/frontend-design` | ビジュアル美学・創造的デザイン方向性（「AI slop」回避） | #16, #17 frontend |
| 手動検証 | リリース判定・文書最終化（コード実装なし） | #44 Go-Live検証, #45 運用文書 |

フロントエンド実装・修正時は `/ui-ux-pro-max` + `/frontend-design` を**併用必須**。

## E2E（Playwright）

- 方針・仕様との対応・セレクタの考え方: **`.claude/rules/e2e.md`**
- 実行コマンド・タイムアウト・webServer・ローカル Cookie 前提: ルートの **`playwright.config.ts`**

## レビューフェーズ — 実装完了後に必ず順次実行

1. `/code-review` — コード品質・バグ・ロジックエラーの検出
2. `/pr-review-toolkit:review-pr` — 包括レビュー：型設計・テスト網羅・コメント精度・サイレント障害
3. `code-simplifier` — コード簡素化・可読性向上（Agent `pr-review-toolkit:code-simplifier`）

※ `security-guidance` はフックとして自動実行（Edit/Write時に発火）

## コミット・PRフェーズ

- `/commit-commands:commit` — git commit 作成（pre-commitフックでbiome等が自動実行）
- PR作成時は `/commit-commands:commit-push-pr` を実行
- コミットメッセージに `Fixes #N` を含めてIssue自動クローズ

## デバッグ

- 問題発生時は `/debug` コマンドで構造化デバッグフローを使用
- `/investigate` スキルも利用可能（系統的な根本原因調査）
- チェックポイント保存は `/checkpoint` スキルで実行
