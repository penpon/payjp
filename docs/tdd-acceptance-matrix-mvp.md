# TDD受け入れマトリクス（MVP固定）

- 正本仕様: `2weeks-spec.md`
- 採番ルール: `2. スコープ` の9項目を `R1-R9` として扱う
- TDD方針: t_wada式 `Red -> Green -> Refactor` を最小粒度で固定する

## 1. R1-R9 -> テストID 対応表

| 要件ID | 要件 | 対応テストID |
|---|---|---|
| R1 | Discord OAuth Lite | `T-P0-01` |
| R2 | 3プラン購読開始 | `T-P0-02`, `T-P0-03` |
| R3 | 初回1か月課金 + 2か月目/3か月目無料 | `T-P0-02` |
| R4 | 4か月目以降月次課金 | `T-P0-02` |
| R5 | Google Form退会受付 + 即時退会完了 | `T-P0-05` |
| R6 | PAY.JP Webhook反映 | `T-P0-07` |
| R7 | ロール付与/剥奪 | `T-P0-02`, `T-P0-06`, `T-P0-07` |
| R8 | 日次再同期・手動再同期CLI | `T-P0-04`, `T-P0-06` |
| R9 | 最低限の障害調査ログ | `T-P0-01`, `T-P0-02`, `T-P0-04`, `T-P0-05`, `T-P0-07` |

## 2. P0優先順位（Go-Live必須）

1. `T-P0-01` OAuth原子的検証
2. `T-P0-02` 購読作成（3プラン・3DS・Origin・事前検証）
3. `T-P0-03` 並列登録と既存契約ガード
4. `T-P0-04` subscribe不確定失敗 `503 + operationId` とCLI復旧
5. `T-P0-05` Google Form退会・冪等・不確定失敗復旧
6. `T-P0-06` `canceled`（`access_end_at` 到達後）/ `paused` / `deleted` の剥奪
7. `T-P0-07` Webhook fail-close・冪等・古いイベント無視・ログ非保存

## 2.1 `deep-research-report.md` 由来の固定検証観点

| 調査由来の固定観点 | 主に担保するテストID | 追加運用ゲート |
|---|---|---|
| Webhook中心 + 冪等 + 順不同耐性 | `T-P0-04`, `T-P0-07` | - |
| 署名検証 + fail-close + 応答境界固定 | `T-P0-07` | - |
| Discord API `429/5xx` 自己修復 | `T-P0-06` | - |
| 課金停止状態（`paused/deleted/不明status`）の安全側剥奪、`canceled` の `access_end_at` 猶予 | `T-P0-06`, `T-P0-07` | - |
| ベンダー未確定事項の解消（課金失敗時イベント遅延/Dunning、長時間5xxフェイルセーフ、トークン移管手順） | - | Go-Live前必須（実装着手ブロッカーではない。Day3まで一次回答収集、Day10前に採用判断固定） |

## 3. テストID詳細（Red/Green/Refactor固定）

### T-P0-01（R1）

- Red:
  - `state` 不一致、TTL超過、`used_at` 既存、Cookie不整合で callback が `401` にならない
  - callback/session に `Cache-Control: no-store` / `Referrer-Policy: no-referrer` が無い
  - callback の `302 Location` に OAuth/link トークン（query/fragment）が載る
  - フロント/APIが同一eTLD+1でない構成を拒否できず、Cookie連携が成立しない
  - Cookie連携API（`GET /v1/auth/discord/session`）の許可Originが `FRONTEND_BASE_URL` 固定でない、または `Access-Control-Allow-Credentials: true` が無い
  - `/start` の `scope` が `identify` 固定でない
  - `Set-Cookie` の `Path=/` / `Max-Age`（`oauth=10m`, `link=15m`）が要件通りでない
  - auth系APIログで raw header/body が保存される、または固定キー機密マスクが行われない
- Green:
  - `oauth_states` を1トランザクションで検証/消費
  - `__Host-oauth_session` / `__Host-link_session` 発行
  - callback/session に必須ヘッダ付与
  - callback の `302 Location` に OAuth/link トークン非掲載を検証
  - 本番構成でフロント/APIが同一eTLD+1であることを検証する
  - Cookie連携API（`session/subscriptions/cancel`）の許可Originを `FRONTEND_BASE_URL` に固定し、資格情報付きリクエストを検証
  - `Set-Cookie` 属性（Domainなし/Secure/HttpOnly/SameSite=Lax/Path=/ と個別 `Max-Age`）を検証
  - auth系APIログで raw header/body 非保存と固定キー機密マスクを検証
