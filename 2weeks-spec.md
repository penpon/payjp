# PAY.JP × Discord 連携サービス 2週間MVP仕様書（OAuth Lite + Multi Plan + Monthly Billing版）

- 作成日: 2026-03-28
- 更新日: 2026-03-29
- 対象: 日本向け有料Discordコミュニティ（約150名）
- 体制: 1名
- リリース目標: 2026-04-20（当初2週間目安: 2026-04-15 から変更）
- 方針: 要件を満たす最小実装（フロント最小、バックエンド最小）

## 1. 目的

本MVPは、次の3点を最優先で実現する。

1. 課金状態に応じてDiscord有料ロールを自動付与・自動剥奪する。
2. Discord OAuthで正しいユーザーIDを自動取得し、手入力運用を廃止する。
3. 異常時の調査に必要な情報をログへ記録し、手動復旧できる状態を維持する。

特に、最終失効状態（`paused/deleted` など）ではDiscord有料ロールが確実に剥奪されることを必須要件とする。

## 2. スコープ

2週間で実装する範囲は以下に限定する。

1. Discord OAuth Lite（`identify` スコープのみ）を実装する。
2. PAY.JPで3つの提供プランから1つを選択して定期課金を開始できる。
3. 初回ユーザー（人間単位）は「1ヶ月目課金 + 2ヶ月目/3ヶ月目無料」を適用できる。
4. 4ヶ月目以降は月次課金（毎月）で継続できる。
5. 退会申請は `access_end_at` の1か月前（同日）から受け付け、定期請求を停止しつつ終了日まではRoleを維持できる。
6. PAY.JP Webhookを受信し、課金状態をDBへ反映できる。
7. 課金状態に応じてDiscordロールを付与/剥奪できる。
8. 日次1回の再同期で不整合を修復できる。
9. 最低限の障害調査ができるログを残す（過剰な監査項目は持たない）。

## 3. 非スコープ

MVPでは実装しない。

1. 本格ログイン基盤（会員ポータル/多端末セッション管理）
2. 管理画面
3. クーポン/高度な請求管理
4. 高度な監視基盤（PagerDuty、外部APM、SLOダッシュボード等）
5. 常時接続のDiscord Gateway Bot
6. プランごとのRole差分制御（全プラン共通Role）
7. Alert自動通知/クールダウン
8. PAY.JPイベント保持期間の自動削除/匿名化ジョブ
9. Webhook受信ごとのPAY.JP `event.id` 再取得照合（MVP後に追加）
10. Webhook失敗イベント専用の再処理CLI（MVP後に追加）
11. `subscription_request_keys` テーブルによるAPIレスポンス再返却
12. `Idempotency-Key` 再利用時の `request_hash` 不一致チェック（MVP後に追加）
13. Webhook `event.created` の厳密な時刻ドリフト補正（許容ウィンドウ管理、MVP後に追加）
14. ロール同期の非同期ジョブキュー化（MVP後に追加）
15. PAY.JP標準挙動を超える独自の期間末猶予アクセス（grace period）
16. 既存購読のプラン変更API（次回更新時反映/即時反映）
17. 人間判定の高度化（本人確認/KYC、複数アカウントの自動検知）

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
- 退会申請API（定期請求停止 + 終了日でRole除去）
- Discord REST API連携（Botトークン利用）
- 日次再同期ジョブ + 手動再同期CLI

3. データストア
- PostgreSQL（最小4テーブル）

## 5. ユーザーフロー（MVP）

1. ユーザーが `/` で「Discord連携」を押す。
2. `GET /v1/auth/discord/start` からDiscord認可画面へ遷移する。
3. `GET /v1/auth/discord/callback` で `state` を検証し、`discord_user_id` を取得する。
4. バックエンドは短期有効な `link_session` Cookie（ワンタイム）を発行し、フロントへ戻す。
5. ユーザーがプラン・メール・カード情報を入力して登録する。
6. フロントは `planId + payjpToken` を `POST /v1/subscriptions` へ送信する（`link_session` はCookie送信）。
7. バックエンドは課金前に「Discordサーバー参加済み + Botが対象ロールを付与可能」を検証する（未参加/権限不足は課金前に失敗）。
8. 条件を満たす場合のみPAY.JPで購読作成し、初回ユーザーは「1ヶ月目課金 + 2ヶ月目/3ヶ月目無料（trial）」を付与してDiscordロール同期を実行する。
9. 退会申請ユーザーは `POST /v1/subscriptions/cancel` を呼び、定期請求は停止しつつ終了日まではRoleを維持する。
10. 以後はWebhookイベントと日次再同期で状態を維持する。

