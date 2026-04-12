# 実装設計書（MVP固定）

- 正本仕様: `2weeks-spec.md`
- 本書の目的: 2026-04-20向けMVP実装方針を固定する（追加提案なし）
- 採番ルール: `2. スコープ` の9項目を `R1-R9` として扱う

## 1. スコープ境界（R1-R9対応表）

| 要件ID | 要件（2.スコープ） | 主担当サービス | MVP完了条件 |
|---|---|---|---|
| R1 | Discord OAuth Lite（identifyのみ） | auth-service | start/callback/sessionが仕様通り動作 |
| R2 | 3プランから1つを選択して定期課金開始 | billing-service | `planId` 許可リストで登録成功 |
| R3 | 初回ユーザーは1か月目課金 + 2か月目/3か月目無料 | billing-service | `discord_user_id` 単位の `first_trial_granted_at` で一度のみ適用 |
| R4 | 4か月目以降は月次課金 | billing-service | 非初回は `trial_end` なし月次継続 |
| R5 | Google Form退会受付 + 即時退会完了 | billing-service | Google Form送信後にPAY.JP解約が完了し、`current_period_end` まで利用・ロールを維持する |
| R6 | PAY.JP Webhook受信で課金状態反映 | sync-service | 許可イベントのみ冪等処理、fail-close |
| R7 | 課金状態でDiscordロール付与/剥奪 | sync-service | `active/trial` 付与、`canceled` は `access_end_at` まで付与維持、その後および `paused/deleted` は剥奪 |
| R8 | 日次再同期 + 手動再同期CLIで不整合修復 | sync-service | 日次1回 + CLI（operationId/discord_user_id/全体） |
| R9 | 最低限の障害調査ログ | auth/billing/sync 共通 | 必須キーを構造化記録、過剰監査なし |

### 明確な非スコープ（固定）

- 管理画面、会員ポータル、Webhook再生/DLQ、高度監視、通知自動化は追加しない
- `inflight_operation_*` の解除は手動再同期CLIのみ（日次ジョブでは解除しない）

### `deep-research-report.md` 反映の固定前提（2026-03-28版）

- 決済基盤の採用方針は PAY.JP 第一候補、Stripe 代替候補とする。
- 実装の必須原則は `Webhook中心` / `署名検証` / `冪等性` / `自動再試行` / `Discord APIレート制限自己修復` の5点とする。
- 課金停止状態の安全側判定として `paused` / `deleted` / 不明ステータスを即時剥奪対象に固定する。
- PAY.JPのWebhook再送前提（HTTP 200 以外で3分間隔・最大3回）を受信APIの応答境界設計に反映する。
- Go-Live前に `課金失敗時イベント遅延/Dunning`、`長時間5xx時フェイルセーフ`、`トークン移管手順` の3項目をベンダー確認する。
- 上記3項目は実装着手のブロッカーにしない（実装は先行可）。ただし Day3（2026-04-08）終了までに一次回答を収集し、Day10（2026-04-17）開始前までに採用判断を固定する。

## 2. サービス責務と境界（auth / billing / sync）

### auth-service

- 責務:
  - `GET /v1/auth/discord/start`
  - `GET /v1/auth/discord/callback`
  - `GET /v1/auth/discord/session`
  - `oauth_states` と `discord_link_sessions` の発行/検証/消費
- 境界:
  - 課金（PAY.JP書き込み）を行わない
  - ロール同期を行わない

### billing-service

- 責務:
  - `POST /v1/subscriptions`
  - `POST /v1/subscriptions/cancel/google-form-link`
  - `POST /v1/subscriptions/cancel/google-submit`
  - `POST /v1/subscriptions/cancel`
  - `members` の課金状態更新、`inflight_operation_*` 管理
  - 初回無料判定、Google Form退会トークン検証、Discord事前チェック
- 境界:
  - Webhook受信ループ処理を持たない
  - 日次全件再同期は行わない（sync-service担当）

### sync-service

- 責務:
  - `POST /v1/payjp/webhook`
  - 日次再同期ジョブ
  - 手動再同期CLI（`operationId` / `discord_user_id` / 全会員）
  - `payjp_events` 記録、ロール同期、`member_impact_logs` 記録/解消