- Refactor:
  - state検証ロジックを `auth-service` 内で共通化
  - Cookie生成設定の定数化
- モック/注入要件:
  - Discord APIユーザー取得をスタブ化
  - 時刻注入でTTL切れを決定的再現
- 受け入れ証跡:
  - 実施日時:
  - コマンドorテストID: `T-P0-01`
  - 結果:
  - `CI実行ID` または `主要ログ参照`:

### T-P0-02（R2/R3/R4/R7）

- Red:
  - `planId` 許可外で `422` にならず通ってしまう
  - 3DS `verified` 以外（`card.three_d_secure_status != verified`）で課金が走る
  - 3Dセキュア実施に伴う個人情報取り扱い同意が無くても `createToken` が開始される
  - `PAY.JP.js createToken` で `card.name` または `card.email` / `card.phone` が欠落してもトークン生成が進んでしまう
  - `Origin` 欠落/不一致/`null` を拒否できない
  - `Origin` 正規化比較（`scheme+host+port`）が崩れ、port違いを誤って通す
  - `FRONTEND_BASE_URL` が origin形式でない（path/末尾slash付き）設定を起動時に拒否できない
  - Discord未参加/ロール付与不可でもPAY.JP APIが呼ばれる
  - 初回無料判定が `discord_user_id` 単位で固定されない
  - 非初回ユーザーでも `charge` が実行される
  - 退会後再加入で `first_trial_granted_at` が保持されず、trialが再適用される
  - `inflight_operation_id` 既存時の `503` 応答で `__Host-link_session` が誤って消費される
  - 消費済み `__Host-link_session` の再送で `401` にならず再実行できる
  - `members` 行が無いときに仮行作成されず、購読作成中状態が永続化されない
  - customer作成/再利用の確定後に `members.payjp_customer_id` が保存されず、`503` 復旧時の照合キーが欠落する
  - 初回 `charge` 成功後に `members.payjp_initial_charge_id` が保存されず、再同期で既存課金を一意判定できない
  - subscription作成成功後に `members.payjp_subscription_id` が保存されず、cancel/再同期/Webhook逆引きの照合キーが欠落する
  - `charge` / `subscription` 作成時に `metadata.discord_user_id` と `metadata.operation_id` が設定されず、Webhook同定と復旧照合が不安定になる
  - 代表1プランの実課金E2E、残り2プランの設定整合確認が不足する
  - `subscription interval=month` の検証が無く、非month設定を見逃す
  - 成功レスポンスの `accessEndAt` が RFC 3339 UTC 文字列で固定されず、Unix秒/JST文字列などの型揺れを許してしまう
  - 成功レスポンスの `memberId/subscriptionStatus/planId/trialApplied/accessEndAt` の型・必須キー検証が不足し、実装差分を見逃す
  - 課金APIログで raw header/body またはカード情報が保存される、あるいは固定キー機密マスクが行われない