## 6. 機能仕様

## 6.1 フロントエンド（1ページ）

1. ページ: `/`

2. 入力項目
- `planId`（選択式: 3プラン）
- `email`
- `cardholderName`（3Dセキュア認証用）
- `phone`（任意、3Dセキュア補助）
- カード入力（PAY.JP提供UI）

3. 動作
- 連携完了確認: `GET /v1/auth/discord/session`
- 3-Dセキュア方式は `PAY.JP.js` のiframe方式に固定する（redirect方式はMVP非対応）
- `cardholderName` は `^[A-Za-z0-9 .-]{2,45}$` を満たす場合のみ送信する（日本語など非対応文字はフロントでエラー表示）
- 「登録する」押下で `payjpToken` を生成
- `PAY.JP.js` の `createToken` で `three_d_secure: true` を必須にする
- トークン化時に `card.name = cardholderName` と `card.email = email` を必須付与し、`phone` 入力があれば `card.phone` も付与する
- 3Dセキュア認証が完了し、`three_d_secure_status = verified` のトークンを取得できた場合のみ `POST /v1/subscriptions` を実行する
- 3Dセキュアが中断/失敗/タイムアウトした場合は `POST /v1/subscriptions` を呼ばない
- `planId` は3プランの許可リストから選択し、`POST /v1/subscriptions` に含める
- 退会申請は `POST /v1/subscriptions/cancel` を呼ぶ（定期請求停止、Roleは終了日まで維持）

4. 注意事項
- カード情報はフロントから直接PAY.JPへ送信する。
- フロントで秘密鍵を保持しない。
- OAuth/連携セッションはHttpOnly Cookieで扱い、フロントJSから読ませない。
- 課金APIは `Origin` を必須検証し、`Origin` 欠落時も拒否する。
- Cookieベース連携を成立させるため、フロントとAPIは同一サイト（同一eTLD+1）で配置する。

## 6.2 バックエンドAPI

1. `GET /health`
- 200を返す

2. `GET /v1/auth/discord/start`
- 目的: Discord OAuth開始
- 処理:
  - ランダム `state` を生成
  - `oauth_states` に `state_hash` を保存（TTL 10分）
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
  - フロントURLへ302（URLへトークンは付与しない）

4. `GET /v1/auth/discord/session`
- 目的: 連携済みセッション確認
- 出力: `{ linked: boolean, discordUserId?: string }`

5. `POST /v1/subscriptions`
- 目的: 初回購読作成
- 入力: `{ planId, email, payjpToken }`
- 処理:
  - `Origin == FRONTEND_BASE_URL` を必須検証（不一致または欠落は403）
  - `link_session` Cookie 検証（有効期限/ワンタイム）
  - `planId` が `PAYJP_PLAN_IDS` の許可リスト内であることを検証
  - `discord_user_id` が `DISCORD_GUILD_ID` のメンバーであることを検証（未参加は409）
  - Botに `Manage Roles` 権限があり、`DISCORD_PAID_ROLE_ID` を付与可能な序列であることを検証（不可は503）
  - `payjpToken` をPAY.JP APIで再取得し、`used=false` かつ `card.three_d_secure_status = verified` を検証する（`attempted` / `failed` / `error` / `unverified` / `null` は422）
  - PAY.JP API呼び出しは公式SDKまたは `application/x-www-form-urlencoded` で実行する（JSON POSTしない）
  - ユーザー単位の排他制御として `pg_advisory_xact_lock(hashtext(discord_user_id))` を取得する
  - ロック後に `members` を参照し、既存 `active/trial/canceled` 契約がある場合は新規作成せず既存結果を返す
  - `members` 行が存在する場合は `SELECT ... FOR UPDATE` を併用し、Webhook/再同期との競合を防ぐ
  - 初回無料判定は `discord_user_id`（人間単位）で行う。`members.first_trial_granted_at IS NULL` の場合のみ初回ユーザーとして扱う
  - PAY.JPでcustomer作成（既存あれば再利用）
  - 初回ユーザーは「入会時に選択プランの1ヶ月分を `charge` で即時課金」してから、月次subscriptionを `trial_end = now + 3ヶ月` で作成する（2ヶ月目/3ヶ月目無料）
  - 非初回ユーザーは月次subscriptionを通常作成する（`trial_end` なし）
  - subscription作成時は `metadata.discord_user_id` を保存する
  - `members` をupsert
  - 初回無料を適用した場合は `members.first_trial_granted_at` と `members.access_end_at`（trial終了日）を保存する（一度保存したら解除しない）
  - 初回ロール同期を実行する（最大3回、短時間同期リトライ）
  - 使用済み `link_session` を無効化する（成功時のみ）
