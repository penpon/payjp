---
description: GitHub Issue着手時のセットアップ（ブランチ作成→仕様読み込み→計画）
---
Issue #$ARGUMENTS の実装を開始する:

1. **Issue読み込み**: `gh issue view $ARGUMENTS` でIssue本文と依存関係を確認
2. **依存確認**: Issue本文に記載の依存Issueが完了済みか `gh issue view` で確認
3. **ブランチ作成**: `git checkout -b feat/issue-$ARGUMENTS-<slug>` で作業ブランチを作成（main から分岐）
4. **仕様確認**: `2weeks-spec.md` の該当セクションを読み、MVPスコープを確認
5. **計画提示**: Plan Mode で実装計画を提示し、ユーザーの承認を得る

## ツール選択ガイド
CLAUDE.md の Issue別推奨モデル・ツール表を参照し、適切なツールを提案:
- 設計判断が必要 → `/feature-dev`
- 仕様確定済み＋テスト全パスが完了条件 → `/ralph-loop`

フロントエンド変更を含む場合は `/ui-ux-pro-max` + `/frontend-design` の併用を必ず提案する。