- Green:
  - `planId` allowlist検証、3DS token再取得検証、Origin厳密検証
  - 3Dセキュア実施に伴う個人情報取り扱い同意が無い場合は `createToken` を開始しないことを検証する
  - フロントの `PAY.JP.js createToken` で `three_d_secure: true` + `card.name` + `card.email`（または `card.phone`）を必須化し、欠落時は `POST /v1/subscriptions` を送信しないことを検証する
  - `Origin` は `scheme+host+port` 正規化で比較し、`FRONTEND_BASE_URL` はorigin形式のみ許可
  - 事前Discord検証を課金前に実行
  - `inflight_operation_id` 既存時は `503 + 既存operationId` を返し、`__Host-link_session` 未消費かつPAY.JP書き込み0回を検証する
  - 認証前提検証通過時点で `__Host-link_session` を消費し、再送は `401`（PAY.JP API未呼び出し）
  - `members` 行が無い場合は `discord_user_id + email` で仮行を作成する
  - customer作成/再利用の確定時点で `members.payjp_customer_id` を即時保存する
  - 初回 `charge` 成功時点で `members.payjp_initial_charge_id` を即時保存する
  - subscription作成成功時点で `members.payjp_subscription_id` を即時保存する
  - `charge` / `subscription` 作成時に `metadata.discord_user_id` と `metadata.operation_id` を必須設定する
  - 初回 `charge + trial_end(+3か月)`、非初回 `trial_endなし`
  - 非初回は `charge` を実行せず subscriptionのみ作成する
  - 退会後再加入でも `first_trial_granted_at` を保持し、trial再適用なしを検証する
  - 代表1プランは実課金E2Eで成功を確認し、残り2プランは設定整合テストで登録成功を確認する
  - `subscription interval=month` を検証する
  - 成功レスポンスは `{ ok: true, memberId: uuid文字列, subscriptionStatus: enum, planId: string, trialApplied: boolean, accessEndAt: RFC3339 UTC文字列 }` を満たすことを検証する
  - `payjp_plan_id` / `payjp_subscription_id` / `first_trial_granted_at` / `access_end_at` 保存（初回は `payjp_initial_charge_id` も保存）
  - 課金APIログで raw header/body 非保存、カード情報非保存/非出力、固定キー機密マスクを検証
- Refactor:
  - 認証前提検証とPAY.JP書き込み境界の関数分離
  - trial判定・period反映ロジックの重複排除
- モック/注入要件:
  - PAY.JP token/customer/charge/subscription のスタブ
  - Discord guild/member/role権限のスタブ
  - フロント側は3DS失敗時に `POST /v1/subscriptions` 未送信を検証
- 受け入れ証跡:
  - 実施日時:
  - コマンドorテストID: `T-P0-02`
  - 結果:
  - `CI実行ID` または `主要ログ参照`:

### T-P0-03（R2）

- Red:
  - 同一 `discord_user_id` 並列実行で `charge/subscription` が重複
  - `active/trial` または `canceled && access_end_at > now` で新規作成される
- Green:
  - `pg_advisory_lock(discord_user_id::bigint)` による排他
  - 既存有効契約ガードで新規作成を行わず、既存結果を返却する
- Refactor:
  - ロック取得・既存判定をbilling共通ユーティリティ化
- モック/注入要件:
  - 並列実行ハーネス（同時2リクエスト）
  - PAY.JP呼び出し回数アサート（`charge=1` / `subscription=1`）
- 受け入れ証跡:
  - 実施日時:
  - コマンドorテストID: `T-P0-03`
  - 結果:
  - `CI実行ID` または `主要ログ参照`:

### T-P0-04（R8/R9）

- Red:
  - `charge` 後 `subscription` 不確定失敗時に `503 + operationId` にならない
  - `inflight_operation_*` が保持されず消えてしまう
  - `inflight_operation_id` 既存時に即 `503 + 既存operationId` にならず、PAY.JP書き込みが走る
  - `members` 行が無い場合に仮行作成されず、`operationId` 復旧時の会員特定に失敗する
  - customer作成/再利用の確定後に `members.payjp_customer_id` が保存されず、`operationId` 復旧照合ができない
  - 初回 `charge` 成功後に `members.payjp_initial_charge_id` が保存されず、CLI復旧で既存課金検知ができない
  - `members.payjp_initial_charge_id` 欠落時に `GET /v1/charges?...&limit=100&offset=...` のページング（`has_more=false` まで）を行わず、先頭1ページのみで一致0件扱いして再課金が発生する、または `offset<=900` 上限到達時（`has_more=true`）を一致0件扱いして再課金が発生する
  - `metadata.operation_id` 一致が複数件でもfail-closeにならず、復旧を継続してしまう
  - 日次再同期で `inflight_operation_*` が誤って解除される
  - PAY.JP書き込み前の確定失敗で `inflight_operation_*` がクリアされない
  - PAY.JP書き込み後の確定失敗で整合未確認でも `inflight_operation_*` が誤ってクリアされる
  - CLI復旧後に `charge/subscription` が二重化する
  - CLI復旧後に `last_payjp_event_created_at` が更新されず、遅延Webhookで巻き戻る
  - 手動CLIの結果に `failed_count` が含まれない
  - 手動CLIが `--operation-id` / `--discord-user-id` / `--all` の相互排他を強制せず、曖昧な対象指定で実行できてしまう
  - 手動CLIの終了コードが規約化されず、`failed_count>0` でも `0` を返して運用判定を誤らせる
  - PAY.JP書き込み実行時/不確定失敗時に `operationId` ログキーが欠落する