- 失敗時ポリシー:
  - customer/subscription/charge 作成系APIは自動再試行しない（重複作成リスク回避）
  - タイムアウト等の不確定失敗時は `503` を返し、運用でPAY.JP状態確認後に再同期CLIで回復する
- 出力: `{ ok: true, memberId, subscriptionStatus, planId, trialApplied, accessEndAt }`

6. `POST /v1/subscriptions/cancel`
- 目的: 退会申請（定期請求停止 + 終了日までRole維持）
- 入力: `{}`
- 処理:
  - `Origin == FRONTEND_BASE_URL` を必須検証（不一致または欠落は403）
  - `link_session` Cookie 検証（有効期限/ワンタイム）
  - ユーザー単位の排他制御として `pg_advisory_xact_lock(hashtext(discord_user_id))` を取得する
  - `members` を `SELECT ... FOR UPDATE` で取得し、`active/trial/canceled` の既存購読が無ければ409
  - `now_jst < (access_end_at の1か月前同日)` の場合は早期申請として `409` を返す（受付開始日は1か月前同日）
  - PAY.JP subscriptionキャンセルAPIを呼び、次回請求を停止する（即時削除はしない）
  - `members.cancel_requested_at` を記録し、`members.access_end_at` をPAY.JP応答の終了時刻で更新する
  - ロール同期は行わない（終了日到達までは付与維持）
- 失敗時ポリシー:
  - subscriptionキャンセルAPIは自動再試行しない
  - タイムアウト等の不確定失敗時は `503` を返し、運用でPAY.JP状態確認後に再同期CLIで回復する
- 出力: `{ ok: true, memberId, cancelEffectiveAt, roleRemovalAt }`

7. `POST /v1/payjp/webhook`
- 目的: 課金状態更新
- ヘッダ検証: `X-Payjp-Webhook-Token`
- 処理:
  - `Content-Type` は `application/json` 前方一致を必須化し、不正は `ignored` 記録して200で受理する
  - リクエストボディ上限を `262144 bytes` に固定し、超過は `ignored` 記録して200で受理する
  - `livemode` が `PAYJP_LIVEMODE` と一致することを検証（不一致は `ignored` 記録して200）
  - `event.id` / `event.type` / `event.created` / `livemode` / `data.id` / `data.object` / `data.status` / `data.plan.id` / `data.current_period_end` / `data.metadata.discord_user_id` を `payjp_events` に保存（`payjp_event_id` unique）
  - 重複なら何もしないで200
  - 新規イベントは即時処理し、`process_status` を更新する（`succeeded/failed/ignored`）
- 応答:
  - 恒久的に処理しない入力（トークン不一致 / Content-Type不正 / サイズ超過 / `livemode` 不一致）は `200` を返し `ignored` として記録する
  - 重複時は `200`
  - 新規イベント処理完了時は `200`
  - DB障害など受理不能時のみ `503`（PAY.JPリトライを許可）

## 6.3 Webhookイベント処理方針（MVP簡易版）

対象イベントは最小限に限定する。

1. `subscription.created`（記録のみ、処理は `ignored`）
2. `subscription.updated`
3. `subscription.renewed`
4. `subscription.canceled`
5. `subscription.deleted`
6. `subscription.paused`
7. `subscription.resumed`

共通処理:

1. 受信時に `X-Payjp-Webhook-Token` / `Content-Type` / ボディ上限 / `livemode` を検証する。
2. `event.id` を `payjp_events` へ保存して冪等化する（`payjp_event_id` unique）。
3. 重複 `event.id` は二重処理せず `200` を返す。
4. 新規イベントは payload の `data` をsubscription本体として扱い、`status/plan/metadata.discord_user_id` を読む（`data.object` は種別文字列）。
5. `discord_user_id` はまず `data.metadata.discord_user_id` から取得する。欠落時は対象イベント（`subscription.updated/renewed/canceled/paused/resumed/deleted`）で `data.id`（subscription id）から `members.payjp_subscription_id` を逆引きし、解決できない場合は `failed` として記録する。
6. `event.created`（Unix秒）が欠落/不正なイベントは `failed` として記録する。
7. `pg_advisory_xact_lock(hashtext(discord_user_id))` を取得し、必要時に `members` を `SELECT ... FOR UPDATE` してWebhook処理と再同期処理の競合を防ぐ。
8. `event.created < members.last_payjp_event_created_at` の場合は順不同到着の古いイベントとして `ignored` にする（状態を巻き戻さない）。
9. `subscription.created` は `process_status = ignored` とし、ロール同期は実行しない（初回登録APIで同期済みのため）。
10. `subscription.deleted` は `event.type` で判断し、`data.status` によらず `members.subscription_status = deleted` として扱う。その他イベントは `data.status`（`active/trial/canceled/paused`）を `members.subscription_status` に反映する。
11. `data.plan.id` が取得できた場合のみ `members.payjp_plan_id` を更新する。
12. `data.current_period_end` を取得できた場合は `members.next_billing_at` に保存する。`status=trial/canceled` の間は同値を `members.access_end_at` にも保存する（退会後のRole除去判定に使用）。
13. 状態更新を適用した場合のみ `members.last_payjp_event_created_at = event.created` を更新する。
14. `status` 不変の `subscription.updated` は `payjp_plan_id` 更新のみ行い、ロール同期は省略してよい。
15. 状態に応じてDiscordロール同期を実行する。
16. Discord API `429/5xx` は短時間の同期リトライ（0秒, 1秒, 3秒）を最大3回行い、最終失敗時は `process_status = failed` を記録する。

注記:

1. Webhook受信ごとの PAY.JP `event.id` 再取得照合はMVPでは実施しない（リリース後拡張）。
2. 分単位以上の待機を伴う再試行はWebhook内で実施しない（PAY.JP再送と二重処理リスクを避ける）。

## 6.4 Discordロール同期ルール

1. `active` / `trial` / `canceled` のとき付与する。
2. `canceled` は `access_end_at` 到達までは付与を維持し、`subscription.deleted` 到達または `access_end_at` 超過時に剥奪する。
3. `paused` / `deleted` / 不明ステータスは剥奪する。
4. APIエラー時は短時間の同期リトライを最大3回（0秒, 1秒, 3秒）実行する。
5. 429時は `Retry-After` を優先するが、MVPでは最大3秒まで待機し、長い待機が必要な場合は失敗記録して再同期へ回す。
6. `payjp_plan_id` はRole判定に使わない（3プランでもRoleは共通）。

## 6.5 解約時ポリシー（MVP）

1. 退会申請時はPAY.JP subscriptionキャンセルAPIで定期請求を停止する（即時削除はしない）。
2. 退会申請後も `access_end_at` 到達まではRoleを維持する（即時剥奪しない）。
3. `access_end_at` 到達時点でRoleを剥奪する（Webhook `subscription.deleted` または日次再同期で確実化）。
4. 退会申請の受付開始日は `access_end_at` の1か月前（同日）とし、それ以前の早期申請は拒否する。
5. 例: 2026-08-05 入会（1ヶ月目課金）、2026-09-05/2026-10-05 無料、`access_end_at=2026-11-05` の場合、退会申請の受付開始日は 2026-10-05。2026-10-05 に退会申請した場合は定期請求停止 + Roleは 2026-11-05 まで維持し、同日に除去する。

## 6.6 プラン判定ポリシー

