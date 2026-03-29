# PAY.JP × Discord 連携サービス 2週間MVP仕様書（OAuth Lite + Multi Plan版）

- 作成日: 2026-03-28
- 対象: 日本向け有料Discordコミュニティ（約150名）
- 体制: 1名
- リリース目標: 2週間（目安: 2026-04-15）
- 方針: 要件を満たす最小実装（フロント最小、バックエンド最小）

## 1. 目的

本MVPは、次の3点を最優先で実現する。

1. 課金状態に応じてDiscord有料ロールを自動付与・自動剥奪する。
2. Discord OAuthで正しいユーザーIDを自動取得し、手入力運用を廃止する。
3. 異常時の調査に必要な情報をログへ記録し、手動復旧できる状態を維持する。

特に、`subscription.status != active` になった場合のロール剥奪を必須要件とする。

## 2. スコープ

2週間で実装する範囲は以下に限定する。

1. Discord OAuth Lite（`identify` スコープのみ）を実装する。
2. PAY.JPで3つの提供プランから1つを選択して定期課金を開始できる（Roleは全プラン共通）。
3. PAY.JP Webhookを受信し、課金状態をDBへ反映できる。
4. 課金状態に応じてDiscordロールを付与/剥奪できる。
5. 日次1回の再同期で不整合を修復できる。
6. 最低限の障害調査ができるログを残す（過剰な監査項目は持たない）。

## 3. 非スコープ

MVPでは実装しない。

1. 本格ログイン基盤（会員ポータル/多端末セッション管理）
2. 管理画面
3. クーポン/高度な請求管理
4. 高度な監視基盤（PagerDuty、外部APM、SLOダッシュボード等）
5. 常時接続のDiscord Gateway Bot
6. プランごとのRole差分制御（全プラン共通Role固定）
7. Alert自動通知/クールダウン
8. PAY.JPイベント保持期間の自動削除/匿名化ジョブ
9. Webhook受信ごとのPAY.JP `event.id` 再取得照合（MVP後に追加）
10. Webhook失敗イベント専用の再処理CLI（MVP後に追加）

## 4. 全体構成（最小）

1. フロントエンド
- 静的1ページ（Cloudflare Pages想定）
- 本番はフロントとAPIを同一サイト（同一eTLD+1）で運用する（例: `app.example.com` / `api.example.com`）
- 「Discord連携」ボタン
- プラン選択 + メール入力 + カード入力（PAY.JP UI）

2. バックエンド
- API + Webhook受信（Node.js + Fastify想定）
- Discord OAuth（start/callback/session）
- PAY.JP API連携
- Discord REST API連携（Botトークン利用）
- 日次再同期ジョブ

3. データストア
- PostgreSQL（最小6テーブル）

## 5. ユーザーフロー（MVP）

1. ユーザーが `/` で「Discord連携」を押す。
2. `GET /v1/auth/discord/start` からDiscord認可画面へ遷移する。
3. `GET /v1/auth/discord/callback` で `state` を検証し、`discord_user_id` を取得する。
4. バックエンドは短期有効な `link_session` Cookie（ワンタイム）を発行し、フロントへ戻す。
5. ユーザーがプラン・メール・カード情報を入力して登録する。
6. フロントは `planId + payjpToken` を `POST /v1/subscriptions` へ送信する（`link_session` はCookie送信）。
7. バックエンドは課金前に「Discordサーバー参加済み + Botが対象ロールを付与可能」を検証する（未参加/権限不足は課金前に失敗）。
8. 条件を満たす場合のみPAY.JPで購読作成し、Discordロール同期を実行する。
9. 以後はWebhookイベントと日次再同期で状態を維持する。

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
- 3-Dセキュア方式は `PAY.JP.js` のiframe方式に固定する（redirect方式はMVP非対応）
- 「登録する」押下で `payjpToken` を生成
- `PAY.JP.js` の `createToken` で `three_d_secure: true` を必須にする
- トークン化時に `card.name = cardholderName` と `card.email = email` を必須付与し、`phone` 入力があれば `card.phone` も付与する
- 3Dセキュア認証が完了し、`three_d_secure_status = verified` のトークンを取得できた場合のみ `POST /v1/subscriptions` を実行する
- 3Dセキュアが中断/失敗/タイムアウトした場合は `POST /v1/subscriptions` を呼ばず、再試行導線を表示する
- クライアントで `Idempotency-Key`（UUID v4推奨）を生成する
- `csrf_token` Cookie の値を `X-CSRF-Token` ヘッダに設定する（double submit）
- 選択した `planId` を含めて `POST /v1/subscriptions` を呼ぶ（`Idempotency-Key` ヘッダ必須）
- 結果メッセージを表示（成功/失敗）