- Green:
  - PAY.JP書き込み前に `operationId` と `inflight_operation_*` 保存
  - `members` 行が無い場合は `discord_user_id + email` で仮行を作成する
  - customer作成/再利用の確定時点で `members.payjp_customer_id` を保存し、CLI復旧の照合キーに使う
  - 初回 `charge` 成功時点で `members.payjp_initial_charge_id` を保存し、CLI復旧の課金判定キーに使う
  - `members.payjp_initial_charge_id` 欠落時は `GET /v1/charges?...&limit=100&offset=<0|100|...>` を `has_more=false` までページングして全件走査し、`metadata.operation_id=operationId` 一致を既存課金として採用し `members.payjp_initial_charge_id` を補正保存する（`offset<=900` 上限到達時に `has_more=true` の場合は確定不能として fail-close・再課金禁止）。`since/until` は `members.inflight_operation_started_at` をUTCとしてUnix秒化（整数）した `inflight_operation_started_at_unix` を用いる
  - `metadata.operation_id` 一致0件のみchargeを1回実行し、一致2件以上は確定不能としてfail-closeで停止する
  - `members.payjp_customer_id` 欠落時は fail-close（復旧続行/再課金/`inflight_operation_*` 解除禁止）とし、`member_impact_logs` 記録とエスカレーションを行う
  - `inflight_operation_id` 既存時は即 `503 + 既存operationId` を返し、PAY.JP書き込み0回
  - 日次再同期は `inflight_operation_*` を解除せず、解除は手動CLIのみ
  - PAY.JP書き込み前の確定失敗では `inflight_operation_*` をクリアする
  - PAY.JP書き込み後の確定失敗では整合確認できた場合のみ `inflight_operation_*` をクリアする
  - 不確定失敗で `503 + operationId` を返却し自動再試行禁止
  - 手動再同期CLIで `operationId` 指定復旧し、`members.payjp_initial_charge_id` または `metadata.operation_id=operationId` を決定キーに `charge=1/subscription=1` を維持
  - 手動CLIは `--operation-id` / `--discord-user-id` / `--all` の相互排他を強制する
  - `members.payjp_initial_charge_id` を意図的に欠落させたケースでも、`metadata.operation_id=operationId` 経路で復旧できることを必須とする
  - CLI復旧時に `last_payjp_event_created_at = max(既存値, 再同期開始Unix秒)` を更新し、旧 `event.created` は `ignored`
  - 手動CLI結果に `failed_count` を出力する
  - 手動CLI結果は1行JSON（`mode`, `target`, `processed_count`, `succeeded_count`, `failed_count`, `started_at`, `finished_at`, `duration_ms`）で出力し、`started_at` / `finished_at` は RFC 3339 UTC を満たす
  - 手動CLIの終了コードは `0=完了かつ failed_count=0`, `2=実行完了だが failed_count>0`, `1=CLI実行エラー` を満たす
  - PAY.JP書き込み実行時/不確定失敗時の `operationId` 必須ログを検証する
- Refactor:
  - operation管理を専用モジュール化
  - CLI復旧フローの共通ステップ化（照合 -> 反映 -> 同期）
- モック/注入要件:
  - **決定的503注入**: `subscription create` 呼び出し直前/直後に擬似timeoutを発生させる注入フラグを実装
  - CLIはPAY.JP現状態取得レスポンスを差し替え可能にする
- 受け入れ証跡:
  - 実施日時:
  - コマンドorテストID: `T-P0-04`
  - 結果:
  - `CI実行ID` または `主要ログ参照`:

### T-P0-05（R5）

