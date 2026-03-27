# PAY.JP × Discord 連携サービス 2週間MVP仕様書（OAuth Lite + Alert Lite Minimal + Multi Plan版）

- 作成日: 2026-03-28
- 対象: 日本向け有料Discordコミュニティ（約150名）
- 体制: 1名
- リリース目標: 2週間（目安: 2026-04-11）
- 方針: 要件を満たす最小実装（フロント最小、バックエンド最小）

## 1. 目的

本MVPは、次の3点を最優先で実現する。

1. 課金状態に応じてDiscord有料ロールを自動付与・自動剥奪する。
2. Discord OAuthで正しいユーザーIDを自動取得し、手入力運用を廃止する。
3. 異常をDiscord運用チャンネルへ自動通知し、見落としを防ぐ。

特に、`subscription.status != active` になった場合のロール剥奪を必須要件とする。

## 2. スコープ

2週間で実装する範囲は以下に限定する。

1. Discord OAuth Lite（`identify` スコープのみ）を実装する。
2. PAY.JPで複数プランの定期課金を開始できる（Roleは全プラン共通）。
3. PAY.JP Webhookを受信し、課金状態をDBへ反映できる。
4. 課金状態に応じてDiscordロールを付与/剥奪できる。
5. 日次1回の再同期で不整合を修復できる。
6. 最低限の障害調査ができるログを残す。
7. Alert Lite（重要2ルールのみ）を実装する。

## 3. 非スコープ

MVPでは実装しない。

1. 本格ログイン基盤（会員ポータル/多端末セッション管理）
2. 管理画面
3. クーポン/高度な請求管理
4. 高度な監視基盤（PagerDuty、外部APM、SLOダッシュボード等）
5. 常時接続のDiscord Gateway Bot
6. プランごとのRole差分制御（全プラン共通Role固定）

## 4. 全体構成（最小）

1. フロントエンド
- 静的1ページ（Cloudflare Pages想定）
- 「Discord連携」ボタン
- プラン選択 + メール入力 + カード入力（PAY.JP UI）

2. バックエンド
- API + Webhook受信（Node.js + Fastify想定）
- Discord OAuth（start/callback/session）
- PAY.JP API連携
- Discord REST API連携（Botトークン利用）
- 日次再同期ジョブ
- Alert Lite通知ジョブ（重要2ルールのみ）

3. データストア
- PostgreSQL（最小7テーブル）

## 5. ユーザーフロー（MVP）

1. ユーザーが `/` で「Discord連携」を押す。
2. `GET /v1/auth/discord/start` からDiscord認可画面へ遷移する。
3. `GET /v1/auth/discord/callback` で `state` を検証し、`discord_user_id` を取得する。
4. バックエンドは短期有効な `link_session` Cookie（ワンタイム）を発行し、フロントへ戻す。
5. ユーザーがプラン・メール・カード情報を入力して登録する。
6. フロントは `planId + payjpToken` を `POST /v1/subscriptions` へ送信する（`link_session` はCookie送信）。
7. バックエンドはPAY.JPで購読作成し、Discordロール同期を実行する。
8. 以後はWebhookイベントと日次再同期で状態を維持する。

## 6. 機能仕様

## 6.1 フロントエンド（1ページ）

1. ページ: `/`
2. 表示状態
- 未連携: 「Discord連携」ボタンを表示
- 連携済み: Discord表示名（またはID）と課金フォームを表示

3. 入力項目
- `planId`（選択式）
- `email`
- `cardholderName`（3Dセキュア認証用）
- `phone`（任意、3Dセキュア補助）
- カード入力（PAY.JP提供UI）

4. 動作
- 連携完了確認: `GET /v1/auth/discord/session`
- 「登録する」押下で `payjpToken` を生成
- クライアントで `Idempotency-Key`（UUID v4推奨）を生成する
- `csrf_token` Cookie の値を `X-CSRF-Token` ヘッダに設定する（double submit）
- 選択した `planId` を含めて `POST /v1/subscriptions` を呼ぶ（`Idempotency-Key` ヘッダ必須）
- 結果メッセージを表示（成功/失敗）

