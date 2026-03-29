# PAY.JP × Discord 連携サービス 2週間MVP仕様書（OAuth Lite + Multi Plan + Monthly Billing版）

- 作成日: 2026-03-28
- 更新日: 2026-03-30
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
4. バックエンドは短期有効な `__Host-link_session` Cookie（ワンタイム）を発行し、フロントへ戻す。
5. ユーザーがプラン・メール・カード情報を入力して登録する。
6. フロントは `planId + payjpToken` を `POST /v1/subscriptions` へ送信する（`__Host-link_session` はCookie送信）。
7. バックエンドは課金前に「Discordサーバー参加済み + Botが対象ロールを付与可能」を検証する（未参加/権限不足は課金前に失敗）。
8. 条件を満たす場合のみPAY.JPで購読作成し、初回ユーザーは「1ヶ月目課金 + 2ヶ月目/3ヶ月目無料（trial）」を付与してDiscordロール同期を実行する。
9. 退会申請ユーザーは `POST /v1/subscriptions/cancel` を呼び、定期請求は停止しつつ終了日まではRoleを維持する（`__Host-link_session` 失効時は再OAuthで再取得する）。
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
- 退会申請は `POST /v1/subscriptions/cancel` を呼ぶ（定期請求停止、Roleは終了日まで維持。`__Host-link_session` 失効時は再OAuth）

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
  - `__Host-oauth_session` Cookie を発行する（`Secure; Path=/; Domainなし; HttpOnly; SameSite=Lax; Max-Age=10m`）
  - `oauth_states` に `state_hash` と `oauth_session_hash` を保存する（TTL 10分）
  - 同名Cookieが複数送信されている場合は `400` で拒否する
  - Discord認可URLへ302リダイレクト

3. `GET /v1/auth/discord/callback`
- 目的: Discord OAuth完了
- 入力: `code`, `state`
- 処理:
  - `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を必須付与する
  - `state` と `__Host-oauth_session` の組を1トランザクションで検証/消費する（`state_hash + oauth_session_hash + 未使用 + TTL内`）
  - Discord APIで `discord_user_id` を取得
  - `discord_link_sessions` にワンタイム `link_session_token_hash` を保存（TTL 15分）
  - `__Host-link_session` Cookie を設定する（`Secure; Path=/; Domainなし; HttpOnly; SameSite=Lax; Max-Age=15m`）
  - フロントURLへ302（URLへトークンは付与しない）
  - `state` 不正/失効、Cookie不整合、TTL超過は `401` とし、再OAuthを要求する

4. `GET /v1/auth/discord/session`
- 目的: 連携済みセッション確認
- 出力: `{ linked: boolean, discordUserId?: string }`
- ヘッダ: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`

5. `POST /v1/subscriptions`
- 目的: 初回購読作成
- 入力: `{ planId, email, payjpToken }`
- 処理:
  - `Origin == FRONTEND_BASE_URL` を必須検証する（不一致/欠落/`Origin: null` は `403`）
  - `Sec-Fetch-Site` は `same-origin` または `same-site` のみ許可し、それ以外は `403`
  - `__Host-link_session` Cookie を検証し、失効/不正/同名重複は `401` で拒否して再OAuthを要求する
  - 保護POSTへの初回到達時点で `__Host-link_session` を消費する（後続処理の成功/失敗に関わらず再利用不可）
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
- 失敗時ポリシー:
  - customer/subscription/charge 作成系APIは自動再試行しない（重複作成リスク回避）
  - タイムアウト等の不確定失敗時は `503` を返す（`operationId` を返却し、クライアント自動再試行は禁止。運用でPAY.JP状態確認後に再同期CLIで回復）
- 出力: `{ ok: true, memberId, subscriptionStatus, planId, trialApplied, accessEndAt }`

