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
| R5 | cancel受付境界（1か月前同日）で停止、終了日までロール維持 | billing-service | 受付前 `409`、受付内 `200`、終了日まで維持 |
| R6 | PAY.JP Webhook受信で課金状態反映 | sync-service | 許可イベントのみ冪等処理、fail-close |
| R7 | 課金状態でDiscordロール付与/剥奪 | sync-service | `active/trial/canceled` 付与、`paused/deleted` 剥奪 |
| R8 | 日次再同期 + 手動再同期CLIで不整合修復 | sync-service | 日次1回 + CLI（operationId/discord_user_id/全体） |
| R9 | 最低限の障害調査ログ | auth/billing/sync 共通 | 必須キーを構造化記録、過剰監査なし |

### 明確な非スコープ（固定）

- 管理画面、会員ポータル、Webhook再生/DLQ、高度監視、通知自動化は追加しない
- `inflight_operation_*` の解除は手動再同期CLIのみ（日次ジョブでは解除しない）

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
  - `POST /v1/subscriptions/cancel`
  - `members` の課金状態更新、`inflight_operation_*` 管理
  - 初回無料判定、cancel受付境界判定、Discord事前チェック
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
| `POST /v1/subscriptions` | `{ planId, email, payjpToken }` + `__Host-link_session` + `Origin` | `{ ok, memberId, subscriptionStatus, planId, trialApplied, accessEndAt }` | `401/403/409/422/503` |
| `POST /v1/subscriptions/cancel` | `{}` + `__Host-link_session` + `Origin` | `{ ok, memberId, cancelEffectiveAt, roleRemovalAt }` | `401/403/409/503` |
| `POST /v1/payjp/webhook` | PAY.JPイベント + `X-Payjp-Webhook-Token` | `200`（処理/ignored/failed/重複） | `401`（token不一致）, `503`（DB受理不能） |