5. 注意事項
- カード情報はフロントから直接PAY.JPへ送信する。
- フロントで秘密鍵を保持しない。
- OAuth/連携セッションはHttpOnly Cookieで扱い、フロントJSから読ませない。
- 課金APIは `Origin` / `Referer` が `FRONTEND_BASE_URL` と一致するリクエストのみ受け付ける。
- `csrf_token` はCSRF対策専用のため、カード情報や秘密情報は格納しない。

## 6.2 バックエンドAPI

1. `GET /health`
- 200を返す

2. `GET /v1/auth/discord/start`
- 目的: Discord OAuth開始
- 処理:
  - ランダム `state` と `oauth_session_nonce` を生成
  - `oauth_states` に `state_hash` / `session_nonce_hash` を保存（TTL 10分）
  - `oauth_session` Cookie（HttpOnly, Secure, SameSite=Lax, Max-Age=10m）を設定
  - Discord認可URLへ302リダイレクト

3. `GET /v1/auth/discord/callback`
- 目的: Discord OAuth完了
- 入力: `code`, `state`
- 処理:
  - `state` と `oauth_session` Cookie の組を検証（未使用/期限内）
  - Discord APIで `discord_user_id` を取得
  - `discord_link_sessions` にワンタイム `link_session_token_hash` を保存（TTL 15分）
  - `link_session` Cookie（HttpOnly, Secure, SameSite=Strict, Max-Age=15m）を設定
  - `csrf_token` Cookie（Secure, SameSite=Strict, Max-Age=15m, 非HttpOnly）を設定
  - フロントURLへ302（URLへトークンは付与しない）

4. `GET /v1/auth/discord/session`
- 目的: 連携済みセッション確認
- 出力: `{ linked: boolean, discordUserId?: string }`

5. `POST /v1/subscriptions`
- 目的: 初回購読作成
- 入力: `{ planId, email, payjpToken }`
- ヘッダ: `Idempotency-Key`（必須, UUID推奨）
- 処理:
  - `Origin` / `Referer` が `FRONTEND_BASE_URL` と一致することを検証（不一致は403）
  - `X-CSRF-Token` と `csrf_token` Cookie の一致を検証（不一致は403）
  - `link_session` Cookie 検証（有効期限/ワンタイム）
  - `planId` が許可リスト内か検証
  - `payjpToken` が3Dセキュア `verified` であることを検証（`attempted` 含め未完了は422）
  - PAY.JP API呼び出しは公式SDKまたは `application/x-www-form-urlencoded` で実行する（JSON POSTしない）
  - `discord_user_id` 単位の排他ロックを取得
  - `subscription_request_keys` で冪等性を保証（`discord_user_id + idempotency_key` unique）
  - 同一 `Idempotency-Key` 再送時は `request_hash` を照合し、一致時のみ保存済みレスポンスを返す（不一致は409）
  - 既存 `active` 購読がある場合は新規作成せず既存結果を返す
  - PAY.JPでcustomer作成（既存あれば再利用）
  - PAY.JPでsubscription作成（選択プラン、`metadata.discord_user_id` を保存）
  - `members` をupsert
  - 使用済み `link_session` を無効化
  - 初回ロール同期ジョブを登録
- 出力: `{ ok: true, memberId, subscriptionStatus }`

6. `POST /v1/payjp/webhook`
- 目的: 課金状態更新
- ヘッダ検証: `X-Payjp-Webhook-Token`
- 処理:
  - `Content-Type` は `application/json` 前方一致を必須化（不正は415）
  - リクエストボディ上限を `WEBHOOK_MAX_BODY_BYTES`（既定 262144 bytes）に制限（超過は413）
  - `livemode` が `PAYJP_LIVEMODE` と一致することを検証（不一致は `ignored` 記録して200）
  - `event.created` が未来5分超過または `PAYJP_EVENT_MAX_AGE_DAYS`（既定30日）より古い場合は `ignored` として記録し200で受理（再送抑止）
  - `event.id` を `payjp_events` に保存（unique）
  - 重複なら何もしないで200
  - 新規イベントなら処理対象として記録