1. 本MVPは3プラン（`PAYJP_PLAN_IDS`）を受け付ける。
2. すべてのプランは月次課金（毎月）で運用する。
3. 初回ユーザーのみ「1ヶ月目課金 + 2ヶ月目/3ヶ月目無料」を適用する。
4. 初回無料終了後（4ヶ月目以降）は毎月課金する。
5. Discord Role判定は `subscription.status` のみで決定する（プラン差分なし）。
6. `payjp_plan_id` は課金プラン識別・監査用途にのみ利用する。
7. 同一ユーザーの同時有効契約は不可（`active/trial/canceled` を同時に複数持たせない）。

## 6.7 初回無料判定ポリシー

1. 初回ユーザー判定はクレジットカード情報ではなく「人間単位」で行う。
2. 人間単位の識別子は `discord_user_id` を採用する。
3. `members.first_trial_granted_at IS NULL` の場合のみ初回無料を適用する。
4. 初回無料の内容は「1ヶ月目課金 + 2ヶ月目/3ヶ月目無料」とする。
5. 適用時に `first_trial_granted_at` を保存する。
6. 退会後に再加入しても `first_trial_granted_at` はリセットしない（初回無料の再付与なし）。
7. サポート対応用に手動でtrial付与可否を上書きする運用手順を用意する（管理画面はMVP外のため運用手順で対応）。

## 7. データモデル（最小）

## 7.1 `members`

- `id` (uuid, pk)
- `discord_user_id` (text, unique)
- `email` (text)
- `payjp_customer_id` (text, unique)
- `payjp_subscription_id` (text, unique)
- `payjp_plan_id` (text)
- `subscription_status` (text: active/trial/canceled/paused/deleted)
- `first_trial_granted_at` (timestamp, null)
- `initial_charge_paid_at` (timestamp, null)
- `cancel_requested_at` (timestamp, null)
- `access_end_at` (timestamp, null)
- `next_billing_at` (timestamp, null)
- `role_state` (text: granted/revoked/unknown)
- `last_synced_at` (timestamp)
- `last_payjp_event_created_at` (bigint, null)
- `created_at`, `updated_at`

## 7.2 `payjp_events`

- `id` (uuid, pk)
- `payjp_event_id` (text, unique)
- `event_type` (text)
- `event_created` (bigint)
- `livemode` (boolean)
- `data_object_id` (text)
- `data_object` (text)
- `data_status` (text)
- `data_plan_id` (text)
- `data_metadata_discord_user_id` (text)
- `data_current_period_end` (bigint)
- `process_status` (text: succeeded/failed/ignored)
- `retry_count` (int)
- `last_error` (text)
- `ignore_reason` (text)
- `processed_at` (timestamp)
- `created_at`

## 7.3 `oauth_states`

- `id` (uuid, pk)
- `state_hash` (text, unique)
- `expires_at` (timestamp)
- `used_at` (timestamp, null)
- `created_at`

## 7.4 `discord_link_sessions`

- `id` (uuid, pk)
- `link_session_token_hash` (text, unique)
- `discord_user_id` (text)
- `expires_at` (timestamp)
- `used_at` (timestamp, null)
- `created_at`

## 8. セキュリティ要件（MVP必須）