5. 注意事項
- カード情報はフロントから直接PAY.JPへ送信する。
- フロントで秘密鍵を保持しない。
- OAuth/連携セッションはHttpOnly Cookieで扱い、フロントJSから読ませない。
- 課金APIは `Origin` を優先して検証し、`Origin` が無い場合のみ `Referer` を検証する（両方欠落は拒否）。
- Cookieベース連携を成立させるため、フロントとAPIは同一サイト（同一eTLD+1）で配置する。
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
  - `link_session` Cookie（HttpOnly, Secure, SameSite=Lax, Max-Age=15m）を設定
  - `csrf_token` Cookie（Secure, SameSite=Lax, Max-Age=15m, 非HttpOnly）を設定
  - フロントURLへ302（URLへトークンは付与しない）

4. `GET /v1/auth/discord/session`
- 目的: 連携済みセッション確認
- 出力: `{ linked: boolean, discordUserId?: string }`

5. `POST /v1/subscriptions`
- 目的: 初回購読作成
- 入力: `{ planId, email, payjpToken }`
- ヘッダ: `Idempotency-Key`（必須, UUID推奨）
- 処理:
  - `Origin` が存在する場合は `Origin == FRONTEND_BASE_URL` を検証（不一致は403）
  - `Origin` が存在しない場合のみ `Referer` の scheme+host が `FRONTEND_BASE_URL` と一致することを検証（不一致または欠落は403）
  - `X-CSRF-Token` と `csrf_token` Cookie の一致を検証（不一致は403）
  - `link_session` Cookie 検証（有効期限/ワンタイム）
  - `planId` が許可リスト内か検証
  - `discord_user_id` が `DISCORD_GUILD_ID` のメンバーであることを検証（未参加は409）
  - Botに `Manage Roles` 権限があり、`DISCORD_PAID_ROLE_ID` を付与可能な序列であることを検証（不可は503）
  - `payjpToken` をPAY.JP APIで再取得し、`used=false` かつ `card.three_d_secure_status = verified` を検証する（`attempted` 含め未完了は422）
  - PAY.JP API呼び出しは公式SDKまたは `application/x-www-form-urlencoded` で実行する（JSON POSTしない）
  - PAY.JP API（customer/subscription作成）が `429` または `5xx` の場合は指数バックオフで最大3回再試行する
  - `discord_user_id` 単位の排他ロックを取得
  - `subscription_request_keys` で冪等性を保証（`discord_user_id + idempotency_key` unique）
  - 同一 `Idempotency-Key` 再送時は `request_hash` を照合し、一致時のみ保存済みレスポンスを返す（不一致は409）
  - 既存 `active` 購読がある場合は新規作成せず既存結果を返す
  - PAY.JPでcustomer作成（既存あれば再利用）
  - PAY.JPでsubscription作成（選択プラン、`metadata.discord_user_id` を保存）
  - `members` をupsert
  - 使用済み `link_session` を無効化
  - 初回ロール同期を実行する
- 出力: `{ ok: true, memberId, subscriptionStatus }`