- 応答:
  - 検証失敗時は `401/413/415`（PAY.JPの再送対象。3分間隔で最大3回再送される前提で設計）
  - `livemode` 不一致または鮮度外イベントは `200`（`ignored` 記録）
  - 重複時は `200`
  - 新規イベント保存成功時は `200`
  - DB保存失敗など受理不能時は `503`（PAY.JPリトライを許可）

## 6.3 Webhookイベント処理方針

対象イベントは最初は必要最小限に絞る。

1. `subscription.created`
2. `subscription.updated`
3. `subscription.paused`
4. `subscription.resumed`
5. `subscription.canceled`
6. `subscription.deleted`
7. `subscription.renewed`
8. `charge.failed`

共通処理:

1. `event.created` の鮮度を検証し、古すぎる/未来すぎるイベントは `process_status = ignored` にして以降処理しない。
2. PAY.JP APIで `event.id` を再取得し、受信payloadと `type/livemode/data.object.id` が一致することを検証する。
3. 不一致時は fail-close で `process_status = failed` にし、`critical` 通知対象にして以降処理しない。
4. PAY.JP APIから対象subscriptionを再取得する。
5. 再取得オブジェクトの `livemode` と `plan_id`（許可リスト）を検証する。
6. `discord_user_id` と `subscription` の紐付けが正しいことを検証する（`subscription.metadata.discord_user_id` と `members.discord_user_id` を照合）。
7. `discord_user_id` 単位の排他ロックを取得し、Webhook処理と再同期処理の競合を防ぐ。
8. 検証不一致時は fail-close（ロール付与しない/必要なら剥奪寄り）で `process_status = failed` にする。
9. `subscription.status` を真実源として `members.subscription_status` を更新する。
10. 取得した `subscription.plan` を `members.payjp_plan_id` に反映する。
11. 状態に応じてDiscordロール同期を実行する。

## 6.4 Discordロール同期ルール

1. `active` のときのみ付与。
2. `active` 以外（`trial/paused/canceled` など）は剥奪。
3. APIエラー時は最大3回再試行（1分, 5分, 15分）。
4. 429時は `Retry-After` を優先する。
5. `payjp_plan_id` はRole判定に使わない（全プラン共通Role）。

## 6.5 Alert Lite通知ルール

運用チャンネル（例: `#ops-alerts`）に通知する。

1. `webhook_fail_streak`
- 条件: `payjp_events.process_status = failed` が直近10分で3件以上
- severity: `warning`

2. `role_sync_terminal_fail`
- 条件: `role_sync_logs.result = failed` かつ最終失敗（再試行上限到達）が1件以上
- severity: `critical`

3. 連投防止
- 同一 `alert_key` は30分クールダウン
- クールダウン中は再通知しない

4. 通知本文（最小）
- `severity`
- `alert_key`
- `count`
- `window`
- `detected_at`

## 6.6 プラン判定ポリシー

1. 本MVPは複数プランを受け付ける。
2. ただしDiscord Role判定は `subscription.status` のみで決定する。
3. `payjp_plan_id` は課金プラン識別・監査用途にのみ利用する。

## 7. データモデル（最小）

## 7.1 `members`

- `id` (uuid, pk)
- `discord_user_id` (text, unique)
- `email` (text)
- `payjp_customer_id` (text, unique)
- `payjp_subscription_id` (text, unique)
- `payjp_plan_id` (text)
- `subscription_status` (text)
- `role_state` (text: granted/revoked/unknown)
- `last_synced_at` (timestamp)
- `created_at`, `updated_at`