6. `POST /v1/subscriptions/cancel`
- 目的: 退会申請（定期請求停止 + 終了日までRole維持）
- 入力: `{}`
- 処理:
  - `Origin == FRONTEND_BASE_URL` を必須検証する（不一致/欠落/`Origin: null` は `403`）
  - `Sec-Fetch-Site` は `same-origin` または `same-site` のみ許可し、それ以外は `403`
  - `__Host-link_session` Cookie を検証し、失効/不正/同名重複は `401` で拒否して再OAuthを要求する
  - 保護POSTへの初回到達時点で `__Host-link_session` を消費する（後続処理の成功/失敗に関わらず再利用不可）
  - ユーザー単位の排他制御として `pg_advisory_xact_lock(hashtext(discord_user_id))` を取得する
  - `members` を `SELECT ... FOR UPDATE` で取得し、`active/trial/canceled` の既存購読が無ければ409
  - DB保存時刻はUTC（`timestamptz`/Unix秒）で扱い、受付可否判定時のみJSTに変換する
  - 退会申請の受付開始日は `access_end_at` の1か月前同日（JST）とする。該当日が存在しない場合は当月末日に繰り上げる（例: 3/31 -> 2/28 or 2/29）
  - `now_jst < 受付開始日時` の場合は早期申請として `409` を返す
  - PAY.JP subscriptionキャンセルAPIを呼び、次回請求を停止する（即時削除はしない）
  - `members.cancel_requested_at` を記録し、`members.access_end_at` をPAY.JP応答の終了時刻で更新する
  - ロール同期は行わない（終了日到達までは付与維持）
- 失敗時ポリシー:
  - subscriptionキャンセルAPIは自動再試行しない
  - タイムアウト等の不確定失敗時は `503` を返す（`operationId` を返却し、クライアント自動再試行は禁止。運用でPAY.JP状態確認後に再同期CLIで回復）
- 出力: `{ ok: true, memberId, cancelEffectiveAt, roleRemovalAt }`

7. `POST /v1/payjp/webhook`
- 目的: 課金状態更新
- ヘッダ検証: `X-Payjp-Webhook-Token`
- 処理:
  - `Content-Type` は `application/json` 前方一致を必須化し、不正は `ignored` 記録して200で受理する
  - リクエストボディ上限を `262144 bytes` に固定し、超過は `ignored` 記録して200で受理する
  - `livemode` が `PAYJP_LIVEMODE` と一致することを検証（不一致は `ignored` 記録して200）
  - `event.type` は `subscription.created/updated/renewed/canceled/deleted/paused/resumed` の許可リストのみ処理し、それ以外は `ignored` 記録して200で受理する
  - `data.object` は `subscription` を必須とし、不一致は `ignored` 記録して200で受理する
  - 処理対象イベントに必要な項目（`event.id`, `event.created`, `data.id`, `data.status`, `data.current_period_end`）が欠落/不正な場合、`members` 更新は行わず `failed` 記録して200を返す
  - `event.id` / `event.type` / `event.created` / `livemode` / `data.id` / `data.object` / `data.status` / `data.plan.id` / `data.current_period_end` / `data.metadata.discord_user_id` を `payjp_events` に保存（`payjp_event_id` unique）
  - 重複なら何もしないで200
  - 新規イベントは `payjp_events` 記録・`members` 更新・`process_status` 更新を1トランザクションで実行する（`succeeded/failed/ignored`）
- 応答:
  - 恒久的に処理しない入力（トークン不一致 / Content-Type不正 / サイズ超過 / `livemode` 不一致 / 許可外 `event.type` / `data.object` 不一致）は `200` を返し `ignored` として記録する
  - 必須項目欠落などの処理不能入力は `200` を返し `failed` として記録する（`members` は更新しない）
  - 重複時は `200`
  - 新規イベント処理完了時は `200`
  - DB障害など受理不能時のみ `503`（PAY.JPリトライを許可）

## 6.3 Webhookイベント処理方針（MVP簡易版）

対象イベントは最小限に限定する。

1. `subscription.created`（通常は `ignored`。ただし `members` 欠落時の補償upsert条件を満たす場合のみ処理）
2. `subscription.updated`
3. `subscription.renewed`
4. `subscription.canceled`
5. `subscription.deleted`
6. `subscription.paused`
7. `subscription.resumed`

共通処理:

1. 受信時に `X-Payjp-Webhook-Token` / `Content-Type` / ボディ上限 / `livemode` / `event.type` 許可リスト / `data.object=subscription` を検証する。
2. `event.id` を `payjp_events` へ保存して冪等化する（`payjp_event_id` unique）。
3. 重複 `event.id` は二重処理せず `200` を返す。
4. 新規イベントは payload の `data` をsubscription本体として扱い、`status/plan/metadata.discord_user_id/current_period_end` を読む。
5. `discord_user_id` はまず `data.metadata.discord_user_id` から取得する。欠落時は対象イベント（`subscription.updated/renewed/canceled/paused/resumed/deleted`）で `data.id`（subscription id）から `members.payjp_subscription_id` を逆引きし、解決できない場合は `failed` として記録する。
6. `event.created`（Unix秒）が欠落/不正なイベントは `failed` として記録する。
7. `pg_advisory_xact_lock(hashtext(discord_user_id))` を取得し、必要時に `members` を `SELECT ... FOR UPDATE` してWebhook処理と再同期処理の競合を防ぐ。
8. `event.created < members.last_payjp_event_created_at` の場合は順不同到着の古いイベントとして `ignored` にする（状態を巻き戻さない）。
9. `subscription.created` は通常 `ignored` とする。例外として `members` 未存在かつ `data.metadata.discord_user_id` 解決可能な場合のみ補償upsert + ロール同期を実行する。
10. `subscription.deleted` は `event.type` で判断し、`data.status` によらず `members.subscription_status = deleted` として扱う。その他イベントは `data.status`（`active/trial/canceled/paused`）を `members.subscription_status` に反映する。
11. `data.plan.id` が取得できた場合のみ `members.payjp_plan_id` を更新する。
12. `data.current_period_end` を取得できた場合は `members.next_billing_at` に保存する。`status=active/trial/canceled` の間は同値を `members.access_end_at` にも保存する（アクセス保証終了時刻）。
13. `ignored` 以外で処理したイベントは `status` 不変でも `members.last_payjp_event_created_at = event.created` を更新する。
14. `status` 不変の `subscription.updated` は `payjp_plan_id` 更新のみ行い、ロール同期は実行しない。
15. 状態に応じてDiscordロール同期を実行する。
16. Discord API `429/5xx` は短時間の同期リトライ（0秒, 1秒, 3秒）を最大3回行い、最終失敗時は `process_status = failed` を記録する。
17. `payjp_events` 記録・`members` 更新・`payjp_events.process_status` 更新は1トランザクションで完了させる。
18. 必須項目欠落や検証失敗時は fail-close（`members` 非更新）とし、`ignored` または `failed` を記録する（DB障害以外は `200`）。

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
4. 退会申請の受付開始日は `access_end_at` の1か月前同日（JST）とし、それ以前の早期申請は拒否する。
5. 1か月前同日の算出で該当日が存在しない場合は当月末日に繰り上げる（例: 3/31 -> 2/28 または 2/29）。
6. 例: 2026-08-05 入会（1ヶ月目課金）、2026-09-05/2026-10-05 無料、`access_end_at=2026-11-05` の場合、退会申請の受付開始日は 2026-10-05。2026-10-05 に退会申請した場合は定期請求停止 + Roleは 2026-11-05 まで維持し、同日に除去する。

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
- `first_trial_granted_at` (timestamptz, null)
- `initial_charge_paid_at` (timestamptz, null)
- `cancel_requested_at` (timestamptz, null)
- `access_end_at` (timestamptz, null)
- `next_billing_at` (timestamptz, null)
- `role_state` (text: granted/revoked/unknown)
- `last_synced_at` (timestamptz)
- `last_payjp_event_created_at` (bigint, null)
- `created_at`, `updated_at` (timestamptz)

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
- `processed_at` (timestamptz)
- `created_at` (timestamptz)

## 7.3 `oauth_states`

- `id` (uuid, pk)
- `state_hash` (text, unique)
- `oauth_session_hash` (text)
- `expires_at` (timestamptz)
- `used_at` (timestamptz, null)
- `created_at` (timestamptz)