6. `POST /v1/payjp/webhook`
- 目的: 課金状態更新
- ヘッダ検証: `X-Payjp-Webhook-Token`
- 処理:
  - `Content-Type` は `application/json` 前方一致を必須化し、不正は `ignored` 記録して200で受理する
  - リクエストボディ上限を `WEBHOOK_MAX_BODY_BYTES`（既定 262144 bytes）に制限し、超過は `ignored` 記録して200で受理する
  - `livemode` が `PAYJP_LIVEMODE` と一致することを検証（不一致は `ignored` 記録して200）
  - `event.created` が未来5分超過の場合は `ignored` として記録し200で受理（再送抑止）
  - `event.id` / `event.type` / `livemode` / `data.id` / `data.object` / `data.status` / `data.plan.id` / `data.metadata.discord_user_id` を `payjp_events` に保存（`payjp_event_id` unique）
  - 重複なら何もしないで200
  - 新規イベントは即時処理し、`process_status` を更新する（`succeeded/failed/ignored`）
- 応答:
  - 恒久的に処理しない入力（トークン不一致 / Content-Type不正 / サイズ超過 / `livemode` 不一致 / 未来時刻イベント）は `200` を返し `ignored` として記録する
  - 重複時は `200`
  - 新規イベント処理完了時は `200`
  - DB障害など受理不能時のみ `503`（PAY.JPリトライを許可）

## 6.3 Webhookイベント処理方針（MVP簡易版）

対象イベントは最小限に限定する。

1. `subscription.created`
2. `subscription.updated`
3. `subscription.canceled`
4. `subscription.deleted`

共通処理:

1. 受信時に `X-Payjp-Webhook-Token` / `Content-Type` / ボディ上限 / `livemode` を検証する。
2. `event.id` を `payjp_events` へ保存して冪等化する（`payjp_event_id` unique）。
3. 重複 `event.id` は二重処理せず `200` を返す。
4. 新規イベントは payload の `data.object`（subscription）を真実源として `status/plan/metadata.discord_user_id` を読み取る。
5. `metadata.discord_user_id` が欠落している場合は `process_status = failed` にし、日次再同期または手動再同期CLIで回復する。
6. `discord_user_id` 単位の排他ロックを取得し、Webhook処理と再同期処理の競合を防ぐ。
7. `subscription.deleted` は `members.subscription_status = deleted` として扱う。その他は payload の `subscription.status` を反映する。
8. `plan.id` が取得できた場合のみ `members.payjp_plan_id` を更新する。
9. 状態に応じてDiscordロール同期を実行する。
10. Discord API `429/5xx` は指数バックオフで最大3回再試行し、最終失敗時は `process_status = failed` を記録する。

注記:

1. Webhook受信ごとの PAY.JP `event.id` 再取得照合はMVPでは実施しない（リリース後拡張）。

## 6.4 Discordロール同期ルール

1. `active` のときのみ付与。
2. `active` 以外（`trial/paused/canceled` など）は剥奪。
3. APIエラー時は最大3回再試行（1分, 5分, 15分）。
4. 429時は `Retry-After` を優先する。
5. `payjp_plan_id` はRole判定に使わない（全プラン共通Role）。

## 6.5 プラン判定ポリシー

1. 本MVPは3つの提供プラン（例: `plan_basic`, `plan_plus`, `plan_pro`）から1つを選択して受け付ける。
2. ただしDiscord Role判定は `subscription.status` のみで決定する。
3. `payjp_plan_id` は課金プラン識別・監査用途にのみ利用する。
4. 同一ユーザーの同時加入は不可（`active` 購読は常に1件まで）とする。

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
- `livemode` (boolean)
- `data_object_id` (text)
- `data_object` (text)
- `data_status` (text)
- `data_plan_id` (text)
- `data_metadata_discord_user_id` (text)
- `process_status` (text: succeeded/failed/ignored)
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