## 7.2 `payjp_events`

- `id` (uuid, pk)
- `payjp_event_id` (text, unique)
- `event_type` (text)
- `payload_json` (jsonb)
- `process_status` (text: pending/succeeded/failed/ignored)
- `retry_count` (int)
- `last_error` (text)
- `ignore_reason` (text)
- `processed_at` (timestamp)
- `created_at`

## 7.3 `role_sync_logs`

- `id` (uuid, pk)
- `member_id` (uuid)
- `action` (text: grant/revoke)
- `result` (text: success/failed)
- `http_status` (int)
- `error_message` (text)
- `created_at`

## 7.4 `oauth_states`

- `id` (uuid, pk)
- `state_hash` (text, unique)
- `session_nonce_hash` (text)
- `expires_at` (timestamp)
- `used_at` (timestamp, null)
- `created_at`

## 7.5 `discord_link_sessions`

- `id` (uuid, pk)
- `link_session_token_hash` (text, unique)
- `discord_user_id` (text)
- `expires_at` (timestamp)
- `used_at` (timestamp, null)
- `created_at`

## 7.6 `alert_states`

- `id` (uuid, pk)
- `alert_key` (text, unique)
- `last_sent_at` (timestamp)
- `cooldown_until` (timestamp)
- `last_count` (int)
- `updated_at`

## 7.7 `subscription_request_keys`

- `id` (uuid, pk)
- `discord_user_id` (text)
- `idempotency_key` (text)
- `request_hash` (text)
- `response_json` (jsonb)
- `created_at`
- unique: (`discord_user_id`, `idempotency_key`)

## 8. セキュリティ要件（MVP必須）

1. OAuth `state` 検証を必須化する。
2. OAuth `state` は `oauth_session` Cookie とバインドして検証する。
3. `link_session` をワンタイム・短期有効にする。
4. OAuth/linkトークンはURLに載せない（Cookieのみ）。
5. `POST /v1/subscriptions` は `Idempotency-Key` 必須 + 既存active購読ガードを実装する。
6. `POST /v1/subscriptions` は `Idempotency-Key` 再利用時に `request_hash` 不一致を `409` で拒否する。
7. `POST /v1/subscriptions` は `Origin` / `Referer` を検証し、`FRONTEND_BASE_URL` 不一致を `403` で拒否する。
8. `POST /v1/subscriptions` は `X-CSRF-Token` と `csrf_token` Cookie の一致を必須化する。
9. Webhookトークン検証を必須化する。
10. Webhookで `livemode` を検証する。
11. `event.id` の冪等化を必須化する。
12. Webhook処理時に PAY.JP APIで `event.id` を再取得し、`type/livemode/data.object.id` 一致を必須化する。
13. Webhookで `livemode/plan_id/会員紐付け` が不一致の場合は fail-close で処理する。
14. Webhookは `Content-Type` を `application/json` 前方一致で必須化し、ボディサイズ上限を適用する。
15. Webhookは `event.created` の鮮度チェック（未来許容5分、過去許容30日）を実施する。
16. 鮮度外イベントは `ignored` 記録して `200` を返し、不要な再送を防ぐ。
17. 本番の購読作成は3-Dセキュア `verified` トークンのみ受け付ける（`attempted` は拒否）。
18. 3-Dセキュア実行時に必要なカード名義・連絡先情報をPAY.JPトークン化時に付与する。
19. `subscription.metadata.discord_user_id` を保存し、Webhook再取得時に照合する。
20. Webhook処理ジョブ・再同期ジョブ・購読作成処理は `discord_user_id` 単位で排他ロックを取得する。
21. 公開APIにレート制限を適用する（`/auth/*`, `/subscriptions`）。
22. `/payjp/webhook` は専用レート制限（高め閾値）を適用し、トークン検証失敗を優先して拒否する。
23. CORS許可オリジンを `FRONTEND_BASE_URL` のみに固定する。
24. カード情報を保存・ログ出力しない。
25. Botトークン/PAY.JP秘密鍵/OAuthクライアント秘密を環境変数で管理する。
26. APIログから機密値（token, secret, code, cookie）をマスクする。
27. `payjp_events.payload_json` は機微フィールドを除外し、保持期間を30日に制限する。