- Red:
  - `POST /v1/subscriptions/cancel/google-form-link` が `__Host-member_session` なしでもURLを返してしまう
  - `Origin` 欠落/`Origin: null` で `403` にならない
  - Google Form用トークンにTTL・一回性・改ざん検知が無い
  - Google Form URLにメールまたはトークンが事前入力されない
  - `POST /v1/subscriptions/cancel/google-submit` が共有シークレット不一致でも受理される
  - Google送信メールとトークン内メールが不一致でも受理される
  - 並列 `google-submit` でロックが効かず、PAY.JP cancel API が重複実行される
  - `active/trial/canceled` 既存購読が無いケースで `409` にならない
  - `payjp_subscription_id` 未設定で `409` にならず、cancel APIが実行される
  - `payjp_subscription_id` 欠落時の再構築で `GET /v1/customers/:id/subscriptions` を使わず、手動判断に依存して誤ったsubscriptionを採用する
  - `GET /v1/customers/:id/subscriptions` のページングを先頭1ページで打ち切る、または `offset<=900` 上限到達時の `has_more=true` を未定義のまま走査して誤判定/無限走査になる
  - `metadata.discord_user_id` 欠落かつ `status in (active,trial,canceled,paused)` の候補が1件のみかつ `current_period_end == floor(extract(epoch from members.next_billing_at))`（UTC・整数秒）一致のケースで補正保存できず、退会不能になる
  - `metadata.discord_user_id` 欠落時に `current_period_end != floor(extract(epoch from members.next_billing_at))`（UTC・整数秒）または `members.next_billing_at IS NULL` でも誤って補正採用してしまう
  - `payjp_subscription_id` 再構築候補が0件/複数件でもfail-closeで停止せず、cancelが実行される
  - `cancel_requested_at` 既存時にPAY.JP cancel APIが再実行される
  - `inflight_operation_id` 既存時に即 `503 + 既存operationId` にならない
  - 不確定失敗で `503 + operationId` が返らない
  - PAY.JP書き込み前の確定失敗で `inflight_operation_*` がクリアされない
  - PAY.JP書き込み後の確定失敗で整合未確認でも `inflight_operation_*` が誤ってクリアされる
  - 退会処理のDB確定失敗時に不整合が残る
  - Google送信後の退会で `access_end_at` が `current_period_end` 相当に設定されず、利用終了日がずれる
  - PAY.JP書き込み実行時/不確定失敗時に `operationId` ログキーが欠落する
  - 解約APIログで raw header/body またはカード情報が保存される、あるいは固定キー機密マスクが行われない
  - `POST /v1/subscriptions/cancel/google-submit` 成功レスポンスの `cancelEffectiveAt` / `roleRemovalAt` が RFC 3339 UTC 文字列で固定されず、型揺れを許してしまう