## 7.4 `discord_link_sessions`

- `id` (uuid, pk)
- `link_session_token_hash` (text, unique)
- `discord_user_id` (text)
- `expires_at` (timestamptz)
- `used_at` (timestamptz, null)
- `created_at` (timestamptz)

## 8. セキュリティ要件（MVP必須）

1. OAuth `state` 検証を必須化する。
2. `oauth_states` に `state_hash + oauth_session_hash` を保存し、callbackで `state + __Host-oauth_session + 未使用 + TTL内` を1トランザクションで検証/消費する。
3. OAuth連携Cookieは `__Host-oauth_session` を使用する（`Secure; Path=/; Domainなし; HttpOnly; SameSite=Lax`）。
4. 課金連携Cookieは `__Host-link_session` を使用する（同属性、TTL 15分、ワンタイム）。
5. 同名Cookieが複数送信された場合はリクエストを拒否する。
6. `__Host-link_session` は保護POST初回到達時点で消費し、成功/失敗に関わらず再利用不可とする。
7. OAuth/linkトークンはURLに載せない（Cookieのみ）。
8. `POST /v1/subscriptions` / `POST /v1/subscriptions/cancel` は `Origin == FRONTEND_BASE_URL` を必須化し、欠落/不一致/`Origin: null` は `403` で拒否する。
9. 保護POSTは `Sec-Fetch-Site` が `same-origin` または `same-site` の場合のみ許可する。
10. Cookieベース連携を成立させるため、本番はフロントとAPIを同一サイト（同一eTLD+1）に配置する。
11. `POST /v1/subscriptions` の課金実行前に、Discordギルド参加状態とBotのロール付与可能性を検証する（不成立時は課金しない）。
12. 3-Dセキュア実行時、`createToken` の `three_d_secure: true` と `card.name + card.email`（`card.phone` は任意）を必須化し、`card.name` は `^[A-Za-z0-9 .-]{2,45}$` を満たす入力のみ受け付ける。
13. 本番の購読作成は3-Dセキュア `verified` トークンのみ受け付ける（`attempted` / `failed` / `error` / `unverified` / `null` は拒否）。
14. `subscription.metadata.discord_user_id` を保存する。
15. customer/subscription/charge 作成系PAY.JP APIは自動再試行しない（重複作成リスク回避）。
16. 不確定失敗（タイムアウト等）は `503 + operationId` を返し、クライアント自動再試行は禁止する。
17. 購読作成・Webhook処理・再同期処理は `pg_advisory_xact_lock(hashtext(discord_user_id))` でユーザー単位排他を取得する。
18. `members` 行が存在する場合は `SELECT ... FOR UPDATE` を併用し、行競合を明示的に制御する。
19. Webhookトークン検証を必須化する。
20. Webhookで `livemode` を検証する。
21. `event.id` の冪等化を必須化する。
22. Webhookは `event.created` の新旧判定を実施し、古いイベントで会員状態を巻き戻さない。
23. Webhookは `Content-Type` 前方一致とボディサイズ上限（`262144 bytes` 固定）を実施する。
24. Webhookは `event.type` を `subscription.created/updated/renewed/canceled/deleted/paused/resumed` の許可リストに固定し、`data.object=subscription` を必須化する。
25. Webhookの必須項目欠落・不正入力は fail-close（`members` 非更新）とし、`ignored` または `failed` で記録する（DB障害以外は `200`）。
26. `subscription.created` は通常 `ignored` とし、`members` 欠落時の補償upsert条件を満たす場合のみ処理する。
27. Webhook処理では `payjp_events` 記録・`members` 更新・`process_status` 更新を1トランザクションで実行する。
28. Discord API再試行は短時間同期リトライのみ許可し、分単位再試行は日次再同期/手動CLIで回復する。
29. 公開APIにレート制限を適用する（`/auth/*`, `/subscriptions`, `/subscriptions/cancel`）。Webhookは別枠保護（トークン検証・サイズ制限・冪等化）で運用する。
30. CORS許可オリジンを `FRONTEND_BASE_URL` のみに固定する。
31. カード情報を保存・ログ出力しない。
32. Botトークン/PAY.JP秘密鍵/OAuthクライアント秘密を環境変数で管理する。
33. APIログ・レスポンスの機密値は `authorization`, `cookie`, `set-cookie`, `x-payjp-webhook-token`, `payjpToken`, `code`, `secret` を必ずマスクする。
34. `callback` / `session` 応答は `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を必須とする。
35. DB時刻はUTC（`timestamptz` またはUnix秒）で保持し、JST換算は受付日計算など判定時のみ行う。
36. `planId` は `PAYJP_PLAN_IDS` の許可リスト照合を必須化し、購読作成APIで不正値を拒否する。
37. 初回無料適用は `discord_user_id` 単位で一度のみ許可し、`first_trial_granted_at` を改ざん不能な監査ログとともに保存する。
38. `payjp_events` には最小限の監査項目のみ保存し、カード情報やPIIを保持しない。

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
- 課金/解約の状態遷移表を確定し、Day 1終了時点で変更凍結する
- 本番DB反映手順（migration適用 -> `/health` -> 主要API疎通）を文書化開始する

2. Day 2-3
- `GET /v1/auth/discord/start`
- `GET /v1/auth/discord/callback`
- `GET /v1/auth/discord/session`
- Cookieバインド（`__Host-oauth_session` / `__Host-link_session`、HttpOnly/Secure/SameSite）実装
- callback/session の `Cache-Control: no-store` / `Referrer-Policy: no-referrer` 実装
- P0テスト #1-4 を実装

3. Day 4
- `POST /v1/subscriptions` コア実装（3プラン選択でPAY.JP顧客/購読作成）
- `planId` 許可リスト検証実装
- 初回「1ヶ月目課金 + 2/3ヶ月目無料」判定（`discord_user_id` 単位）実装
- ユーザー単位ロック（advisory lock）+ 既存有効契約ガード
- `members` 行存在時の `SELECT ... FOR UPDATE` 併用
- `__Host-link_session` の保護POST初回到達時消費（成功/失敗共通）を実装
- P0テスト #5-9 を実装

4. Day 5
- 3-Dセキュア必須フロー（`verified` のみ受理）
- PAY.JP Token再取得検証（`used=false` + 3DS状態）
- `cardholderName` の英数字制約バリデーション実装
- 不確定失敗時の `503 + operationId` 契約（自動再試行禁止）を実装
- P0テスト #10-13 を実装

## Week 2

1. Day 6
- `POST /v1/subscriptions` 仕上げ（課金前Discord参加チェック + ロール付与可能性チェック + 初回ロール同期）
- `POST /v1/subscriptions/cancel` 実装（請求停止 + 終了日までRole維持）
- 作成系PAY.JP APIの「自動再試行しない」失敗ハンドリング実装
- 退会受付の「1か月前同日（存在しない日は月末繰上げ）」判定を実装
- 保護POSTの `Origin` + `Sec-Fetch-Site` 検証（`Origin: null` 拒否）を実装
- Webhook入力検証（token/livemode/Content-Type/size/event.type/data.object）を前倒し実装
- P0テスト #14-15 を実装

2. Day 7
- Webhook受信 + 冪等化
- `subscription.created/updated/renewed/canceled/deleted/paused/resumed` の最小イベント処理
- `event.created` の新旧判定実装（古いイベント無視）
- `metadata.discord_user_id` 欠落時フォールバック（`data.id` 逆引き、対象イベント: `updated/renewed/canceled/paused/resumed/deleted`）実装
- `access_end_at` 更新（`active/trial/canceled`）と終了日ロール剥奪判定実装
- `subscription.created` の補償upsert条件（`members` 欠落時のみ）を実装
- `payjp_events` 記録 + `members` 更新 + `process_status` 更新の1トランザクション実装
- P0テスト #16-18 を実装

3. Day 8
- 日次再同期ジョブ
- 手動再同期CLI
- OAuth/Linkセッション期限切れ掃除（日次）
- 運用手順の最小化（再同期実行手順、課金不確定失敗時の一次対応、手動剥奪手順、孤立subscription復旧手順）
- Day8内で運用文書を確定し、Day9冒頭に文書レビューを実施する
- P0テスト #19-20 を実装

4. Day 9
- P0自動テスト最終実行（20件全件Pass）と不具合修正
- ステージング総合疎通（OAuth→初回1ヶ月課金→2/3ヶ月目無料→4ヶ月目課金相当、退会申請→終了日Role除去）
- 4ヶ月目課金相当や終了日到達は、実時間経過ではなくWebhookフィクスチャ/時刻固定テストで検証する
- 本番Webhook疎通確認（Webhookトークン検証含む）を実施する
- OAuth本番疎通（start->callback->session）を実施する
- ログマスキング/レート制限/CORS固定の最終確認
- Day8で確定した運用文書（手動剥奪/再同期）を固定する

5. Day 10
- バッファ（最終不具合修正・Go/No-Go判定）を先に実施する
- 本番環境変数投入
- migration適用 -> `/health` -> 主要API疎通（OAuth/session/subscriptions/cancel/webhook）を確認する
- 最小手動スモーク（運用手順含む）を実施する
- リリース

## 12. テスト要件（P0必須）

### 12.1 P0（20件、統合テスト含む。自動化優先、Go-Live必須）

1. OAuth `state` 不一致で認可失敗になる。
2. `state + __Host-oauth_session + 未使用 + TTL内` の原子的検証/消費が行われ、`oauth_session` 不一致・期限切れ・再利用で認可失敗になる。
3. callback/session 応答に `Cache-Control: no-store` と `Referrer-Policy: no-referrer` が付与され、callbackリダイレクトURLにトークンが含まれない。
4. `__Host-oauth_session` / `__Host-link_session` が `Secure; Path=/; Domainなし; HttpOnly; SameSite=Lax` で運用され、同名Cookie重複時は拒否される。
5. `__Host-link_session` は保護POST初回到達時に消費され、成功時/失敗時の双方で再利用できない。
6. `POST /v1/subscriptions` / `POST /v1/subscriptions/cancel` は `Origin` 欠落・不一致・`null`、または `Sec-Fetch-Site` が `same-origin/same-site` 以外の場合に `403` で拒否される。
7. 許可リスト外 `planId` の `POST /v1/subscriptions` は失敗し、PAY.JP APIが呼ばれない。
8. `PAYJP_PLAN_IDS` の3プランそれぞれで `POST /v1/subscriptions` が成功し、`members.payjp_plan_id` 保存とRole付与が行われる。
9. Discord未参加時は `POST /v1/subscriptions` が `409` で課金前に失敗し、PAY.JP APIが呼ばれない。
10. Bot権限不足時は `POST /v1/subscriptions` が `503` で課金前に失敗し、PAY.JP APIが呼ばれない。
11. 同一 `discord_user_id` への並列 `POST /v1/subscriptions`（初回登録を含む）で二重購読が作成されず、`charge=1` / `subscription=1` が保たれる。
12. 既存 `active/trial/canceled` 契約ありでは新規作成されず、既存結果を返す。
13. 3-Dセキュア `verified` 以外の `payjpToken` では `POST /v1/subscriptions` が失敗し、3DS中断/失敗/タイムアウト時は `POST /v1/subscriptions` が実行されない。
14. 初回登録時のみ「1ヶ月目課金 + 2/3ヶ月目無料」が適用され、`charge(1ヶ月分)=1回` と `subscription(trial_end=入会+3ヶ月)` が作成され、同一 `discord_user_id` 再加入時は再適用されない。
15. 不確定失敗（`503`）後のユーザー再試行で二重課金/二重購読が発生しない（`operationId` で追跡可能）。
16. `POST /v1/subscriptions/cancel` は受付開始日前（`access_end_at` の1か月前同日より前）を `409` で拒否し、月末繰上げルールで境界判定でき、受付開始日以降は終了日までRole維持となる。
17. `access_end_at` 到達時にRoleが除去される（Webhookまたは日次再同期）。
18. Webhookトークン不一致・`livemode` 不一致・`Content-Type` 不正・サイズ超過・許可外 `event.type`・`data.object` 不一致・必須項目欠落の入力は `ignored` または `failed` 記録され、HTTP 200で応答され、`members` は更新されない。
19. `event.id` 重複送信でWebhookが二重処理されず、`event.created` が古いWebhookは `ignored` となり会員状態が巻き戻らず、`ignored` 以外の処理では `status` 不変でも `last_payjp_event_created_at` が更新される。
20. Webhookイベント別期待値表（`subscription_status` / `role_state` / `access_end_at` / `payjp_plan_id`）に対して `subscription.created/updated/renewed/canceled/paused/resumed/deleted` を1件ずつ自動アサートし、`subscription.created` の補償upsert（`members` 欠落時のみ）、`metadata.discord_user_id` 欠落時の逆引き、Webhook欠落時の日次再同期修復、および機密値マスキング（`authorization`, `cookie`, `set-cookie`, `x-payjp-webhook-token`, `payjpToken`, `code`, `secret`）を検証する。

## 13. 運用ルール（MVP）

1. 毎朝、前日失敗ログ件数を確認する。
2. `process_status = failed` が0でない場合は手動再同期CLIを実行して会員状態とロールを再整合する。
3. 再同期の完了条件は「`process_status = failed` が0」「対象ユーザーの `role_state` が期待値一致」「当日 `access_end_at` 到達分の剥奪漏れが0」とする。
4. 課金作成API/退会申請APIでタイムアウト等の不確定失敗（`503`）が発生した場合は、`operationId` をキーにPAY.JPで `metadata.discord_user_id` または `subscription.id` を確認してから再同期CLIを実行する（クライアント自動再試行は禁止）。
5. PAY.JP側にsubscriptionが存在し `members` が欠落する孤立ケースでは、`subscription.id` / `metadata.discord_user_id` で会員行を復元し、再同期CLIを実行して完了条件を確認する。
6. 緊急時手順として手動剥奪を定義し、実施条件・手順・確認方法を運用文書に固定する。
7. OAuth失敗率が高い場合は `redirect_uri` とクライアント設定を再確認する。
8. 重大障害（課金不整合/ロール未反映）が判明した場合は当日中に手動復旧を実施する。
9. `access_end_at` が当日到達する退会申請ユーザーを毎日確認し、Role除去漏れがあれば当日中に手動再同期で補正する。

## 14. 受け入れ条件（Go-Live）

1. テスト要件 `12.1 P0` がすべて通過している。
2. 検証環境で「`paused/deleted` 到達時のロール剥奪」を検証コード（自動テスト）で確認済み。
3. 本番Webhook疎通確認済み（Webhookトークン検証含む。Day9実施 + Day10再確認）。
4. OAuth連携（start->callback->session）が本番で疎通済み（Day9実施 + Day10再確認）。
5. 手動再同期CLIの実行手順が文書化済み。
6. 緊急時手順（手動剥奪・再同期実行・孤立subscription復旧）が文書化済み。
7. 検証環境で「3プラン選択登録」を検証コード（自動テスト）で確認済み。
8. 検証環境で「初回1ヶ月目課金 + 2/3ヶ月目無料適用」と「退会申請後の終了日までRole維持（例: 2026-10-05申請→2026-11-05除去）」を検証コード（自動テスト）で確認済み。
9. 実時間経過が必要なシナリオ（4ヶ月目課金、終了日到達）はWebhookフィクスチャ/時刻固定テストで同等保証できること。
10. 本番反映時に `migration適用 -> /health -> 主要API疎通`（OAuth/session/subscriptions/cancel/webhook）を確認済み。
11. 機密マスキング（`authorization`, `cookie`, `set-cookie`, `x-payjp-webhook-token`, `payjpToken`, `code`, `secret`）がログ/レスポンスで確認済み。

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
11. Webhook受信ごとの PAY.JP `event.id` 再取得照合