- 境界:
  - OAuth処理を持たない
  - 新規課金開始/解約APIの受付を持たない

## 3. API契約（入力/出力/主要エラー）

### 3.1 エンドポイント契約

| API | 入力 | 正常出力 | 主要エラー |
|---|---|---|---|
| `GET /health` | なし | `200` | `503`（依存障害時） |
| `GET /v1/auth/discord/start` | なし | Discord認可URLへ `302` | - |
| `GET /v1/auth/discord/callback` | `code`, `state`, `__Host-oauth_session` | `__Host-link_session` 設定 + フロントへ `302` | `401`（state/Cookie/TTL不正） |
| `GET /v1/auth/discord/session` | `__Host-link_session` | `{ linked: boolean }` | - |
| `POST /v1/subscriptions` | `{ planId, email, payjpToken }` + `__Host-link_session` + `Origin` | `{ ok: true, memberId: string(uuid), subscriptionStatus: "active"|"trial"|"canceled"|"paused"|"deleted", planId: string, trialApplied: boolean, accessEndAt: string(RFC3339 UTC) }` | `401/403/409/422/503` |
| `POST /v1/subscriptions/cancel/google-form-link` | `{}` + `__Host-member_session` + `Origin` | `{ ok: true, formUrl: string, expiresAt: string(RFC3339 UTC) }` | `401/403/409/503` |
| `POST /v1/subscriptions/cancel/google-submit` | `{ name, email, reason, token }` + `X-Cancel-Secret`（移行期間は旧 `X-Google-Cancel-Secret` も可） | `{ ok: true, memberId: string(uuid), cancelEffectiveAt: string(RFC3339 UTC), roleRemovalAt: string(RFC3339 UTC) }` | `401/409/503` |
| `POST /v1/subscriptions/cancel` | `{}` + `__Host-link_session` + `Origin` | `{ ok: true, memberId: string(uuid), cancelEffectiveAt: string(RFC3339 UTC), roleRemovalAt: string(RFC3339 UTC) }` | `401/403/409/503` |
| `GET /v1/subscriptions/status` | `__Host-member_session` または有効な `__Host-link_session` + `Origin`（任意） | `200 { subscription: null }` または `200 { subscription: { status, planId, accessEndAt } }` | `403`（Origin）, `503` |
| `POST /v1/payjp/webhook` | PAY.JPイベント + `X-Payjp-Webhook-Token` | `200`（処理/ignored/failed/重複） | `401`（token不一致）, `503`（DB受理不能） |