## 7.6 `subscription_request_keys`

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
7. `POST /v1/subscriptions` は `Origin` を優先検証し、`Origin` が無い場合のみ `Referer` を検証する。`FRONTEND_BASE_URL` 不一致または両方欠落は `403` で拒否する。
8. `POST /v1/subscriptions` は `X-CSRF-Token` と `csrf_token` Cookie の一致を必須化する。
9. Cookieベース連携を成立させるため、本番はフロントとAPIを同一サイト（同一eTLD+1）に配置する。
10. `POST /v1/subscriptions` の課金実行前に、Discordギルド参加状態とBotのロール付与可能性を検証する（不成立時は課金しない）。
11. PAY.JP API呼び出しで `429/5xx` 発生時は指数バックオフ再試行を実装する（最大 `PAYJP_API_RETRY_MAX` 回）。
12. Webhookトークン検証を必須化する。
13. Webhookで `livemode` を検証する。
14. `event.id` の冪等化を必須化する。
15. Webhookは `Content-Type` 前方一致・ボディサイズ上限・`event.created` 鮮度チェック（未来許容5分）を実施する。
16. Webhookの恒久的な不正入力は `ignored` 記録 + `200` 応答とし、不要な再送を抑止する。
17. Webhook payload の `metadata.discord_user_id` 欠落や会員不整合時は fail-close（ロール付与しない）で `failed` に記録する。
18. 本番の購読作成は3-Dセキュア `verified` トークンのみ受け付ける（`attempted` は拒否）。
19. 3-Dセキュア実行時、`createToken` の `three_d_secure: true` と `card.name + card.email`（`card.phone` は任意）を必須化する。
20. `subscription.metadata.discord_user_id` を保存する。
21. Webhook処理・再同期ジョブ・購読作成処理は `discord_user_id` 単位で排他ロックを取得する。
22. 公開APIにレート制限を適用する（`/auth/*`, `/subscriptions`, `/payjp/webhook`）。
23. CORS許可オリジンを `FRONTEND_BASE_URL` のみに固定する。
24. カード情報を保存・ログ出力しない。
25. Botトークン/PAY.JP秘密鍵/OAuthクライアント秘密を環境変数で管理する。
26. APIログから機密値（token, secret, code, cookie）をマスクする。
27. `payjp_events` には最小限の監査項目のみ保存し、カード情報やPIIを保持しない。
28. `payjp_events` には `livemode` を必須保存する。

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
12. `FRONTEND_BASE_URL`
13. `OAUTH_COOKIE_SECRET`
14. `WEBHOOK_MAX_BODY_BYTES`（既定: `262144`）
15. `DATABASE_URL`
16. `PAYJP_REQUIRE_3DS`（`true|false`, 本番は `true` 固定）
17. `SESSION_COOKIE_DOMAIN`（例: `.example.com`、同一サイト運用時のみ設定）
18. `PAYJP_API_RETRY_MAX`（既定: `3`）

## 10. バッチ/ジョブ

1. 日次再同期ジョブ
- JST 03:30 に実行
- 全会員を対象にPAY.JP状態とDiscordロールを再照合
- 障害対応として同じ再同期処理を運用CLIから手動実行可能にする（公開HTTP endpointは設けない）

2. 期限切れデータ掃除ジョブ
- 1時間間隔で `oauth_states` / `discord_link_sessions` の期限切れ行を削除

## 11. 開発スケジュール（2週間）

## Week 1

1. Day 1
- プロジェクト雛形
- DBマイグレーション（6テーブル）
- 環境変数管理
- 静的1ページの骨組み（UI最小、文言のみ）

2. Day 2-3
- `GET /v1/auth/discord/start`
- `GET /v1/auth/discord/callback`
- `GET /v1/auth/discord/session`
- Cookieバインド（HttpOnly/Secure/SameSite）実装
- `csrf_token` 発行（double submit）実装

3. Day 4-5
- `POST /v1/subscriptions`
- PAY.JP顧客/購読作成（3プランから1つ選択）
- 3-Dセキュア必須フロー（`verified` のみ受理）
- Idempotency-Key + 既存active購読ガード実装
- 課金前Discord参加チェック + ロール付与可能性チェック実装
- Discordロール付与/剥奪関数