1. OAuth `state` 検証を必須化する。
2. OAuth `state` は `oauth_session` Cookie とバインドして検証する。
3. `link_session` をワンタイム・短期有効にする。
4. OAuth/linkトークンはURLに載せない（Cookieのみ）。
5. `POST /v1/subscriptions` / `POST /v1/subscriptions/cancel` は `Origin == FRONTEND_BASE_URL` を必須化し、欠落/不一致は `403` で拒否する。
6. Cookieベース連携を成立させるため、本番はフロントとAPIを同一サイト（同一eTLD+1）に配置する。
7. `POST /v1/subscriptions` の課金実行前に、Discordギルド参加状態とBotのロール付与可能性を検証する（不成立時は課金しない）。
8. 3-Dセキュア実行時、`createToken` の `three_d_secure: true` と `card.name + card.email`（`card.phone` は任意）を必須化し、`card.name` は `^[A-Za-z0-9 .-]{2,45}$` を満たす入力のみ受け付ける。
9. 本番の購読作成は3-Dセキュア `verified` トークンのみ受け付ける（`attempted` / `failed` / `error` / `unverified` / `null` は拒否）。
10. `subscription.metadata.discord_user_id` を保存する。
11. customer/subscription 作成系PAY.JP APIは自動再試行しない（重複作成リスク回避）。
12. 購読作成・Webhook処理・再同期処理は `pg_advisory_xact_lock(hashtext(discord_user_id))` でユーザー単位排他を取得する。
13. `members` 行が存在する場合は `SELECT ... FOR UPDATE` を併用し、行競合を明示的に制御する。
14. Webhookトークン検証を必須化する。
15. Webhookで `livemode` を検証する。
16. `event.id` の冪等化を必須化する。
17. Webhookは `event.created` の新旧判定を実施し、古いイベントで会員状態を巻き戻さない。
18. Webhookは `Content-Type` 前方一致とボディサイズ上限（`262144 bytes` 固定）を実施する。
19. Webhookの恒久的な不正入力は `ignored` 記録 + `200` 応答とし、不要な再送を抑止する。
20. Webhook payload の `metadata.discord_user_id` 欠落時は、対象イベント（`subscription.updated/renewed/canceled/paused/resumed/deleted`）で `data.id` 逆引きによる補完を試み、解決不能時は fail-close（ロール付与しない）で `failed` に記録する。
21. `subscription.created` は受信記録のみ行い、ロール同期は実行しない。
22. `subscription.renewed` をWebhook処理対象に含める。
23. Discord API再試行は短時間同期リトライのみ許可し、分単位再試行は日次再同期/手動CLIで回復する。
24. 公開APIにレート制限を適用する（`/auth/*`, `/subscriptions`, `/subscriptions/cancel`）。Webhookは別枠保護（トークン検証・サイズ制限・冪等化）で運用する。
25. CORS許可オリジンを `FRONTEND_BASE_URL` のみに固定する。
26. カード情報を保存・ログ出力しない。
27. Botトークン/PAY.JP秘密鍵/OAuthクライアント秘密を環境変数で管理する。
28. APIログから機密値（token, secret, code, cookie）をマスクする。
29. `payjp_events` には最小限の監査項目のみ保存し、カード情報やPIIを保持せず `livemode` を必須保存する。
30. `planId` は `PAYJP_PLAN_IDS` の許可リスト照合を必須化し、購読作成APIで不正値を拒否する。
31. 初回無料適用は `discord_user_id` 単位で一度のみ許可し、`first_trial_granted_at` を改ざん不能な監査ログとともに保存する。

## 9. 環境変数

1. `PAYJP_SECRET_KEY`
2. `PAYJP_PUBLIC_KEY`
3. `PAYJP_PLAN_IDS`（例: `plan_basic,plan_plus,plan_pro`）
4. `BILLING_INTERVAL_MONTHS`（固定: `1`）
5. `INITIAL_FREE_CYCLES`（固定: `2`）
6. `CANCEL_NOTICE_CYCLES`（固定: `1`）
7. `PAYJP_LIVEMODE`（`true|false`）
8. `PAYJP_WEBHOOK_TOKEN`
9. `DISCORD_BOT_TOKEN`
10. `DISCORD_GUILD_ID`
11. `DISCORD_PAID_ROLE_ID`
12. `DISCORD_CLIENT_ID`
13. `DISCORD_CLIENT_SECRET`
14. `DISCORD_REDIRECT_URI`
15. `FRONTEND_BASE_URL`
16. `OAUTH_COOKIE_SECRET`
17. `DATABASE_URL`

## 10. バッチ/ジョブ

1. 日次再同期ジョブ
- JST 03:30 に実行
- 全会員を対象にPAY.JP状態とDiscordロールを再照合
- PAY.JPのsubscription取得で `404` を返した会員は `deleted` とみなしてロール剥奪対象にする
- `access_end_at` 超過（`canceled`/`trial` の終了到達）会員はロール剥奪対象として再同期する
- 障害対応として同じ再同期処理を運用CLIから手動実行可能にする（公開HTTP endpointは設けない）

2. 期限切れデータ掃除ジョブ
- 日次1回で `oauth_states` / `discord_link_sessions` の期限切れ行を削除

## 11. 開発スケジュール（〜2026-04-20）

## Week 1