- Green:
  - `POST /v1/subscriptions/cancel/google-form-link` は `__Host-member_session` と `Origin` を検証し、署名付きワンタイムトークン入りのGoogle Form URLを返す
  - `Origin` 欠落/不一致/`Origin: null` は `403` を返す
  - `Origin` は `scheme+host+port` 正規化比較で厳密検証
  - Google Formトークンは TTL・一回性・改ざん検知を持ち、同一トークンの再送は冪等成功または明示失敗に収束する
  - `X-Cancel-Secret`（または移行期間の旧 `X-Google-Cancel-Secret`）不一致は `401` を返す
  - `pg_advisory_lock(member_id)` 相当の排他により並列 `google-submit` を排他する
  - `active/trial/canceled` 既存購読が無い場合は `409`
  - `payjp_subscription_id` 未設定は `409` を返し、再同期後の再実行を要求する
  - `payjp_subscription_id` 欠落時は `GET /v1/customers/:id/subscriptions` を `limit=100`・`offset=0,100,200,...` で `has_more=false` まで走査し、`status in (active,trial,canceled,paused)` かつ `metadata.discord_user_id == discord_user_id` が1件のみの場合に補正保存する。`offset<=900` 上限到達時に `has_more=true` の場合は一致件数に関わらず fail-close で停止する（cancel API実行禁止、`inflight_operation_*` 解除禁止）
  - `metadata.discord_user_id` 欠落時は、`status in (active,trial,canceled,paused)` の候補が1件のみかつ `current_period_end == floor(extract(epoch from members.next_billing_at))`（UTC・整数秒）一致の場合に限りその1件を補正保存し、0件または複数件（または `members.next_billing_at IS NULL` / 不一致）はfail-closeで停止する
  - `members.payjp_customer_id` 欠落時は fail-close（cancel実行/`inflight_operation_*` 解除禁止）とし、`member_impact_logs` 記録とエスカレーションを行う
  - 候補が0件または複数件の場合は確定不能としてfail-closeで停止し、`inflight_operation_*` を解除せずcancelを実行しない
  - 初回 `google-submit` のみPAY.JP cancel API実行、再送時はPAY.JP再呼び出しなしで冪等 `200` となる
  - PAY.JP cancel APIは `members.payjp_subscription_id` 指定で実行する
  - `inflight_operation_id` 既存時は即 `503 + 既存operationId`（PAY.JP書き込み0回）
  - PAY.JP書き込み前の確定失敗では `inflight_operation_*` をクリアする
  - PAY.JP書き込み後の確定失敗では整合確認できた場合のみ `inflight_operation_*` をクリアする
  - CLI復旧で未cancel時のみcancel APIを1回実行し、cancel済みはAPI再実行なしで反映のみ行う
  - 不確定失敗時は `inflight_operation_*` 保持で `503`
  - 成功時は `subscription_status='canceled'`, `access_end_at=current_period_end`, `next_billing_at=current_period_end`, `role_state='granted'`（期間内）を満たす
  - DB確定失敗時は `503` を返し、再同期で回復できる
  - CLI再同期で整合回復
  - 成功レスポンスは `{ ok: true, memberId: uuid文字列, cancelEffectiveAt: RFC3339 UTC文字列, roleRemovalAt: RFC3339 UTC文字列 }` を満たすことを検証する
  - PAY.JP書き込み実行時/不確定失敗時の `operationId` 必須ログを検証する
  - 解約APIログで raw header/body 非保存、カード情報非保存/非出力、固定キー機密マスクを検証
- Refactor:
  - Google Formトークン生成/検証ロジックを純関数化
  - cancel冪等判定とロール維持（`access_end_at` まで）の責務分離
- モック/注入要件:
  - Google Apps Script 相当のヘッダ/ボディ送信をスタブ化
  - **決定的503注入**: cancel API呼び出し後にtimeoutを発生
  - Discordロール剥奪失敗を注入可能にする
- 受け入れ証跡:
  - 実施日時:
  - コマンドorテストID: `T-P0-05`
  - 結果:
  - `CI実行ID` または `主要ログ参照`:

### T-P0-06（R7/R8）

- Red:
  - `canceled` かつ `access_end_at > now` の間にロール剥奪される
  - `paused/deleted` でロール剥奪されない（安全側剥奪が効かない）
  - ロール同期で Discord API `429/5xx` 発生時に短時間リトライ（最大3回）が走らない
  - 日次再同期でPAY.JP `subscription 404` を `deleted` 扱いできない
  - 手動CLIの `--discord-user-id` / `--all` 経路で再同期できない
  - 不整合解消時に同一 `member_id + issue_code` の `member_impact_logs` だけをクローズできない
  - `failed_count` が未出力、または `resolved_at IS NULL` 件数と一致しない
- Green:
  - Webhookまたは日次再同期で `canceled`（`access_end_at` 到達後）/ `paused` / `deleted` の剥奪条件を適用
  - ロール同期は Discord API `429/5xx` に対して短時間リトライ最大3回（`0秒/1秒/2秒` 待機、各回timeout `1秒`、総処理 `6秒` 以内）を検証する
  - `subscription 404` を `deleted` 扱いで補正
  - `member_impact_logs` の未解決は同一 `member_id + issue_code` をキーに再同期で解消
  - 手動CLIは `operationId` / `discord_user_id` / 全会員の3モードをサポート
  - 手動CLIの `--all` 実行時は `target="all"` を含むJSON結果を返し、件数キー（`processed_count/succeeded_count/failed_count`）が欠落しない
  - 手動CLIの `failed_count` は `member_impact_logs.resolved_at IS NULL` 件数と一致し、完了判定は `failed_count=0` のみ
  - `--all` 実行後に `members.inflight_operation_id` 残留0件を検証する
- Refactor:
  - ロール判定関数を単一化（status + access_end_at）
  - 日次/手動再同期の共通処理化
- モック/注入要件:
  - Discord role API成功/失敗スタブ
  - PAY.JP subscription `404` 応答スタブ