## 9. 環境変数

1. `PAYJP_SECRET_KEY`
2. `PAYJP_PUBLIC_KEY`
3. `PAYJP_PLAN_IDS`（例: `plan_basic,plan_plus,plan_pro`）
4. `PAYJP_LIVEMODE`（`true|false`）
5. `PAYJP_WEBHOOK_TOKEN`
6. `DISCORD_BOT_TOKEN`
7. `DISCORD_GUILD_ID`
8. `DISCORD_PAID_ROLE_ID`
9. `DISCORD_CLIENT_ID`
10. `DISCORD_CLIENT_SECRET`
11. `DISCORD_REDIRECT_URI`
12. `DISCORD_ALERT_CHANNEL_ID`
13. `FRONTEND_BASE_URL`
14. `OAUTH_COOKIE_SECRET`
15. `WEBHOOK_MAX_BODY_BYTES`（既定: `262144`）
16. `PAYJP_EVENT_MAX_AGE_DAYS`（既定: `30`）
17. `DATABASE_URL`
18. `PAYJP_REQUIRE_3DS`（`true|false`, 本番は `true` 固定）

## 10. バッチ/ジョブ

1. Webhook処理ジョブ
- 1分間隔で `payjp_events.process_status = pending` を処理

2. 日次再同期ジョブ
- JST 03:30 に実行
- 全会員を対象にPAY.JP状態とDiscordロールを再照合
- 障害対応として同じ再同期処理を運用CLIから手動実行可能にする（公開HTTP endpointは設けない）

3. 期限切れデータ掃除ジョブ
- 1時間間隔で `oauth_states` / `discord_link_sessions` の期限切れ行を削除

4. Alert評価ジョブ
- 5分間隔で失敗件数を集計
- 閾値超過時のみDiscord運用チャンネルへ通知
- 同一 `alert_key` の30分クールダウンを適用
- 対象ルールは2つ（`webhook_fail_streak`, `role_sync_terminal_fail`）

5. PAY.JPイベント保持期間ジョブ
- 1日1回、`payjp_events.payload_json` の保持期間（30日）を超えた行を削除または匿名化

## 11. 開発スケジュール（2週間）

## Week 1

1. Day 1-2
- プロジェクト雛形
- DBマイグレーション（7テーブル）
- 環境変数管理

2. Day 3
- `GET /v1/auth/discord/start`
- `GET /v1/auth/discord/callback`
- `GET /v1/auth/discord/session`
- Cookieバインド（HttpOnly/Secure/SameSite）実装
- `csrf_token` 発行（double submit）実装

3. Day 4-5
- `POST /v1/subscriptions`
- PAY.JP顧客/購読作成（複数プラン）
- 3-Dセキュア必須フロー（`verified` のみ受理）
- Idempotency-Key + 既存active購読ガード実装
- Discordロール付与/剥奪関数

## Week 2

1. Day 6-7
- Webhook受信 + 冪等化
- `subscription.deleted` / `subscription.renewed` を含む最小イベント処理
- イベント処理ジョブ
- `livemode` 検証実装
- Webhook `event.id` 再取得照合実装
- Webhook `Content-Type` / ボディ上限 / `event.created` 鮮度チェック（鮮度外は `ignored`）実装

2. Day 8
- 日次再同期ジョブ
- 手動再同期CLI
- OAuth/Linkセッション期限切れ掃除
- Alert評価ジョブ（2ルール + クールダウン）
- `discord_user_id` 単位ロックでWebhook/再同期の競合回避

3. Day 9
- 静的1ページ実装（OAuth導線 + 課金フォーム）
- P0自動テスト実装・実行
- ステージング総合疎通（OAuth→課金→Role反映→Webhook）