1. Day 1
- プロジェクト雛形
- DBマイグレーション（4テーブル）
- 環境変数管理
- 静的1ページの骨組み（UI最小、文言のみ）
- 本番外部依存の事前確認（PAY.JP本番キー準備、Webhook設定手順、Discordアプリ設定）
- 「初回1ヶ月目課金 + 2/3ヶ月目無料」の課金フローを確定（charge + subscription trial の分離）

2. Day 2-3
- `GET /v1/auth/discord/start`
- `GET /v1/auth/discord/callback`
- `GET /v1/auth/discord/session`
- Cookieバインド（HttpOnly/Secure/SameSite）実装

3. Day 4
- `POST /v1/subscriptions` コア実装（3プラン選択でPAY.JP顧客/購読作成）
- `planId` 許可リスト検証実装
- 初回「1ヶ月目課金 + 2/3ヶ月目無料」判定（`discord_user_id` 単位）実装
- ユーザー単位ロック（advisory lock）+ 既存有効契約ガード
- `members` 行存在時の `SELECT ... FOR UPDATE` 併用

4. Day 5
- 3-Dセキュア必須フロー（`verified` のみ受理）
- PAY.JP Token再取得検証（`used=false` + 3DS状態）
- `cardholderName` の英数字制約バリデーション実装

## Week 2

1. Day 6
- `POST /v1/subscriptions` 仕上げ（課金前Discord参加チェック + ロール付与可能性チェック + 初回ロール同期）
- `POST /v1/subscriptions/cancel` 実装（請求停止 + 終了日までRole維持）
- 作成系PAY.JP APIの「自動再試行しない」失敗ハンドリング実装

2. Day 7
- Webhook受信 + 冪等化
- `subscription.created/updated/renewed/canceled/deleted/paused/resumed` の最小イベント処理
- payload正規化（`data` をsubscription本体として解釈）
- `event.created` の新旧判定実装（古いイベント無視）
- `metadata.discord_user_id` 欠落時フォールバック（`data.id` 逆引き、対象イベント: `updated/renewed/canceled/paused/resumed/deleted`）実装
- `access_end_at` 更新と終了日ロール剥奪判定実装
- `subscription.created` を `ignored` 記録のみとする実装
- `livemode` 検証、Webhook `Content-Type` / ボディ上限実装

3. Day 8
- 日次再同期ジョブ
- 手動再同期CLI
- OAuth/Linkセッション期限切れ掃除（日次）
- 運用手順の最小化（再同期実行手順、課金不確定失敗時の一次対応）

4. Day 9
- P0自動テスト実装・実行（20件）
- ステージング総合疎通（OAuth→初回1ヶ月課金→2/3ヶ月目無料→4ヶ月目課金相当、退会申請→終了日Role除去）
- 4ヶ月目課金相当や終了日到達は、実時間経過ではなくWebhookフィクスチャ/時刻固定テストで検証する
- ログマスキング/レート制限/CORS固定の最終確認

5. Day 10
- 本番環境変数投入
- P0自動テスト最終実行（全件Pass確認）+ 最小手動スモーク（運用手順含む）
- リリース
- バッファ（1日）: 想定外バグ修正/ロールバック判断

## 12. テスト要件（P0必須）

### 12.1 P0（20件、統合テスト含む。自動化優先、Go-Live必須）