補足:
- `GET /v1/auth/discord/callback` / `GET /v1/auth/discord/session` は `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を必須で返す
- `GET /v1/auth/discord/callback` の `302 Location` には OAuth/link トークンを載せない（query/fragment禁止）
- Cookie連携API（`GET /v1/auth/discord/session`, `POST /v1/subscriptions`, `POST /v1/subscriptions/cancel`）は `FRONTEND_BASE_URL` のみを許可Originに固定し、`Access-Control-Allow-Credentials: true` を必須とする

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

### 5.1 購読開始（`POST /v1/subscriptions`）

前提（フロント）:
- `payjpToken` 生成時に `PAY.JP.js createToken` へ `three_d_secure: true` を指定し、`card.name`（カード名義）と `card.email` または `card.phone` を必須で渡す。
- 3Dセキュア実施に伴う個人情報取り扱いへの同意をUIで取得し、同意なしは `createToken` を開始しない。

1. `Origin` / `__Host-link_session` / `planId` を検証する（`Origin` は `scheme+host+port` 正規化比較）
2. `pg_advisory_xact_lock(hashtext(discord_user_id))` を取得する
3. `members` 行が無い場合は `discord_user_id + email` で仮行を作成し、購読作成中状態を永続化する
4. `inflight_operation_*` 残留時は `503 + 既存operationId` で即終了する（PAY.JP書き込みは行わない）
5. 既存 `active/trial`、または `canceled && access_end_at > now` は新規作成せず既存結果を返す
6. Discord参加・権限（ロール付与可能性）を検証し、不成立時は課金前に失敗させる
7. `operationId` を保存し `inflight_operation_*`（`type=subscribe`）を設定する
8. 認証前提検証通過時点で `__Host-link_session` を消費する（成功/失敗問わず再利用不可）
9. `payjpToken` を再取得し、`used=false` かつ `card.three_d_secure_status=verified` を検証する
10. PAY.JP書き込み（customer/charge/subscription）を実行する
11. customer作成/再利用の確定時点で `members.payjp_customer_id` を即時保存する
12. 初回のみ `charge` を実行し、成功時点で `members.payjp_initial_charge_id` を即時保存する（非初回は `charge` を実行しない）
13. 初回は `trial_end=+3か月`、非初回は `trial_end` なしでsubscriptionを作成し、成功時点で `members.payjp_subscription_id=subscription.id` を即時保存する
14. `members` 更新、初回ロール同期（最大3回の短時間リトライ）、成功時のみ `inflight_operation_*` クリア。不確定失敗時は `503 + operationId` を返し、`inflight_operation_*` を保持する

### 5.2 退会申請（`POST /v1/subscriptions/cancel`）

1. `Origin` / `__Host-link_session` を検証する（`Origin` 欠落/不一致/`null` は `403`）
2. `pg_advisory_xact_lock(hashtext(discord_user_id))` を取得する
3. `active/trial/canceled` の既存購読が無い場合は `409` を返す
4. `inflight_operation_*` 残留時は `503 + 既存operationId` で即終了する（PAY.JP書き込みは行わない）
5. `access_end_at` 未設定は `409` を返し、再同期後の再実行を要求する
6. `payjp_subscription_id` 未設定は `409` を返し、再同期後の再実行を要求する
7. 受付期間境界（1か月前同日00:00 JST、存在しない日は月末繰上げ）を判定し、受付前は `409` を返す
8. 認証前提検証通過時点で `__Host-link_session` を消費する（成功/失敗問わず再利用不可）
9. `cancel_requested_at` 既存ならPAY.JP再呼び出しなしで冪等 `200`
10. `operationId` 保存後に `members.payjp_subscription_id` 指定でPAY.JP cancel APIを1回実行
11. `cancel_requested_at` と `access_end_at` を更新（ロールは終了日まで維持）
12. 不確定失敗時は `503 + operationId` で保持し、復旧はCLIのみで実施する

### 5.3 Webhook（`POST /v1/payjp/webhook`）

1. token / livemode / event.type許可リスト（`subscription.created/updated/renewed/canceled/deleted/paused/resumed`）/ `data.object=subscription` を検証
2. `livemode` 不一致 / 許可外 `event.type` / `data.object != subscription` は `ignored` を記録して `200` を返す（`ignore_reason` を記録し、`members` は更新しない）
3. 最小必須項目は `event.id/event.type/event.created/data.id`、`members.subscription_status` を反映するイベント（`created/deleted` 以外）は `data.status` も必須
4. 必須項目不足/不正は `failed` 記録で `200`（fail-close, `members` 非更新）
5. `subscription.created` は必須項目欠落時のみ `failed`、充足時は `ignored` で終了（`members` 非更新）
6. `data.metadata.discord_user_id` と `data.id` 逆引きが両方解決できる場合は一致必須。不一致は `failed` で `members` 非更新
7. `event.id` 重複は二重処理せず `200`
8. `event.created < members.last_payjp_event_created_at` は `ignored`（巻き戻し防止）
9. `event.created == members.last_payjp_event_created_at` は到着順で処理する（同秒イベントの取りこぼし防止）
10. `succeeded` イベントは `status` 不変時も `last_payjp_event_created_at` を更新する
11. `status` 不変の `subscription.updated` でも `payjp_plan_id` と `next_billing_at/access_end_at` を更新し、ロール同期は行わない
12. 検証通過イベントのみ `members` 更新、状態変化時のみロール同期（Discord API `429/5xx` は短時間リトライ最大3回: `0秒/1秒/2秒` 待機、各回timeout `1秒`、総処理 `6秒` 以内）
13. 不明 `data.status` は `failed` + `members` 非更新 + 安全側でロール剥奪
14. fail-closeの応答境界は固定する（検証失敗は `200`、token不一致のみ `401`、DB受理不能のみ `503`）

### 5.4 再同期（日次 + 手動CLI）

1. 日次ジョブ: 全会員照合、`access_end_at` 超過/`subscription 404` を補正（`inflight_operation_*` は解除しない）
   - 実行スケジュールは `DAILY_RESYNC_CRON` を本番値で固定し、Day10前（2026-04-17開始前）に凍結する
2. 手動CLI: `operationId` / `discord_user_id` / 全会員を受け付け、`operationId` 突合 -> PAY.JP現状態確認 -> `members` 反映 -> ロール再同期を行う
3. `subscribe` 不確定失敗復旧では、`members.payjp_initial_charge_id` を決定キーに既存charge有無を判定し、未作成時のみ1回実行する。`subscription` も未作成時のみ1回作成し、作成済みなら再作成しない（`charge=1/subscription=1` 維持）
4. `cancel` 不確定失敗復旧では、未cancel時のみcancel APIを1回実行し、cancel済みなら `members` 反映のみ行う
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
6. Cookie連携API（`session/subscriptions/cancel`）は `FRONTEND_BASE_URL` のみを許可Originに固定し、資格情報付きリクエストを必須とする
7. 課金系APIは `Origin` 厳密検証（`scheme+host+port` 正規化、`FRONTEND_BASE_URL` はorigin形式のみ。欠落/不一致/`Origin: null` は `403`）
8. 3Dセキュア実施に伴う個人情報取り扱いへの同意を購読前に取得し、同意なしは `createToken` を開始しない
9. Webhookは `token/livemode/event.type allowlist/data.object` を検証し、allowlist は `subscription.created/updated/renewed/canceled/deleted/paused/resumed` に固定する
10. `operationId + inflight_operation_*` をPAY.JP書き込み前に保存し、成功時のみクリアする
11. 認証/課金APIおよびWebhookで raw header/body を保存しない。カード情報は保存・ログ出力しない。その他機密値は固定キーでマスクする
12. `callback` / `session` 応答は `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を必須とする
13. Cookie連携成立のため、本番はフロントとAPIを同一サイト（同一eTLD+1）に配置する

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

## 8. ログ最小要件（調査可能・過剰監査なし）

- 共通必須キー: `timestamp`, `service`, `endpoint`, `result`, `operationId(該当時)`
- 課金/解約APIのPAY.JP書き込み実行時と不確定失敗時は `operationId` を必須記録する
- Webhook token不一致ログは `event`, `received_at`, `remote_ip`, `reason` を必須
- Webhook token不一致イベントは `payjp_events` 一意領域に入れない（分離ログのみ）
- `payjp_events.process_status` は `succeeded/failed/ignored` を記録
- 失敗時は調査に必要な最小理由のみ記録し、カード情報は保存・ログ出力しない。その他機密値は固定キーでマスク
- `member_impact_logs` で未解決影響を追跡し、再同期解消時は同一 `member_id + issue_code` の `resolved_at` を更新
- 毎朝の運用確認指標は `payjp_events.process_status=failed` 件数、課金/解約APIの `503/5xx` 件数、`member_impact_logs.resolved_at IS NULL` 件数の3点を必須とする
- `access_end_at` が当日到達する退会申請ユーザーを毎日確認し、ロール除去漏れがあれば当日中に手動再同期で補正する
- Go-Live受け入れ前に `DAILY_RESYNC_CRON` 固定値、変更凍結時刻、直近1回の成功ログ参照を証跡へ残す
- Go-Live受け入れ前に運用文書「再同期CLI手順」「手動ロール剥奪手順」を最終化し、証跡へ紐づける