4. Day 10
- 本番環境変数投入
- P0手動テスト実行（運用手順含む）
- リリース
- バッファ（半日）: 想定外バグ修正/ロールバック判断

## 12. テスト要件（P0必須 + P1推奨）

### 12.1 P0（自動化優先、Go-Live必須）

1. OAuth `state` 不一致で認可失敗になる。
2. `oauth_session` 不一致で認可失敗になる（ブラウザバインド保証）。
3. callbackのリダイレクトURLにトークンが含まれない。
4. `link_session` 再利用で登録失敗になる（ワンタイム保証）。
5. `GET /v1/auth/discord/session` で機微トークンが返らない。
6. `X-CSRF-Token` 不一致の `POST /v1/subscriptions` は403で拒否される。
7. 同一 `Idempotency-Key` 再送で二重購読が作成されない。
8. 同一 `Idempotency-Key` かつ `request_hash` 不一致は409で拒否される。
9. 既存 `active` 購読ありで二重作成されない。
10. 3-Dセキュア `verified` 以外の `payjpToken` では `POST /v1/subscriptions` が失敗する。
11. `event.id` 重複送信で二重処理されない。
12. Webhook `event.id` 再取得時に `type/livemode/data.object.id` 不一致なら fail-close になる。
13. `Content-Type` 不正Webhookが拒否される。
14. 上限超過サイズのWebhookが拒否される。
15. `event.created` が古すぎる/未来すぎるWebhookは `ignored` 記録され、HTTP 200で応答される。
16. `livemode` 不一致Webhookは `ignored` 記録され、HTTP 200で応答される。
17. `subscription.status = active` でロール付与される。
18. `subscription.status != active` でロール剥奪される。
19. `subscription.deleted` 受信時に有料Roleが剥奪される。
20. Webhookを1件欠落させても日次再同期で修復される。

### 12.2 P1（手動中心、リリース後1週間以内に補完）

1. `Origin` / `Referer` が `FRONTEND_BASE_URL` 不一致の `POST /v1/subscriptions` は403で拒否される。
2. Webhook受理時にDB保存失敗した場合は5xxを返し、再送可能になる。
3. `subscription` 再取得時に `plan_id/会員紐付け` 不一致なら fail-close になる。
4. Discord API 429時に再試行される。
5. `webhook_fail_streak` 条件成立時にDiscord通知される。
6. 同一 `alert_key` が30分以内に連投されない。
7. 異なる `planId` で購読しても `active` なら同一Roleが付与される。
8. `payjp_events.payload_json` 保持期間ジョブで30日超過データが削除または匿名化される。

## 13. 運用ルール（MVP）

1. 毎朝、前日失敗ログ件数を確認する。
2. `process_status = failed` が0でない場合は手動で再実行する。
3. OAuth失敗率が高い場合は `redirect_uri` とクライアント設定を再確認する。
4. 通知チャンネルで `critical` 通知が来たら当日中に手動復旧を実施する。

## 14. 受け入れ条件（Go-Live）

1. テスト要件 `12.1 P0` がすべて通過している。
2. 検証環境で「課金停止→ロール剥奪」を実演確認済み。
3. 本番Webhook疎通確認済み（Webhookトークン検証含む）。
4. OAuth連携（start→callback→session）が本番で疎通済み。
5. Alert Lite通知（2ルール）が検証環境で疎通済み。
6. 緊急時手順（手動剥奪・再同期実行）が文書化済み。
7. `12.2 P1` の未実施項目は起票済みで、リリース後1週間以内の実施日が確定している。

## 15. 将来拡張（リリース後）

1. 管理画面（会員検索/再同期/手動修復）
2. 監視高度化（外部監視SaaS、メトリクス可視化、SLO化）
3. プラン別Role分岐（必要時のみ）
4. 会員ポータル化（解約/カード変更/プラン変更）