## Week 2

1. Day 6
- Webhook受信 + 冪等化
- `subscription.created/updated/canceled/deleted` の最小イベント処理
- `livemode` 検証実装
- Webhook `Content-Type` / ボディ上限 / `event.created` 鮮度チェック（未来時刻は `ignored`）実装
- payloadベースの会員状態反映 + ロール同期実装

2. Day 7
- PAY.JP API `429/5xx` 再試行（指数バックオフ）実装
- 日次再同期ジョブ
- 手動再同期CLI
- OAuth/Linkセッション期限切れ掃除
- `discord_user_id` 単位ロックでWebhook/再同期の競合回避

3. Day 8
- ログマスキング/レート制限/CORS固定の仕上げ
- 運用手順の最小化（再同期実行手順、失敗時の一次対応）

4. Day 9
- P0自動テスト実装・実行
- ステージング総合疎通（OAuth→課金→Role反映→Webhook）

5. Day 10
- 本番環境変数投入
- P0手動テスト実行（運用手順含む）
- リリース
- バッファ（半日）: 想定外バグ修正/ロールバック判断

## 12. テスト要件（P0必須）

### 12.1 P0（自動化優先、Go-Live必須）

1. OAuth `state` 不一致で認可失敗になる。
2. `oauth_session` 不一致で認可失敗になる（ブラウザバインド保証）。
3. callbackのリダイレクトURLにトークンが含まれない。
4. `link_session` 再利用で登録失敗になる（ワンタイム保証）。
5. `X-CSRF-Token` 不一致の `POST /v1/subscriptions` は403で拒否される。
6. `Origin/Referer` 検証（`Origin` 優先、`Origin` 無し時の `Referer` フォールバック、両方欠落拒否）が仕様通りに動作する。
7. Discord未参加またはBot権限不足時は `POST /v1/subscriptions` が課金前に失敗し、PAY.JP APIが呼ばれない。
8. 同一 `Idempotency-Key` 再送で二重購読が作成されず、`request_hash` 不一致は409で拒否される。
9. 既存 `active` 購読ありで二重作成されない。
10. 3-Dセキュア `verified` 以外の `payjpToken` では `POST /v1/subscriptions` が失敗し、3DS中断/失敗/タイムアウト時は `POST /v1/subscriptions` が実行されない。
11. `event.id` 重複送信でWebhookが二重処理されない。
12. `livemode` 不一致・`Content-Type` 不正・サイズ超過・未来時刻イベントのWebhookは `ignored` 記録され、HTTP 200で応答される。
13. `subscription.status = active` でロール付与、`subscription.status != active` でロール剥奪される。
14. Webhookを1件欠落させても日次再同期で修復される。

## 13. 運用ルール（MVP）

1. 毎朝、前日失敗ログ件数を確認する。
2. `process_status = failed` が0でない場合は手動再同期CLIを実行して会員状態とロールを再整合する。
3. OAuth失敗率が高い場合は `redirect_uri` とクライアント設定を再確認する。
4. 重大障害（課金不整合/ロール未反映）が判明した場合は当日中に手動復旧を実施する。

## 14. 受け入れ条件（Go-Live）

1. テスト要件 `12.1 P0` がすべて通過している。
2. 検証環境で「課金停止→ロール剥奪」を実演確認済み。
3. 本番Webhook疎通確認済み（Webhookトークン検証含む）。
4. OAuth連携（start→callback→session）が本番で疎通済み。
5. 手動再同期CLIの実行手順が文書化済み。
6. 緊急時手順（手動剥奪・再同期実行）が文書化済み。

## 15. 将来拡張（リリース後）

1. 管理画面（会員検索/再同期/手動修復）
2. 監視高度化（外部監視SaaS、メトリクス可視化、SLO化）
3. プラン別Role分岐（必要時のみ）
4. 会員ポータル化（解約/カード変更/プラン変更）