1. OAuth `state` 不一致で認可失敗になる。
2. `oauth_session` 不一致で認可失敗になる（ブラウザバインド保証）。
3. callbackのリダイレクトURLにトークンが含まれない。
4. `link_session` 再利用で登録失敗になる（ワンタイム保証）。
5. `Origin` 欠落または不一致の `POST /v1/subscriptions` / `POST /v1/subscriptions/cancel` は403で拒否される。
6. 許可リスト外 `planId` の `POST /v1/subscriptions` は失敗し、PAY.JP APIが呼ばれない。
7. Discord未参加またはBot権限不足時は `POST /v1/subscriptions` が課金前に失敗し、PAY.JP APIが呼ばれない。
8. 同一 `discord_user_id` への並列 `POST /v1/subscriptions`（初回登録を含む）で二重購読が作成されない。
9. 既存 `active/trial/canceled` 契約ありで二重作成されない。
10. 3-Dセキュア `verified` 以外の `payjpToken` では `POST /v1/subscriptions` が失敗し、3DS中断/失敗/タイムアウト時は `POST /v1/subscriptions` が実行されない。
11. 初回登録時のみ「1ヶ月目課金 + 2/3ヶ月目無料」が適用され、同一 `discord_user_id` の再加入時は再適用されない。
12. 初回登録では `charge(1ヶ月分)` が1回実行され、同時に `subscription(trial_end=入会+3ヶ月)` が作成される。
13. `cardholderName` が `^[A-Za-z0-9 .-]{2,45}$` を満たさない場合、トークン生成前にフロントで失敗する。
14. `subscription.status=trial` の期間（2ヶ月目/3ヶ月目）はRoleが付与される。
15. `POST /v1/subscriptions/cancel` は受付開始日前（`now_jst < (access_end_at の1か月前同日)`）は `409` で失敗し、受付開始日以降は定期請求を停止しつつ `access_end_at` 到達まではRoleが維持される。
16. `access_end_at` 到達時にRoleが除去される（Webhookまたは日次再同期）。
17. Webhookトークン不一致・`livemode` 不一致・`Content-Type` 不正・サイズ超過の入力は `ignored` 記録され、HTTP 200で応答される。
18. `event.id` 重複送信でWebhookが二重処理されず、`event.created` が古いWebhookは `ignored` となり会員状態が巻き戻らない。
19. Webhook payload を `data` から正しく解釈し、`subscription.created` は `ignored` 記録のみ、`subscription.updated/renewed/canceled/paused/resumed/deleted` は会員状態とロール同期が期待通りに動作する（`canceled` はロール維持、`plan.id` 更新を含む）。
20. `metadata.discord_user_id` 欠落時は `subscription id` 逆引きで対象会員を特定でき、Webhookを1件欠落させても日次再同期で修復される（PAY.JP subscription `404` は `deleted` として扱う）。

## 13. 運用ルール（MVP）

1. 毎朝、前日失敗ログ件数を確認する。
2. `process_status = failed` が0でない場合は手動再同期CLIを実行して会員状態とロールを再整合する。
3. 課金作成API/退会申請APIでタイムアウト等の不確定失敗が発生した場合は、PAY.JPで `metadata.discord_user_id` または `subscription.id` を確認してから再同期CLIを実行する。
4. OAuth失敗率が高い場合は `redirect_uri` とクライアント設定を再確認する。
5. 重大障害（課金不整合/ロール未反映）が判明した場合は当日中に手動復旧を実施する。
6. `access_end_at` が当日到達する退会申請ユーザーを毎日確認し、Role除去漏れがあれば当日中に手動再同期で補正する。

## 14. 受け入れ条件（Go-Live）

1. テスト要件 `12.1 P0` がすべて通過している。
2. 検証環境で「`paused/deleted` 到達時のロール剥奪」を検証コード（自動テスト）で確認済み。
3. 本番Webhook疎通確認済み（Webhookトークン検証含む）。
4. OAuth連携（start→callback→session）が本番で疎通済み。
5. 手動再同期CLIの実行手順が文書化済み。
6. 緊急時手順（手動剥奪・再同期実行）が文書化済み。
7. 検証環境で「3プラン選択登録」を検証コード（自動テスト）で確認済み。
8. 検証環境で「初回1ヶ月目課金 + 2/3ヶ月目無料適用」と「退会申請後の終了日までRole維持（例: 2026-10-05申請→2026-11-05除去）」を検証コード（自動テスト）で確認済み。
9. 実時間経過が必要なシナリオ（4ヶ月目課金、終了日到達）はWebhookフィクスチャ/時刻固定テストで同等保証できること。

## 15. 将来拡張（リリース後）

1. 管理画面（会員検索/再同期/手動修復）
2. 監視高度化（外部監視SaaS、メトリクス可視化、SLO化）
3. プラン別Role分岐（必要時のみ）
4. 会員ポータル化（解約/カード変更）
5. プラン変更API（次回更新時反映/即時反映）
6. `Idempotency-Key` 再利用時の `request_hash` 不一致チェック
7. `subscription_request_keys` テーブルによるレスポンス再返却
8. Webhook `event.created` の厳密な時刻ドリフト補正と同秒競合解決
9. ロール同期の非同期ジョブキュー化
10. PAY.JP標準挙動を超える独自の期間末猶予アクセス（grace period）