- 受け入れ証跡:
  - 実施日時:
  - コマンドorテストID: `T-P0-06`
  - 結果:
  - `CI実行ID` または `主要ログ参照`:

### T-P0-07（R6/R7/R9）

- Red:
  - `event.id` 重複で二重更新される
  - 古い `event.created` で状態巻き戻しが起こる
  - 同秒 `event.created`（`event.created == last_payjp_event_created_at`）のイベントを誤って `ignored` して取りこぼす（`<=` 判定など）
  - `livemode` 不一致 / 許可外 `event.type` / `data.object != subscription` が `ignored` にならない
  - `event.type` 許可イベント（`subscription.created/updated/renewed/canceled/deleted/paused/resumed`）以外を拒否できない
  - `subscription.updated` の `status` 不変時に `payjp_plan_id` / `next_billing_at` / `access_end_at` が更新されない
  - 必須項目欠落・逆引き不一致で `members` が更新される
  - `event.id/event.type/event.created/data.id` または条件付き `data.status` の必須判定が誤る
  - token不一致で `401` にならない
  - token不一致時に `payjp_events` に記録される、または分離ログ4キーが欠落する
  - `subscription.created` の `failed/ignored` 分岐が誤る
  - payloadに `data.metadata.operation_id` があるのに `payjp_events` へ保存されない
  - 不明 `data.status` で fail-close + 安全側剥奪にならない
  - fail-close入力（検証失敗）で `200` を返さず、PAY.JP再送を誘発する
  - PAY.JP再送前提（HTTP 200 以外で3分間隔・最大3回）を想定せず、検証失敗入力で不要な非200を返して再送を増幅させる
  - DB受理不能以外で `503` を返す
  - raw header/body またはカード情報がログ保存される
  - 固定キー機密マスクが行われない
- Green:
  - token/livemode/allowlist（`subscription.created/updated/renewed/canceled/deleted/paused/resumed`）/`data.object` 検証
  - `livemode` 不一致 / 許可外 `event.type` / `data.object != subscription` は `process_status=ignored`、`ignore_reason` 記録、`members` 非更新で `200` を返す
  - `event.id` 冪等化、`event.created` 新旧判定
  - 同秒 `event.created == last_payjp_event_created_at` は `ignored` にせず処理対象とする（順序は単一ワーカーでは到着順になり得るが、複数ワーカーでは非決定）
  - `event.created < last` のみ `ignored`
  - `subscription.updated` は `status` 不変でも `payjp_plan_id` と `next_billing_at/access_end_at` を更新し、ロール同期は実施しない
  - 最小必須項目（`event.id/event.type/event.created/data.id` + 条件付き `data.status`）を検証する
  - `succeeded` イベントで `last_payjp_event_created_at` を更新し、旧 `event.created` は `ignored`
  - 必須項目欠落/不一致は `failed` + `members` 非更新
  - token不一致は `401` + `payjp_events` 未登録 + 構造化ログ4キー（`event/received_at/remote_ip/reason`）記録
  - fail-close入力（検証失敗）は `200`、token不一致のみ `401`、DB受理不能のみ `503` を検証する
  - PAY.JP再送前提（HTTP 200 以外で3分間隔・最大3回）を想定し、検証失敗入力は `200` で終端して再送増幅を防ぐ
  - `subscription.created` は欠落時 `failed`、充足時 `ignored`
  - `data.metadata.operation_id` が存在するイベントは `payjp_events.data_metadata_operation_id` に保存し、未存在時は `NULL` で記録する
  - 不明statusは `failed` 記録 + `members` 非更新 + ロール剥奪
  - raw header/body 非保存、カード情報非保存/非出力、固定キー機密マスク（例: `token/authorization`）を検証
- Refactor:
  - Webhook検証器とイベント適用器を分離
  - `payjp_events.process_status` 記録ロジックを共通化
- モック/注入要件:
  - Webhook payloadフィクスチャ（重複/古い/欠落/不一致/不明status）
  - ログ出力スパイで raw header/body 非保存、固定キー機密マスク、token不一致時の分離ログ4キーを検証
- 受け入れ証跡:
  - 実施日時:
  - コマンドorテストID: `T-P0-07`
  - 結果:
  - `CI実行ID` または `主要ログ参照`:

## 4. Day順の実装順（Week計画整合）

| Day | 実装・試験フォーカス | 対応テストID |
|---|---|---|
| Day2 (2026-04-07) | OAuth start/callback/session + state原子的検証 | `T-P0-01` |
| Day4 (2026-04-09) | subscriptionsコア（3プラン、排他、既存契約ガード） | `T-P0-02`, `T-P0-03` |
| Day5 (2026-04-10) | 3DS必須、`503 + operationId` 注入経路、ログ最小化 | `T-P0-02`, `T-P0-04` |
| Day6 (2026-04-13) | cancel境界・冪等・再加入時trial再適用なし | `T-P0-05`（+ `T-P0-02` の再加入ケース） |
| Day7 (2026-04-14) | Webhook最小処理、fail-close、operationId指定CLI最小 | `T-P0-07` |
| Day8 (2026-04-15) | 日次再同期、全会員CLI、`access_end_at` 剥奪、cancel `503` 復旧 | `T-P0-06`, `T-P0-05`, `T-P0-04` |
| Day9 (2026-04-16) | `12.1` 本実行（7件）と再実行ルール適用 | `T-P0-01` 〜 `T-P0-07` |
| Day10-11 (2026-04-17/18) | 未達是正バッファ、本番最小スモーク再確認 | 失敗項目のみ再実施 |

## 5. 受け入れ証跡テンプレート（全テスト共通）

以下を `docs/evidence/YYYYMMDD-<testid>.md` に保存する。

- 実施日時:
- テストID:
- 実行コマンドまたはCIジョブ:
- 結果（Pass/Fail）:
- `CI実行ID` または `主要ログ参照`:
- 備考（再実行理由がある場合のみ）:
- 運用確認（該当時）: 前日 `process_status=failed` / 課金・解約API `503/5xx` / `resolved_at IS NULL` 件数、`failed_count`、`members.inflight_operation_id` 残留件数
- 当日運用確認（該当時）: `access_end_at` 当日到達ユーザー確認結果（件数/対象）と、ロール除去漏れに対する当日中の手動再同期補正記録
- 運用文書確認（Go-Live前必須）: 「再同期CLI手順」「手動ロール剥奪手順」の最終版リンクまたは改訂ID
- 日次再同期運用ゲート（Go-Live前必須）: `DAILY_RESYNC_CRON` 本番値固定、Day10前（2026-04-17開始前）凍結時刻、直近1回成功ログ参照
- Day9機能凍結前の必須証跡: `503` 復旧オペの運用CLIリハーサル1回（実施日時/結果/参照）
- Day9機能凍結前の必須証跡: 受付期間内cancel事前検証1回（実施日時/対象ユーザー/結果/参照）
- `failed_count > 0` 時の同日中復旧継続の実施記録（再同期再実行時刻、担当者、結果）
- 6時間超確定不能時のエスカレーション記録（解除可否/担当者/実施時刻、該当時のみ）:
- `deep-research-report.md` 未確定事項3件（課金失敗時イベント遅延/Dunning、長時間5xxフェイルセーフ、トークン移管手順）のベンダー回答ソースと採用判断:

## 6. Post-MVP 拡張（CR-005 / CR-006 管理画面）

- **管理画面（運用UI）は MVP の R1–R9 / `T-P0-01`〜`T-P0-07` の対象外**である。Go-Live 判定に新規テストIDは不要。
- 実装時は別Issueで **受け入れテストIDを新設**し、本マトリクスへ追記する。境界・認証・段階導入の正本は `docs/admin-console-boundary.md` と `2weeks-spec.md` の **CR-005 / CR-006** を参照する。
- 追加候補の検証観点は以下とする。
  - `T-ADM-01`: `admin.and--line.com` が Cloudflare Access 未通過では origin に到達できない
  - `T-ADM-02`: 許可対象外ユーザが `admin.and--line.com` にログインできない
  - `T-ADM-03`: Phase A が read-only で、副作用操作を持たない
  - `T-ADM-04`: Phase B の緊急操作で理由入力と監査ログが必須
  - `T-ADM-05`: 緊急操作が `inflight_operation_*` / fail-close ルールを破らない
