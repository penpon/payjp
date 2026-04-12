# 受け入れ証跡

- 実施日時: YYYY-MM-DD HH:MM (TZ)
- テストID: T-P0-XX（または Day10 スモーク等）
- 実施者: （氏名またはイニシャル）

## 実行コマンドまたは手順

```bash
# 例: npm test / npm run e2e / npm run resync -- --operation-id <id>
```

## 結果

- [ ] Pass / [ ] Fail

## 証跡（いずれか1つ以上）

- CI 実行ID: （GitHub Actions 等）
- または 主要ログ参照: （ファイル名・行範囲・保存先）

## 備考

（再実行理由、不具合修正後の再実行範囲など）

## 運用確認（該当時）

- 前日 `payjp_events` failed 件数 / 503 件数 / `member_impact_logs` 未解決件数
- `DAILY_RESYNC_CRON` 本番値・直近成功ログ
