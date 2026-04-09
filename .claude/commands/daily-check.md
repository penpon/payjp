---
description: プロジェクトの日次健全性チェック
---
以下の順序でプロジェクトの健全性を確認して:

1. `git status` で未コミットの変更を確認
2. `npm test` でテスト全パスを確認（各 workspace）
3. `npx biome check .` でlintエラーを確認
4. `gh issue list --milestone "MVP Go-Live" --state all` でIssue進捗を確認
5. 直近のコミット履歴（`git log --oneline -5`）を確認

結果を以下の形式でサマリ出力:

```
## Daily Check — YYYY-MM-DD
- [ ] Git: クリーン / 未コミット変更あり
- [ ] Tests: 全パス / N件失敗
- [ ] Lint: クリーン / N件エラー
- [ ] Issues: N/M 完了（MVP Go-Live）
```

問題があれば対処案も提示する。
