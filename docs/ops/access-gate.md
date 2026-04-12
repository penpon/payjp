# 共有パスコードゲート（購読フォーム保護）

`SUBSCRIBE_GATE_CODE` が **非空** のとき、公開サイトの購読フローは **共有パスコード + `__Host-access_gate` Cookie** で保護されます。法務・サービス紹介などの静的ページ（`frontend/public`）は従来どおり公開のままです。

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `SUBSCRIBE_GATE_CODE` | 任意 | 非空にするとゲート有効。API プロセスにのみ設定（リポジトリにコミットしない）。 |
| `ACCESS_GATE_SESSION_TTL_SECONDS` | 任意 | ゲート Cookie / DB 行の TTL（秒）。正の整数。既定 `86400`。 |

ゲートを無効化する場合は `SUBSCRIBE_GATE_CODE` を **空** にする（キーごと削除でも可）。

## エンドポイント（公開 API）

- `GET /v1/access-gate/session` — `gateEnforced` / `unlocked`（常に 200）
- `POST /v1/access-gate/verify` — `{ "passcode": "..." }`（前後の空白はトリム）、成功時 `Set-Cookie: __Host-access_gate=...`
- `POST /v1/subscriptions` — ゲート有効時は **新規チェックアウト** に有効なゲートセッション必須（`GATE_REQUIRED` / `INVALID_GATE_SESSION`）。すでに契約中・トライアル中・解約済みだが `access_end_at` まで有効な会員は、ゲートを再入力せず既存購読応答のパスに入ります。

`POST /v1/access-gate/verify` は **1 分あたり 5 リクエスト**（IP 単位のレート制限）です。ブルートフォース対策として **短い TTL** と **コードの定期ローテーション** を組み合わせてください。リクエストボディにパスコードが含まれるため、**アクセスログやミドルウェアでボディを記録しない**運用を推奨します。

## コードのローテーション

1. 新しい十分長いランダム文字列を生成する（パスワードマネージャ推奨）。
2. デプロイまたはシークレット更新で **`SUBSCRIBE_GATE_CODE` を新値に切り替え**、API を再起動する。
3. 旧コードでのみ発行された Cookie は、DB 行の `expires_at` 経過またはクリーンアップで自然失効する。即時に全セッションを失効させる場合は下記 CLI を使うか、DB で `access_gate_sessions` を `TRUNCATE` する。

## 緊急: 全ゲートセッションの即時失効

`DATABASE_URL` を設定したうえで、リポジトリルートから:

```bash
npm run invalidate-access-gate
```

`access_gate_sessions` を `TRUNCATE` し、発行済みの `__Host-access_gate` がすべて無効になります（パスコードローテーション後の即時切り替えや漏えい時の対応に利用）。

## 旧招待 URL について

`GET /v1/invites/accept?...` は **`FRONTEND_BASE_URL/?gate=renewed` へ 302** のみです。利用者にはサイトルートでパスコード入力を案内してください。

## クリーンアップ

`packages/server/src/cleanup.ts` が `access_gate_sessions` の期限切れ行を削除します。日次ジョブ等で実行してください。
