# セキュリティ・実装固定ルール

## PAY.JP 決済セキュリティ
- 3DS `verified` 未確認の payjpToken は拒否（`attempted` も非許容）
- PAY.JP 書き込みは `operationId` 保存後に実施
- 不確定失敗は必ず `503 + operationId` を返し、クライアント自動再試行禁止
- `inflight_operation_*` 解除は手動 CLI のみ（日次ジョブ・自動解除禁止）

## 認証・Cookie
- `__Host-` Cookie は §6 固定属性から変更不可（Secure, Path=/, HttpOnly, SameSite=Lax）
- OAuth `state` パラメータの CSRF 検証必須

## シークレット管理
- `.env*` ファイルの読み取り禁止（`Read`, `cat`, `grep` 等すべて）
- `printenv`, `env`, `docker exec ... printenv` 等の環境変数ダンプ禁止
- シークレットを含むファイル（`.env.local` 等）の作成禁止
- Docker Compose 起動は `op run --env-file=.env -- docker compose up -d` 経由
- PAY.JP API 呼び出し等で秘密鍵が必要な場合は `op read` で個別取得