補足:
- `GET /v1/auth/discord/callback` / `GET /v1/auth/discord/session` は `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を必須で返す
- `GET /v1/auth/discord/callback` の `302 Location` には OAuth/link トークンを載せない（query/fragment禁止）
- Cookie連携API（`GET /v1/auth/discord/session`, `POST /v1/subscriptions`, `POST /v1/subscriptions/cancel/google-form-link`, `POST /v1/subscriptions/cancel`）は `FRONTEND_BASE_URL` のみを許可Originに固定し、`Access-Control-Allow-Credentials: true` を必須とする
- 成功レスポンスの日時項目（`accessEndAt`, `cancelEffectiveAt`, `roleRemovalAt`）は RFC 3339 UTC 文字列で返し、Unix秒やJST文字列は返さない
- `GET /v1/subscriptions/status` の `subscription` は、billing-service の `hasActiveSubscription`（`active` / `trial`、または `canceled` かつ `access_end_at > now`）が真のときのみオブジェクトを返す。`canceled` かつ利用終了日経過後は `subscription: null` とし、フロントは再入会のため `POST /v1/subscriptions`（課金フォーム）へ遷移できる

### 3.2 エラーコード意味（固定）

| コード | 意味 | 主対象API |
|---|---|---|
| `401` | OAuth/link session不正・失効、Webhook token不一致 | callback, subscriptions, cancel, Webhook |
| `403` | `Origin` 欠落/不一致/`null` | subscriptions, cancel |
| `409` | ビジネス前提不成立（未参加、受付期間外、`access_end_at`/`payjp_subscription_id` 未設定など） | subscriptions, cancel |
| `422` | 課金入力不正（例: 3DS `verified` 不成立。MVP完全認証方針で `attempted` も非許容） | subscriptions |
| `503` | 不確定失敗または処理保留（`operationId` 返却、再試行はCLIのみ） | subscriptions, cancel, Webhook(DB障害時) |

## 4. データモデル責務

| テーブル | 主責務 | 主な更新主体 | 備考 |
|---|---|---|---|
| `members` | 会員・購読状態の正 | billing-service / sync-service / resync CLI | `inflight_operation_*`, `payjp_customer_id`, `payjp_subscription_id`, `payjp_initial_charge_id`, `access_end_at`, `first_trial_granted_at` を保持 |
| `payjp_events` | Webhook受信履歴と処理結果 | sync-service | `payjp_event_id` で冪等化（token検証通過イベントのみ） |
| `oauth_states` | OAuth `state` ワンタイム検証 | auth-service | `state_hash + oauth_session_hash` をTTL付きで管理 |
| `discord_link_sessions` | 課金前連携セッション | auth-service（発行）/ billing-service（消費） | `__Host-link_session` のワンタイム原本 |
| `member_impact_logs` | 会員影響の未解決/解消追跡 | sync-service / resync CLI | 再同期で解消時は同一 `member_id + issue_code` を `resolved_at` 更新 |

## 5. 重要シーケンス

### 5.0 用語（購読と Discord 検証）

- **主目的**: ユーザー価値の中心は **購読（定期課金）の開始と維持** である（正本: `2weeks-spec.md` §5 冒頭）。
- **検証順序**: `POST /v1/subscriptions` では、PAY.JP への書き込みより前に、`__Host-link_session` による Discord 連携済み確認およびギルド参加・ロール付与可能性を検証する（§5.1 step6 相当）。
- **俗称の扱い**: 「Discord-first」等は **課金API前に Discord 前提を満たす** 順序を指す。課金より Discord をビジネス上優先する、という意味ではない。

### 5.1 購読開始（`POST /v1/subscriptions`）

前提（フロント）:
- `payjpToken` 生成時に `PAY.JP.js createToken` へ `three_d_secure: true` を指定し、`card.name`（カード名義）と `card.email` または `card.phone` を必須で渡す。
- 3Dセキュア実施に伴う個人情報取り扱いへの同意をUIで取得し、同意なしは `createToken` を開始しない。

1. `Origin` / `__Host-link_session` / `planId` を検証する（`Origin` は `scheme+host+port` 正規化比較）
2. `pg_advisory_lock(discord_user_id::bigint)` を取得する
3. `members` 行が無い場合は `discord_user_id + email` で仮行を作成し、購読作成中状態を永続化する
4. `inflight_operation_*` 残留時は `503 + 既存operationId` で即終了する（PAY.JP書き込みは行わない）
5. 既存 `active/trial`、または `canceled && access_end_at > now` は新規作成せず既存結果を返す
6. Discord参加・権限（ロール付与可能性）を検証し、不成立時は課金前に失敗させる
7. `operationId` を保存し `inflight_operation_*`（`type=subscribe`）を設定する
8. 認証前提検証通過時点で `__Host-link_session` を消費する（成功/失敗問わず再利用不可）
9. `payjpToken` を再取得し、`used=false` かつ `card.three_d_secure_status=verified` を検証する
10. PAY.JP書き込み（customer/charge/subscription）を実行する
11. customer作成/再利用の確定時点で `members.payjp_customer_id` を即時保存する
12. 初回のみ `charge` を実行する。`charge` 作成時は `metadata.discord_user_id` と `metadata.operation_id`（=`operationId`）を必須設定し、成功時点で `members.payjp_initial_charge_id` を即時保存する（非初回は `charge` を実行しない）
13. 初回は `trial_end=+3か月`、非初回は `trial_end` なしでsubscriptionを作成する。subscription作成時は `metadata.discord_user_id` と `metadata.operation_id`（=`operationId`）を必須設定し、成功時点で `members.payjp_subscription_id=subscription.id` を即時保存する
14. `members` 更新、初回ロール同期（最大3回の短時間リトライ）、成功時のみ `inflight_operation_*` クリア。不確定失敗時は `503 + operationId` を返し、`inflight_operation_*` を保持する

### 5.2 Google Form退会リンク生成（`POST /v1/subscriptions/cancel/google-form-link`）

1. `Origin` / `__Host-member_session` を検証する（`Origin` 欠落/不一致/`null` は `403`）
2. member_session から会員を特定する
3. `active/trial` の既存購読が無い場合は `409` を返す
4. `inflight_operation_*` 残留時は `503 + 既存operationId` で即終了する
5. 署名付きワンタイムトークンを生成し、会員ID・メールアドレス・TTLをDB保存する
6. メールアドレスとトークンを埋め込んだGoogle Form URLを返す

### 5.3 Google Form送信後の退会実行（`POST /v1/subscriptions/cancel/google-submit`）

1. `X-Cancel-Secret` を検証する（移行期間は旧 `X-Google-Cancel-Secret` をフォールバックで受け付ける）
2. 署名付きワンタイムトークンを検証し、会員IDとメールアドレスを確定する
3. `pg_advisory_lock(member_id)` 相当の排他を取得する
4. `active/trial/canceled` の既存購読が無い場合は `409` を返す
5. `inflight_operation_*` 残留時は `503 + 既存operationId` で即終了する（PAY.JP書き込みは行わない）
6. `payjp_subscription_id` 未設定は `409` を返し、再同期後の再実行を要求する
7. `cancel_requested_at` 既存ならPAY.JP再呼び出しなしで冪等 `200`
8. `operationId` 保存後に `members.payjp_subscription_id` 指定でPAY.JP cancel APIを1回実行する
9. `cancel_requested_at`, `subscription_status='canceled'`, `access_end_at=current_period_end`, `next_billing_at=current_period_end` を更新する
10. Discordロールは `access_end_at` 到達まで維持する（即時剥奪しない）。処理成功時にトークン消費を確定する
11. DB確定やトークン消費が失敗した場合は `503` を返し、必要に応じて日次再同期で整合を取る
12. 不確定失敗時は `503 + operationId` で保持し、復旧はCLIのみで実施する

### 5.4 既存ブラウザ退会API（`POST /v1/subscriptions/cancel`）

1. `Origin` / `__Host-link_session` を検証する（`Origin` 欠落/不一致/`null` は `403`）
2. `__Host-link_session` から Discord ユーザーを特定する
3. Google Form送信後の退会と同じ即時退会オーケストレーションを実行する

### 5.5 Webhook（`POST /v1/payjp/webhook`）

1. token / livemode / event.type許可リスト（`subscription.created/updated/renewed/canceled/deleted/paused/resumed`）/ `data.object=subscription` を検証
2. `livemode` 不一致 / 許可外 `event.type` / `data.object != subscription` は `ignored` を記録して `200` を返す（`ignore_reason` を記録し、`members` は更新しない）
3. 最小必須項目は `event.id/event.type/event.created/data.id`、`members.subscription_status` を反映するイベント（`created/deleted` 以外）は `data.status` も必須
4. 必須項目不足/不正は `failed` 記録で `200`（fail-close, `members` 非更新）
5. `subscription.created` は必須項目欠落時のみ `failed`、充足時は `ignored` で終了（`members` 非更新）
6. `data.metadata.discord_user_id` と `data.id` 逆引きが両方解決できる場合は一致必須。不一致は `failed` で `members` 非更新
7. `event.id` 重複は二重処理せず `200`
8. `event.created < members.last_payjp_event_created_at` は `ignored`（巻き戻し防止）
9. `event.created == members.last_payjp_event_created_at`（同秒）は `ignored` にせず処理対象とする（単一ワーカーでは到着順になり得るが、複数ワーカーではDBコミット順となり得るため順序は非決定）
10. `succeeded` イベントは `status` 不変時も `last_payjp_event_created_at` を更新する
11. `status` 不変の `subscription.updated` でも `payjp_plan_id` と `next_billing_at` を更新し、`active/trial` または `canceled` の場合は `current_period_end` が取れたとき `access_end_at` も更新する。ロール同期は行わない
12. 検証通過イベントのみ `members` 更新、状態変化時のみロール同期（Discord API `429/5xx` は短時間リトライ最大3回: `0秒/1秒/2秒` 待機、各回timeout `1秒`、総処理 `6秒` 以内）
13. 不明 `data.status` は `failed` + `members` 非更新 + 安全側でロール剥奪
14. fail-closeの応答境界は固定する（検証失敗は `200`、token不一致のみ `401`、DB受理不能のみ `503`）

### 5.6 再同期（日次 + 手動CLI）

1. 日次ジョブ: 全会員照合、`access_end_at` 超過/`subscription 404` を補正（`inflight_operation_*` は解除しない）
   - 実行スケジュールは `DAILY_RESYNC_CRON` を本番値で固定し、Day10前（2026-04-17開始前）に凍結する
2. 手動CLI: `operationId` / `discord_user_id` / 全会員を受け付け、`operationId` 突合 -> PAY.JP現状態確認 -> `members` 反映 -> ロール再同期を行う
   - 引数は相互排他で `--operation-id <operationId>` / `--discord-user-id <discord_user_id>` / `--all` のいずれか1つのみ受け付ける
   - 標準出力は1行JSON固定とし、`mode`, `target`, `processed_count`, `succeeded_count`, `failed_count`, `started_at`, `finished_at`, `duration_ms` を必須キーとする（`started_at` / `finished_at` は RFC 3339 UTC）
   - 終了コードは `0=完了かつ failed_count=0`, `2=実行完了だが failed_count>0（fail-close残を含む）`, `1=CLI実行エラー（入力不正/依存障害）` に固定する
3. `subscribe` 不確定失敗復旧では、初回charge既存判定を優先順位で固定する: (a) `members.payjp_initial_charge_id` がある場合はそれを正、(b) 無い場合は `GET /v1/charges?customer=<payjp_customer_id>&since=<inflight_operation_started_at_unix-3600>&until=<inflight_operation_started_at_unix+604800>&limit=100&offset=<0|100|...>` を `has_more=false` までページングして全件走査し、`metadata.operation_id == operationId` 一致を既存課金として採用し `members.payjp_initial_charge_id` を補正保存（再課金禁止）、(c) 一致0件のみchargeを1回実行、(d) 一致2件以上は確定不能としてfail-closeで停止（解除禁止）。ページング上限は `offset<=900`（最大1000件）とし、上限到達時に `has_more=true` の場合は一致件数に関わらず確定不能として fail-close（再課金禁止・解除禁止）。`members.payjp_customer_id IS NULL` の場合も即 fail-close（再課金/再作成/解除禁止、`member_impact_logs` 記録、エスカレーション）とする。`since`/`until` はPAY.JP仕様に合わせてUNIX秒（UTC）で渡し、`inflight_operation_started_at_unix` は `members.inflight_operation_started_at` をUTCとしてUnix秒化（整数）した値を用いる。`subscription` も未作成時のみ1回作成し、作成済みなら再作成しない（`charge=1/subscription=1` 維持）
4. `cancel` 不確定失敗復旧および `payjp_subscription_id` 欠落時は、`members.payjp_customer_id` を前提に `GET /v1/customers/:id/subscriptions` を `limit=100`・`offset=0,100,200,...` で `has_more=false` までページングして候補を取得し、`status in (active,trial,canceled,paused)` かつ `metadata.discord_user_id == members.discord_user_id` の候補を評価する（`members.payjp_customer_id IS NULL` の場合は即 fail-close（cancel実行/解除禁止、`member_impact_logs` 記録、エスカレーション））。ページング上限は `offset<=900`（最大1000件）とし、`offset=900` 到達時点で `has_more=true` の場合は一致件数に関わらず確定不能として fail-close（cancel実行/解除禁止）。`metadata.discord_user_id` 欠落時は、同じ `status` 条件の候補が1件のみであることに加え、`next_billing_at_unix = floor(extract(epoch from members.next_billing_at))`（UTC・整数秒）を用いて `subscription.current_period_end == next_billing_at_unix` の完全一致の場合に限りその1件を採用する。1件なら `members.payjp_subscription_id` を補正保存のうえ未cancel時のみcancel APIを1回実行し、0件または複数件（または `members.next_billing_at` が `NULL` / 時刻整合不一致）は確定不能としてfail-closeで停止する。通信エラーやJSON欠落で全件走査を完了できない場合も確定不能として fail-close で停止する（`members` 反映・解除は行わない）
5. 手動CLIで `inflight_operation_*` 残留会員を復旧した場合は `last_payjp_event_created_at = max(既存値, 再同期開始Unix秒)` を更新する
6. `inflight_operation_*` は整合確認できた場合のみCLIで解除し、確定不能時は解除しない（自動解除禁止）
7. 手動CLIは `failed_count`（`member_impact_logs.resolved_at IS NULL` 件数）を必須出力し、完了条件は `failed_count=0`
8. 全会員実行（`--all`）の運用証跡では `members.inflight_operation_id` 残留0件を確認する
9. `inflight_operation_started_at` から30分は監視強化閾値とし、整合条件を満たす場合のみ解除する
10. PAY.JP状態の確定不能が6時間超継続した場合は、解除可否/担当者/実施時刻を記録してエスカレーションする
11. 不整合解消時は、同一 `member_id + issue_code` の未解決 `member_impact_logs` を `resolved_at=now()` でクローズする

## 6. セキュリティ固定要件

1. `__Host-oauth_session` は `Domainなし + Secure + HttpOnly + SameSite=Lax + Path=/ + Max-Age=10m` を固定する
2. `__Host-link_session` は `Domainなし + Secure + HttpOnly + SameSite=Lax + Path=/ + Max-Age=15m` を固定し、認証前提検証通過後に消費する（成功/失敗問わず再利用不可）
3. `state` はワンタイムで原子的に検証/消費する（`state_hash + oauth_session_hash + 未使用 + TTL`）
4. OAuth `state` の生成・保管・検証は Discord OAuth2 の `State and Security` 推奨に準拠する
5. OAuth/linkトークンはURLに載せない（callback `Location` の query/fragment 禁止）
6. Cookie連携API（`session/subscriptions/cancel/google-form-link/cancel`）は `FRONTEND_BASE_URL` のみを許可Originに固定し、資格情報付きリクエストを必須とする
7. 課金系APIは `Origin` 厳密検証（`scheme+host+port` 正規化、`FRONTEND_BASE_URL` はorigin形式のみ。欠落/不一致/`Origin: null` は `403`）
8. 3Dセキュア実施に伴う個人情報取り扱いへの同意を購読前に取得し、同意なしは `createToken` を開始しない
9. Webhookは `token/livemode/event.type allowlist/data.object` を検証し、allowlist は `subscription.created/updated/renewed/canceled/deleted/paused/resumed` に固定する
10. `operationId + inflight_operation_*` をPAY.JP書き込み前に保存し、成功時のみクリアする
11. Google Form退会用トークンは短TTL・一回性・改ざん検知を持たせ、Apps Script共有シークレットと併用する
12. 認証/課金APIおよびWebhookで raw header/body を保存しない。カード情報は保存・ログ出力しない。その他機密値は固定キーでマスクする
13. `callback` / `session` 応答は `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を必須とする
14. Cookie連携成立のため、本番はフロントとAPIを同一サイト（同一eTLD+1）に配置する

## 7. 障害時ポリシー（MVP固定）

- 不確定失敗（timeout等）は必ず `503 + operationId` を返す
- クライアント自動再試行は禁止する
- `inflight_operation_*` 残留中は同一ユーザーの課金/解約APIを受け付けない（`503`）
- 日次再同期ジョブでは `inflight_operation_*` を解除しない（解除は手動CLIのみ）
- 再試行は運用CLIのみで実施する
- `inflight_operation_*` の解除規則は「成功時のみ」を原則とする
- 例外として、PAY.JP書き込み前の確定失敗時のみ `inflight_operation_*` をクリア可
- PAY.JP書き込み後は現状態照合で整合確定できた場合のみCLIでクリア可
- `failed_count > 0` の日は同日中に再同期/手動復旧を継続する
- PAY.JP状態の確定不能が6時間継続した場合は、当日中に緊急時手順へエスカレーションする
- PAY.JP再送仕様（HTTP 200 以外で3分間隔・最大3回）を前提に、検証失敗入力は `200` で終端し再送増幅を避ける

## 8. ログ最小要件（調査可能・過剰監査なし）

- 共通必須キー: `timestamp`, `service`, `endpoint`, `result`, `operationId(該当時)`
- 課金/解約APIのPAY.JP書き込み実行時と不確定失敗時は `operationId` を必須記録する
- Google Form連携では `cancel_token_id` またはフォーム送信識別子を記録し、同一回答の再送追跡を可能にする
- Webhook token不一致ログは `event`, `received_at`, `remote_ip`, `reason` を必須
- Webhook token不一致イベントは `payjp_events` 一意領域に入れない（分離ログのみ）
- `payjp_events.process_status` は `succeeded/failed/ignored` を記録
- `payjp_events` には `data.metadata.operation_id`（存在時）を保存する（`payjp_events.data_metadata_operation_id`）。`operationId` をキーとした調査導線を閉じる
- 失敗時は調査に必要な最小理由のみ記録し、カード情報は保存・ログ出力しない。その他機密値は固定キーでマスク
- `member_impact_logs` で未解決影響を追跡し、再同期解消時は同一 `member_id + issue_code` の `resolved_at` を更新
- 毎朝の運用確認指標は `payjp_events.process_status=failed` 件数、課金/解約APIの `503/5xx` 件数、`member_impact_logs.resolved_at IS NULL` 件数の3点を必須とする
- `access_end_at` が当日到達する退会申請ユーザーを毎日確認し、ロール除去漏れがあれば当日中に手動再同期で補正する
- Go-Live受け入れ前に `DAILY_RESYNC_CRON` 固定値、変更凍結時刻、直近1回の成功ログ参照を証跡へ残す
- Go-Live受け入れ前に運用文書「再同期CLI手順」「手動ロール剥奪手順」を最終化し、証跡へ紐づける
- Go-Live受け入れ前に `deep-research-report.md` の未確定事項3件（課金失敗時イベント遅延/Dunning、長時間5xxフェイルセーフ、トークン移管手順）の回答ソースと採用判断を証跡化する（実装着手のブロッカーにはしない）

## 9. 将来拡張（管理画面）— CR-005 / CR-006

MVP の明確な非スコープ（§ 明確な非スコープ）に従い、**2026-04-20 まで管理画面は追加しない**。リリース後に運用UIを実装する場合の **API・認証・配置の境界** は `docs/admin-console-boundary.md` を正とする。

要点のみここに固定する:

1. **ホスト名**: 管理画面は `admin.and--line.com` に固定する。利用者向け `www.and--line.com` / `api.and--line.com` と **オリジンを分離** し、導線・CORS 許可・Cookie 共有を行わない。
2. **認証**: Cloudflare Access を前段に置き、**外部IdP + MFA** を主とする。許可対象は明示ユーザまたは管理者グループに限定し、default deny とする。HTTP Basic は補助に留める。
3. **ランタイム**: **同一VPS** を使うが、公開系とは **別プロセス/別コンテナ/別ポート** に分離する。必要に応じて第2段階で別VPS化を検討する。
4. **実装**: ブラウザから DB / PAY.JP / Discord へ直接アクセスしない。管理用バックエンド経由で、既存の CLI 相当・コア整合ルール（`inflight_operation_*`、fail-close）を踏襲する。
5. **段階導入**: Phase A は **read-only**（会員検索・一覧・詳細・未解決影響確認）。Phase B は **単一会員中心の緊急操作**（再同期・ロール調整・課金停止相当）を限定追加する。`--all` 相当の一括操作は初期UIに含めない。

Change Request 履歴: `2weeks-spec.md` の **CR-005 / CR-006** を参照。
