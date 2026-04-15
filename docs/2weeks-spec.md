# PAY.JP × Discord 連携サービス 2週間MVP仕様書（OAuth Lite + Multi Plan + Monthly Billing版）

- 作成日: 2026-03-28
- 更新日: 2026-04-12
- 商材: **法人向け SES コミュニティ参加権**（Discord 上の限定コミュニティへのアクセス・ロール付与）。案件紹介・職業斡旋・求人仲介そのものの対価ではない。
- 対象: 日本国内の法人（決済・契約は法人名義を想定）
- 体制: 1名
- リリース目標: 2026-04-20（当初2週間目安: 2026-04-15 から変更）
- 方針: 要件を満たす最小実装（フロント最小、バックエンド最小）
- 本リリースの正本仕様: `2weeks-spec.md`（`spec.md` は参照用であり、2026-04-20 リリース判定の正本ではない）

## 1. 目的

本MVPは、次の3点を最優先で実現する。

1. 課金状態に応じてDiscord有料ロールを自動付与・自動剥奪する。
2. Discord OAuthで正しいユーザーIDを自動取得し、手入力運用を廃止する。
3. 異常時の調査に必要な情報をログへ記録し、手動復旧できる状態を維持する。

特に、最終失効状態（`canceled/paused/deleted`）ではDiscord有料ロールが確実に剥奪されることを必須要件とする。退会申請が成功した時点で `canceled` へ遷移し、Discord有料ロールは即時剥奪する。`members.access_end_at` は最終請求対象期間の終了予定日として保持する。

## 2. スコープ

2週間で実装する範囲は以下に限定する。

1. Discord OAuth（`identify` + `guilds.join`）を実装する（課金完了後の連携でサーバー自動参加に用いる）。
2. PAY.JPで3つの提供プランから1つを選択して定期課金を開始できる。
3. 初回ユーザー（人間単位）は「1か月目課金 + 2か月目/3か月目無料」を適用できる。
4. 4か月目以降は月次課金（毎月）で継続できる。
5. 退会申請はGoogle Form経由で受け付け、フォーム送信後に定期請求停止を即時反映し、Discord有料ロールを即時剥奪する。`subscription.current_period_end`（DBでは `members.access_end_at`）は契約終了予定日として保持する。
6. PAY.JP Webhookを受信し、課金状態をDBへ反映できる。
7. 課金状態に応じてDiscordロールを付与/剥奪できる。
8. 日次1回の再同期および手動再同期CLIで不整合を修復できる（不確定失敗で残留した `inflight_operation_*` の解除は手動再同期CLIでのみ行う）。
9. 最低限の障害調査ができるログを残す（過剰な監査項目は持たない）。

## 3. 非スコープ

MVP（〜2026-04-20）では、以下は実装しない。

1. 認証/会員基盤の拡張（会員ポータル、多端末セッション管理、本人確認/KYC）
2. 運用UI/管理機能（会員ポータル、**write 系**管理操作UI、監視ダッシュボード）。**read-only 管理画面（Phase A）と共有パスコードによる購読ゲートは CR-010/CR-011 によりスコープへ取り込む**（副作用API・一括操作・DLQ 等は従来どおり非スコープ）。
3. 請求/プラン高度化（クーポン、高度な請求管理、プラン変更API、独自grace period）
4. 通知/自動化の追加（課金失敗通知、ロール剥奪通知、Alert自動通知）
5. Webhook/再処理の高度化（PAY.JP `event.id` 再取得照合、DLQ、再生ツール、厳密ドリフト補正）
6. セキュリティ/運用強化の追加（IP許可リスト自動化、秘密鍵ローテーション自動化、WAF、CSP/HSTS強化）
7. 高負荷/障害注入の高度試験（Webhookバースト耐性、Discord/PAY.JP障害注入の定期試験）
8. 受け入れ証跡の自動収集やP0網羅拡張（過剰マトリクス、全件自動収集、追加必須化）

非スコープの将来拡張方針は `15. 将来拡張（リリース後）` を正とする。  
本節に該当する項目は 2026-04-20 まで追加しない。追加が必要な場合は Change Request を作成し、受け入れ条件とスケジュールへ明示反映する。

## 3.1 レビュー方針（MVP 2026-04-20向け）

本仕様書のレビュー目的は「スコープ内MVPの実現可能性評価」に限定する。

1. `Critical/High/Medium` の指摘対象は、スコープ内項目の実装・テスト・運用成立性のみとする。
2. 既存の非スコープ項目に対する改善提案・詳細化要求・網羅性指摘は行わない。
3. 例外として、スコープ内項目を非スコープへ移管する提案は許可する。
4. 上記例外は `Scope-Transfer Note` として記録し、Pass/Fail 判定の根拠には使わない。
5. 最終判定（Pass/Fail）は、2026-04-20 までの必須項目が実装可能かどうかのみで決定する。

## 3.2 `deep-research-report.md` 反映の固定事項（2026-03-28版）

本仕様は正本 `deep-research-report.md` の結論を前提に固定する（`deepresearch.md` は互換名としてのみ扱う）。

1. 決済基盤の採用方針は PAY.JP を第一候補、Stripe を代替候補とし、会費ペイは条件付き採用、メンバーペイ/Patreon はMVP対象外とする。
2. 実装原則は `Webhook中心` / `署名検証` / `冪等性` / `自動再試行` / `Discord APIレート制限の自己修復` の5点を必須とする。
3. 課金停止状態の安全側判定を固定し、`paused` / `deleted` / 不明ステータスは即時剥奪対象とする。
4. PAY.JP Webhookの再送前提（HTTP 200 以外で3分間隔・最大3回）を受信設計と運用設計の前提にする。
5. Go-Live前に、以下のベンダー確認を完了して証跡化する。
- 課金失敗時イベント（`charge.failed` / `subscription.updated` 等）の発火タイムラグとDunningスケジュール
- 長時間5xx時のWebhookエンドポイント無効化などフェイルセーフ仕様
- トークン移管手順（リードタイム/費用含む）
- 上記3件は実装着手のブロッカーにはしない（実装は先行可）。ただし Day3（2026-04-08）終了までに一次回答を収集し、Day10（2026-04-17）開始前までに採用判断を固定する。

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
- 退会申請API（Google Form受付 + 即時退会完了）
- Discord REST API連携（Botトークン利用）
- 日次再同期ジョブ + 手動再同期CLI

3. データストア
- PostgreSQL（最小5テーブル: `members`, `payjp_events`, `oauth_states`, `discord_link_sessions`, `member_impact_logs`）

## 5. ユーザーフロー（MVP）

本MVPにおけるユーザー価値の中心は **購読（定期課金）の開始と維持** である。**課金（PAY.JP 書き込み）はメール起点で開始し、Discord への OAuth・サーバー参加・ロール付与は、課金成功後の導線で行う**（支払後招待型）。旧来の俗称「Discord-first」（課金API前に Discord を前提とする順序）は **本リリースでは採用しない**。

1. ユーザーが `/` でプラン・法人担当者メール・カード名義・カード情報を入力し、`PAY.JP.js` で 3DS 完了済み `payjpToken` を得る。
2. フロントは `{ planId, email, payjpToken, privacyConsented }` を `POST /v1/subscriptions` へ送信する（**`__Host-link_session` は不要**）。
3. バックエンドはメールで仮 `members` 行を確定し、PAY.JP で購読を作成する（課金前に Discord 参加や `link_session` を要求しない）。
4. 初回ユーザーは「1か月目課金 + 2か月目/3か月目無料（trial）」を付与する。成功時に `__Host-member_session` を発行する。
5. ユーザーはサンクス画面から `GET /v1/auth/discord/start` により OAuth（`identify` + `guilds.join`）を行い、`POST /v1/members/link-discord` で `guilds.join` による自動参加とプランに応じたロール付与を受ける（詳細は server の member ルート）。
6. 退会申請ユーザーは、購読状況画面の「退会する」から署名付きトークン付きGoogle Formへ遷移し、名前・メールアドレス・退会理由を送信する。
7. Google Apps Script はフォーム送信を受けてアプリの専用退会APIを呼び、定期請求停止を即時反映し、Discord有料ロールを即時剥奪する。`current_period_end`（`members.access_end_at`）は契約終了予定日として保持する。
8. 以後はWebhookイベントと日次再同期で状態を維持する。

**料金（税抜・月額・代表）**: スターター **20,000円（税抜）** / ビジネス **50,000円（税抜）** / エンタープライズ **70,000円（税抜）**（決済時は消費税等を加算した税込請求。`PAYJP_PLAN_IDS` および公開ページと一致させる）。

## 6. 機能仕様

## 6.1 フロントエンド（1ページ）

1. ページ: `/`

2. 入力項目
- `planId`（選択式: 3プラン）
- `email`
- `cardholderName`（カード名義。3Dセキュア必須項目）
- カード入力（PAY.JP提供UI）

3. 動作
- 連携完了確認: `GET /v1/auth/discord/session`（`linked` のみ参照）
- 3Dセキュア方式は `PAY.JP.js` のiframe方式に固定する（redirect方式はMVP非対応）
- 「登録する」押下で `payjpToken` を生成
- `PAY.JP.js` の `createToken` で `three_d_secure: true` を必須にし、`card.name`（カード名義）と `card.email`（または `card.phone`）を必須で渡す
- 3Dセキュア認証が完了し、`card.three_d_secure_status = verified` のトークンを取得できた場合のみ `POST /v1/subscriptions` を実行する
- 3Dセキュア判定はMVPの完全認証方針として `verified` のみ許容し、`attempted` は受け付けない
- 3Dセキュアが中断/失敗/タイムアウトした場合は `POST /v1/subscriptions` を呼ばない
- 3Dセキュア中断/失敗/タイムアウト時は、画面に失敗理由を表示し、再試行導線を提示する
- `planId` は3プランの許可リストから選択し、`email` とあわせて `POST /v1/subscriptions` に含める
- 退会申請は、購読状況画面から `POST /v1/subscriptions/cancel/google-form-link` を呼び、返却されたGoogle Form URLへ遷移する
- Google Formの事前入力URLにはメールアドレスと署名付きワンタイムトークンを埋め込み、名前と退会理由はフォーム上でユーザーが入力する
- `GET /v1/auth/discord/session` / `POST /v1/subscriptions` / `POST /v1/subscriptions/cancel/google-form-link` は資格情報付きで呼び出す（Cookie送信必須）
- `POST /v1/subscriptions` が `503` の場合は `operationId` を表示し、クライアント自動再試行を行わず運用再同期へ誘導する
- `POST /v1/subscriptions` / `POST /v1/subscriptions/cancel` が `401` の場合は、再OAuth開始導線を必ず表示する

4. 注意事項
- カード情報はフロントから直接PAY.JPへ送信する。
- フロントで秘密鍵を保持しない。
- 3Dセキュア実施に伴いカード名義・メール/電話等の個人情報を取り扱うため、画面上で同意を取得する（同意なしは `createToken` を開始しない）。
- OAuth/連携セッションはHttpOnly Cookieで扱い、フロントJSから読ませない。
- 課金APIは `Origin` を必須検証し、`Origin` 欠落時も拒否する。
- Cookieベース連携を成立させるため、フロントとAPIは同一サイト（同一eTLD+1）で配置する。

## 6.2 バックエンドAPI

- 共通: Cookie連携が必要なAPI（`GET /v1/auth/discord/session`, `POST /v1/subscriptions`, `POST /v1/subscriptions/cancel/google-form-link`, `POST /v1/subscriptions/cancel`）は資格情報付きリクエストを許可し、許可Originは `FRONTEND_BASE_URL` のみに固定する。
- 共通: 成功レスポンスの日時項目（`accessEndAt`, `cancelEffectiveAt`, `roleRemovalAt`）は RFC 3339 UTC 文字列（例: `2026-04-03T12:34:56Z`）で返し、Unix秒やJST文字列は返さない。

1. `GET /health`
- 200を返す

2. `GET /v1/auth/discord/start`
- 目的: Discord OAuth開始
- 処理:
  - ランダム `state` を生成
  - `__Host-oauth_session` Cookie を発行する（`Secure; Path=/; Domainなし; HttpOnly; SameSite=Lax; Max-Age=10m`）
  - `oauth_states` に `state_hash` と `oauth_session_hash` を保存する（TTL 10分）
  - Discord認可URLの `scope` は `identify guilds.join` とする（課金後の自動参加に必要）
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
- 出力: `{ linked: boolean }`
- ヘッダ: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`

5. `POST /v1/subscriptions`
- 目的: 初回購読作成
- 入力: `{ planId, email, payjpToken, privacyConsented }`（`__Host-link_session` は不要）
- 処理:
  - `Origin == FRONTEND_BASE_URL` を必須検証する（比較は `scheme+host+port` 正規化で実施し、`FRONTEND_BASE_URL` はオリジン形式のみ許可。不一致/欠落/`Origin: null` は `403`）
  - `planId` が `PAYJP_PLAN_IDS` の許可リスト内であることを検証
  - `email` 正規化（小文字）後に `members` を `upsertProvisionalMemberByEmail` により確定する（この時点で `discord_user_id` は未設定でもよい）
  - ユーザー単位の排他制御として `pg_try_advisory_lock(hashtext('member:' || members.id))` 相当のキーでロックを取得する
  - `members.inflight_operation_id` が存在する場合は既存契約有無に関わらず新規課金処理を開始せず `503` を返す（既存 `operationId` を返却。解除はPAY.JP状態確認後の再同期CLIのみ）
  - ロック後に `members` を参照し、既存 `active/trial`、または `canceled` かつ `access_end_at > now()` の契約がある場合は新規作成せず既存結果を返す（成功時は `__Host-member_session` 発行可）
  - **課金前の Discord ギルド参加検証・ロール付与可能性検証は行わない**（支払完了後の `POST /v1/members/link-discord` で処理）
  - `payjpToken` をPAY.JP APIで再取得し、`used=false` かつ `card.three_d_secure_status = verified` を検証する（MVPの完全認証方針として `attempted` / `failed` / `error` / `unverified` / `null` は422）
  - PAY.JP API呼び出しは公式SDKまたは `application/x-www-form-urlencoded` で実行する（JSON POSTしない）
  - 初回無料判定は **`members` 行の `first_trial_granted_at`** で行う。`IS NULL` の場合のみ初回ユーザーとして扱う（メール単位の仮行に紐づく）
  - PAY.JP書き込み（customer/charge/subscription）開始前に `operationId` を生成し、`members.inflight_operation_id` / `members.inflight_operation_type=subscribe` / `members.inflight_operation_started_at` を保存する
  - PAY.JPでcustomer作成（既存あれば再利用）
  - customer作成/再利用の確定時点で `members.payjp_customer_id` を即時保存する
  - 初回ユーザーは「入会時に選択プランの1か月分を `charge` で即時課金」してから、月次subscriptionを `trial_end = now + 3か月` で作成する（2か月目/3か月目無料）
  - 初回ユーザーの `charge` / `subscription` の `metadata` には **`member_id` と `operation_id` を必須**とし、**`discord_user_id` は OAuth 連携済みの場合のみ**付与する（未連携時は省略可）
  - 初回ユーザーの `charge` 成功時点で `charge.id` を `members.payjp_initial_charge_id` に即時保存し、`members.initial_charge_paid_at` も更新する
  - 非初回ユーザーは月次subscriptionを通常作成する（`trial_end` なし）
  - subscription作成成功時点で `subscription.id` を `members.payjp_subscription_id` に即時保存する
  - `subscription.current_period_end` を trial適用有無に関係なく `members.next_billing_at` と `members.access_end_at` に保存する
  - 初回無料を適用した場合は `members.first_trial_granted_at` を保存する（一度保存したら解除しない）
  - Discord ロール付与は **`discord_user_id` 確定後**（link-discord または Webhook/再同期経路）に行う。購読作成直後は未連携の場合がある
  - 成功時は `members.inflight_operation_*` をクリアし、成功レスポンスとあわせ **`__Host-member_session`**（24h 想定）を発行する
- 失敗時ポリシー:
  - customer/subscription/charge 作成系APIは自動再試行しない（重複作成リスク回避）
- タイムアウト等の不確定失敗時は `503` を返す（`operationId` を返却し、`members.inflight_operation_*` は保持する。クライアント自動再試行は禁止し、再試行は運用CLIのみとする）
  - PAY.JP書き込み前の確定失敗（バリデーション/事前検証失敗）では `members.inflight_operation_*` をクリアして失敗を返す
  - PAY.JP書き込み開始後の確定失敗はPAY.JP現状態を再取得し、`members` 反映と整合確認できた場合のみ `members.inflight_operation_*` をクリアする。整合不能時は `503`（`operationId` 返却）で保持する
  - `operationId` 必須記録はPAY.JP書き込み実行時および不確定失敗時に適用し、API応答ログ・失敗ログに記録する
- 出力: `{ ok: true, memberId: string(uuid), subscriptionStatus: "active"|"trial"|"canceled"|"paused"|"deleted", planId: string, trialApplied: boolean, accessEndAt: string(RFC3339 UTC) }`

6. `POST /v1/subscriptions/cancel/google-form-link`
- 目的: Google Form退会受付URLの生成
- 入力: `{}`
- 処理:
  - `Origin == FRONTEND_BASE_URL` を必須検証する（比較は `scheme+host+port` 正規化で実施し、`FRONTEND_BASE_URL` はオリジン形式のみ許可。不一致/欠落/`Origin: null` は `403`）
  - `__Host-member_session` Cookie を検証し、失効/不正は `401` で拒否する
  - 対象会員が `active/trial` の有効購読中であることを確認する
  - Google Form用の署名付きワンタイムトークンを生成し、DBにTTL付きで保存する
  - `entry.<email>` と `entry.<token>` を含むGoogle Form事前入力URLを返す
- 出力: `{ ok: true, formUrl: string, expiresAt: string(RFC3339 UTC) }`

7. `POST /v1/subscriptions/cancel/google-submit`
- 目的: Google Form送信後の即時退会実行
- 入力: `{ name, email, reason, token }`
- 処理:
  - `X-Cancel-Secret` を検証し、不一致は `401` で拒否する（移行期間は旧 `X-Google-Cancel-Secret` もフォールバックで受け付ける）
  - 署名付きワンタイムトークンを検証し、失効/不正/消費済みは `401` で拒否する
  - トークンの会員情報とフォーム送信メールアドレスが一致することを検証する
  - ユーザー単位の排他制御として `pg_advisory_lock(member_id)` 相当のロックを取得する
  - `members` を取得し、`active/trial/canceled` の既存購読が無ければ409
  - `members.inflight_operation_id` が存在する場合は新規キャンセル処理を開始せず `503` を返す（既存 `operationId` を返却）
  - `members.payjp_subscription_id` が未設定の場合は `409` を返し、再同期CLIで状態補正後に再実行する
  - `members.cancel_requested_at` が既存の場合はPAY.JP cancel APIを再実行せず、Discordロールが未剥奪なら即時剥奪を再試行したうえで冪等 `200` を返す
  - PAY.JP書き込み（cancel API）開始前に `operationId` を生成し、`members.inflight_operation_id` / `members.inflight_operation_type=cancel` / `members.inflight_operation_started_at` を保存する
  - PAY.JP subscriptionキャンセルAPIを `members.payjp_subscription_id` 指定で呼び、次回請求を停止する（即時削除はしない）
  - `members.cancel_requested_at` を記録し、`members.subscription_status = canceled`, `members.access_end_at = subscription.current_period_end`（契約終了予定日）, `members.next_billing_at = subscription.current_period_end` を更新する
  - Discordロールは退会成功時に即時剥奪し、成功時は `role_state = revoked` とする。Discord API失敗時は `503` を返し、`role_state = unknown` を残して再試行または再同期で補正する
  - 処理成功時にGoogle Formトークンを消費済みに更新する
- 失敗時ポリシー:
  - subscriptionキャンセルAPIは自動再試行しない
  - タイムアウト等の不確定失敗時は `503` を返す（`operationId` を返却し、`members.inflight_operation_*` は保持する。Google側の自動再送は許可するが、PAY.JP書き込みの自動再試行はアプリ側で行わない）
  - トークン消費やDB確定が失敗した場合は `503` を返し、必要に応じて日次再同期で整合を取る
- 出力: `{ ok: true, memberId: string(uuid), cancelEffectiveAt: string(RFC3339 UTC), roleRemovalAt: string(RFC3339 UTC) }`

8. `POST /v1/subscriptions/cancel`
- 目的: 既存ブラウザ向け退会API（Google Form連携と同じ即時退会ロジック）
- 入力: `{}`
- 処理:
  - `Origin == FRONTEND_BASE_URL` を必須検証する（比較は `scheme+host+port` 正規化で実施し、`FRONTEND_BASE_URL` はオリジン形式のみ許可。不一致/欠落/`Origin: null` は `403`）
  - `__Host-link_session` Cookie を検証し、失効/不正/消費済みは `401` で拒否して再OAuthを要求する
  - Google Form送信後の退会と同じ即時退会オーケストレーションを実行する
- 失敗時ポリシー:
  - subscriptionキャンセルAPIは自動再試行しない
- タイムアウト等の不確定失敗時は `503` を返す（`operationId` を返却し、`members.inflight_operation_*` は保持する。クライアント自動再試行は禁止し、再試行は運用CLIのみとする）
  - PAY.JP書き込み開始後の確定失敗はPAY.JP現状態を再取得し、`members` 反映と整合確認できた場合のみ `members.inflight_operation_*` をクリアする。整合不能時は `503`（`operationId` 返却）で保持する
  - 退会処理のDB確定や後続ステップが失敗した場合は `503` を返し、必要に応じて日次再同期で整合を取る
  - `operationId` 必須記録はPAY.JP書き込み実行時および不確定失敗時に適用し、API応答ログ・失敗ログに記録する
- 出力: `{ ok: true, memberId: string(uuid), cancelEffectiveAt: string(RFC3339 UTC), roleRemovalAt: string(RFC3339 UTC) }`

9. `POST /v1/payjp/webhook`
- 目的: 課金状態更新
- ヘッダ検証: `X-Payjp-Webhook-Token`
- 処理:
  - `X-Payjp-Webhook-Token` 不一致は `401` を返し、`payjp_events` とは分離した構造化アプリログ（必須キー: `event`, `received_at`, `remote_ip`, `reason`）に記録する（`payjp_event_id` 一意領域に入れない）
  - `livemode` が `PAYJP_LIVEMODE` と一致することを検証（不一致は `ignored` 記録して200）
  - `event.type` は `subscription.created/updated/renewed/canceled/deleted/paused/resumed` の許可リストのみ処理し、それ以外は `ignored` 記録して200で受理する
  - `data.object` は `subscription` を必須とし、不一致は `ignored` 記録して200で受理する
  - 必須項目は `event.id` / `event.type` / `event.created` / `data.id` を最小必須とする。`members.subscription_status` を反映するイベント（`created`/`deleted` 以外）は `data.status` も必須とする
  - `subscription.created` は必須項目充足時のみ `ignored` として記録し、必須項目欠落時は `failed` として記録する（`members` は更新しない）
  - `data.metadata.discord_user_id` と `data.id` 逆引きで解決した `discord_user_id` が両方得られる場合は一致必須とし、不一致時は `failed` 記録で `members` 非更新（fail-close）
  - 上記必須項目が欠落/不正な場合、`members` 更新は行わず `failed` 記録して200を返す
  - `event.id` / `event.type` / `event.created` / `livemode` / `data.id` / `data.object` / `data.status` / `data.plan.id` / `data.current_period_end` / `data.metadata.discord_user_id` / `data.metadata.operation_id` を `payjp_events` に保存する（`payjp_event_id` unique はトークン検証通過イベントのみに適用）
  - 重複なら何もしないで200
  - 新規イベント（`subscription.created` を除く）は `succeeded/failed/ignored` のいずれも `payjp_events` と `process_status` を記録し、`members` 更新は検証通過した `succeeded` のみ同一トランザクションで実行する
  - Discordロール同期結果は `process_status` に反映せず、会員影響ログ（`member_impact_logs`）へ記録して日次再同期で補正する
- 応答:
  - トークン不一致は `401`
  - 恒久的に処理しない入力（`livemode` 不一致 / 許可外 `event.type` / `data.object` 不一致）は `200` を返し `ignored` として記録する
  - 必須項目欠落・型不正の処理不能入力は `200` を返し `failed` として記録する（`members` は更新しない）
  - 重複時は `200`
  - 新規イベント処理完了時は `200`
  - DB障害で受理不能時のみ `503`（PAY.JPリトライを許可）

## 6.3 Webhookイベント処理方針（MVP簡易版）

対象イベントは最小限に限定する。

1. `subscription.created`（必須項目充足時は `ignored`）
2. `subscription.updated`
3. `subscription.renewed`
4. `subscription.canceled`
5. `subscription.deleted`
6. `subscription.paused`
7. `subscription.resumed`

補足:
- `event.type` と `subscription.status` の定義はPAY.JP公式ドキュメント（Webhook/定期課金）を正とする。

共通処理:

1. 受信時に `X-Payjp-Webhook-Token` / `livemode` / `event.type` 許可リスト / `data.object=subscription` を検証する。
2. トークン不一致は `401` を返し、`payjp_events` と分離した構造化アプリログ（必須キー: `event`, `received_at`, `remote_ip`, `reason`）へ記録する。
3. 必須項目は `event.id,event.type,event.created,data.id` を最小必須とし、`members.subscription_status` を反映するイベント（`created/deleted` 以外）は `data.status` も必須とする。
4. `event.id` を `payjp_events` へ保存して冪等化する（`payjp_event_id` unique はトークン検証通過イベントのみに適用）。
5. 重複 `event.id` は二重処理せず `200` を返す。
6. `subscription.created` は必須項目欠落時は `failed`、充足時は `ignored` を記録して終了する（`members` は更新しない）。
7. 新規イベント（`created` 以外）は payload の `data` をsubscription本体として扱い、`status/plan/metadata.discord_user_id/current_period_end` を読む。
8. `discord_user_id` はまず `data.metadata.discord_user_id` から取得する。欠落時は対象イベント（`subscription.updated/renewed/canceled/paused/resumed/deleted`）で `data.id`（subscription id）から `members.payjp_subscription_id` を逆引きし、解決できない場合は `failed` として記録する。
9. `data.metadata.discord_user_id` と `data.id` 逆引きが両方解決できる場合は一致必須とし、不一致時は `failed` として記録する（`members` 非更新）。
10. `event.created`（Unix秒）が欠落/不正なイベントは `failed` として記録する。
11. `event.created < members.last_payjp_event_created_at` の場合は順不同到着の古いイベントとして `ignored` にする（状態を巻き戻さない）。`event.created == members.last_payjp_event_created_at`（同秒）の場合は `ignored` にせず処理対象とする。適用順序は単一ワーカーでは到着順になり得るが、複数ワーカーではDBコミット順となり得るため非決定である。最終整合は日次再同期で補正する。
12. `subscription.deleted` は `event.type` で判断し、`data.status` によらず `members.subscription_status = deleted` として扱う。その他イベントは `data.status`（`active/trial/canceled/paused`）を `members.subscription_status` に反映する。`data.status` が上記以外（不明ステータス）の場合は `failed` として記録し、`members` は更新せず、安全側でDiscordロール剥奪を実行する。
13. `data.plan.id` が取得できた場合のみ `members.payjp_plan_id` を更新する。
14. `data.current_period_end` は取得できた場合のみ `members.next_billing_at` に保存する。`status=active/trial` の間は同値を `members.access_end_at` にも保存する。`status=canceled` の場合も取得できた場合は同値を `members.access_end_at` に保存する（退会後の利用終了日時の正とする）。
15. `succeeded` として処理したイベントは `status` 不変でも `members.last_payjp_event_created_at = event.created` を更新する（`failed/ignored` は更新しない）。
16. `status` 不変の `subscription.updated` でも `payjp_plan_id` と `next_billing_at/access_end_at` の更新は行う。ロール同期は実施しない。
17. `subscription_status` が変化したイベントのみDiscordロール同期を実行する（ただし `12.` の不明ステータス失敗ケースは例外的に剥奪を実行する）。`active/trial` は付与し、`canceled/paused/deleted` は即時剥奪する。
18. Discord API `429/5xx` は短時間の同期リトライを最大3回（0秒/1秒/2秒待機、各回タイムアウト1秒、総処理6秒以内）行い、最終失敗時は会員影響ログへ記録して日次再同期対象とする。
19. 必須項目欠落や検証失敗時は fail-close（`members` 非更新）とし、`failed` を記録する（DB障害以外は `200`）。

注記:

1. Webhook受信ごとの PAY.JP `event.id` 再取得照合はMVPでは実施しない（リリース後拡張）。
2. 分単位以上の待機を伴う再試行はWebhook内で実施しない（PAY.JP再送と二重処理リスクを避ける）。
3. PAY.JP側の再送仕様（HTTP 200 以外で3分間隔・最大3回）を前提に、受信側は検証失敗入力を `200` で終端し再送増幅を避ける。

## 6.4 Discordロール同期ルール

1. `active` / `trial` のとき付与する。
2. `canceled` / `paused` / `deleted` / 不明ステータスは剥奪する。`members.access_end_at` は契約終了予定日の表示・運用確認に使い、Discordロール維持条件には使わない。
3. Webhook欠落やDiscord API失敗で剥奪に失敗した場合は、次回日次再同期で補正する。
4. APIエラー時は短時間の同期リトライを最大3回実行する。長時間待機は行わず、失敗時は再同期へ回す。
5. `payjp_plan_id` はロール判定に使わない（3プランでもロールは共通）。

## 6.5 解約時ポリシー（MVP）

1. 退会申請時はGoogle Formを受付窓口とし、Google Apps Scriptからアプリ専用APIを呼んで処理する。
2. 退会申請時はPAY.JP subscriptionキャンセルAPIで定期請求を停止する（即時削除はしない）。
3. 退会申請後は `members.subscription_status = canceled`, `members.cancel_requested_at` を記録し、`members.access_end_at = current_period_end`（契約終了予定日）, `members.next_billing_at = current_period_end` とする。
4. Discordロールは退会成功時に即時剥奪する。Discord API失敗時は `503` と `role_state=unknown` を残し、再試行または日次再同期で補正する。
5. Google Form送信とアプリAPI呼び出しの間では、署名付きワンタイムトークンと共有シークレットで本人性と送信元を検証する。

## 6.6 プラン判定ポリシー

1. 本MVPは3プラン（`PAYJP_PLAN_IDS`）を受け付ける。
2. すべてのプランは月次課金（毎月）で運用する。
3. 初回ユーザーのみ「1か月目課金 + 2か月目/3か月目無料」を適用する。
4. 初回無料終了後（4か月目以降）は毎月課金する。
5. Discordロール判定は `subscription.status` で決定する（プラン差分なし）。`active/trial` は付与し、`canceled/paused/deleted` は剥奪する。`members.access_end_at` は契約終了予定日の表示・運用確認にのみ利用する。
6. `payjp_plan_id` は課金プラン識別・監査用途にのみ利用する。
7. 同一ユーザーの同時有効契約は不可（`active/trial` を同時に複数持たせない）。

## 6.7 初回無料判定ポリシー

1. 初回ユーザー判定はクレジットカード情報ではなく「人間単位」で行う。
2. 人間単位の識別子は `discord_user_id` を採用する。
3. `members.first_trial_granted_at IS NULL` の場合のみ初回無料を適用する。
4. 初回無料の内容は「1か月目課金 + 2か月目/3か月目無料」とする。
5. 適用時に `first_trial_granted_at` を保存する。
6. 退会後に再加入しても `first_trial_granted_at` はリセットしない（初回無料の再付与なし）。

## 7. データモデル（最小）

## 7.1 `members`

- `id` (uuid, pk)
- `discord_user_id` (text, unique)
- `email` (text)
- `payjp_customer_id` (text, null許可, NOT NULL時のみunique)
- `payjp_subscription_id` (text, null許可, NOT NULL時のみunique)
- `payjp_initial_charge_id` (text, null許可, NOT NULL時のみunique)
- `payjp_plan_id` (text)
- `subscription_status` (text: active/trial/canceled/paused/deleted, null許可)
- `first_trial_granted_at` (timestamptz, null)
- `initial_charge_paid_at` (timestamptz, null)
- `cancel_requested_at` (timestamptz, null)
- `inflight_operation_id` (text, null)
- `inflight_operation_type` (text: subscribe/cancel, null)
- `inflight_operation_started_at` (timestamptz, null)
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
- `data_metadata_operation_id` (text, null許可)
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

## 7.5 `member_impact_logs`

- `id` (uuid, pk)
- `member_id` (uuid, fk members.id)
- `operation_id` (text, null)
- `issue_code` (text)
- `resolved_at` (timestamptz, null)
- `created_at` (timestamptz)

## 8. セキュリティ要件（MVP必須）

詳細実装は `6.2` / `6.3` を正とし、ここではP0のみを固定する。

1. OAuth callbackで `state + __Host-oauth_session + 未使用 + TTL内` を1トランザクションで検証/消費する。
2. OAuth連携Cookieは `__Host-oauth_session`、課金連携Cookieは `__Host-link_session` を使用し、後者はTTL 15分のワンタイムとする。
3. `__Host-link_session` は認証前提検証通過後かつPAY.JP書き込み前に消費し、成功/失敗に関わらず再利用不可とする。
4. OAuth/linkトークンはURLに載せない（Cookieのみ）。
5. `POST /v1/subscriptions` / `POST /v1/subscriptions/cancel/google-form-link` / `POST /v1/subscriptions/cancel` は `Origin == FRONTEND_BASE_URL` を必須化する（比較は `scheme+host+port` 正規化で実施し、`FRONTEND_BASE_URL` はオリジン形式のみ許可）。欠落/不一致/`Origin: null` は `403` で拒否する。
6. Cookieベース連携を成立させるため、本番はフロントとAPIを同一サイト（同一eTLD+1）に配置する。
7. `POST /v1/subscriptions` の課金実行前にDiscord参加状態とBotのロール付与可能性を検証し、不成立時は課金しない。
8. `createToken` の `three_d_secure: true` を必須化し、本番の購読作成は3Dセキュア `verified` トークンのみ受け付ける。
9. customer/subscription/charge/cancel のPAY.JP書き込みAPIは自動再試行しない。
10. 不確定失敗（タイムアウト等）は `503 + operationId` を返し、クライアント自動再試行は禁止する。
11. 不確定失敗に備え、PAY.JP書き込み前に `members.inflight_operation_id/type/started_at` を保存し、成功時のみクリアする。
12. `members.inflight_operation_id` が残っている間は課金/解約APIを再実行せず `503` とし、不確定失敗で残留した `inflight_operation_*` の解除は手動再同期CLIのみで行う（日次再同期ジョブでは解除しない）。
13. 購読作成・退会申請APIでは `pg_advisory_lock(discord_user_id::bigint)` によるユーザー単位排他を取得する。
14. Webhookはトークン検証を必須化し、不一致は `401` を返して `payjp_events` と分離した構造化アプリログ（必須キー: `event`, `received_at`, `remote_ip`, `reason`）へ記録する。
15. Webhookは `livemode` / `event.type` 許可リスト / `data.object=subscription` を検証する。
16. Webhookの最小必須項目は `event.id,event.type,event.created,data.id` とし、状態反映イベントは `data.status` も必須とする。欠落・不正入力は fail-close（`members` 非更新）で `failed` 記録とする。
17. `subscription.created` は必須項目欠落時のみ `failed`、充足時は `ignored` とする。
18. `event.id` の冪等化（トークン検証通過イベントのみ）と `event.created` 新旧判定を実施し、古いイベントで会員状態を巻き戻さない。
19. `data.metadata.discord_user_id` と `data.id` 逆引きが両方解決できる場合は一致必須とし、不一致時は `failed` とする。
20. カード情報を保存・ログ出力しない。機密値は固定キーでマスクし、`/v1/payjp/webhook` と認証/課金APIで raw header/body をログ保存しない。
21. `callback` / `session` 応答は `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を必須とする。
22. `planId` は `PAYJP_PLAN_IDS` の許可リスト照合を必須化し、購読作成APIで不正値を拒否する。
23. 初回無料適用は `discord_user_id` 単位で一度のみ許可し、`first_trial_granted_at` を保存する。
24. OAuth認可URLの `scope` は `identify` 固定とする（OAuth Lite）。
25. OAuth `state` の生成・保管・検証は Discord OAuth2 の `State and Security` 推奨に準拠する。

## 9. 環境変数

`4-6` は将来拡張との互換のために定義するが、MVPでは固定値以外を許可しない（起動時に不一致ならエラー終了）。

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
11. `DISCORD_PLAN_ROLE_IDS`（`PAYJP_PLAN_IDS` と同じ順序・要素数のカンマ区切り。Go-Live 後の複数プラン対応で単一値 `DISCORD_PAID_ROLE_ID` から複数形へ変更済）
12. `DISCORD_CLIENT_ID`
13. `DISCORD_CLIENT_SECRET`
14. `DISCORD_REDIRECT_URI`
15. `FRONTEND_BASE_URL`
16. `OAUTH_COOKIE_SECRET`
17. `DATABASE_URL`
18. `DAILY_RESYNC_CRON`（CRON式。JST基準で評価）

`FRONTEND_BASE_URL` はオリジン形式（`scheme://host[:port]`）のみを許可し、pathや末尾スラッシュは含めない。

## 10. バッチ/ジョブ

1. 日次再同期ジョブ
- 日次1回（JST）で実行する（`DAILY_RESYNC_CRON` を運用設定で固定し、Day10前に凍結する。仕様上の固定時刻は持たない）
- 全会員を対象にPAY.JP状態とDiscordロールを再照合
- PAY.JPのsubscription取得で `404` を返した会員は `deleted` とみなしてロール剥奪対象にする
- `access_end_at` 超過（`trial` の終了到達）会員はロール剥奪対象として再同期する
- 障害対応として同じ再同期処理を運用CLIから手動実行可能にする（公開HTTP endpointは設けない）
- 手動再同期CLIは `operationId` または `discord_user_id` 指定に加えて、全会員対象でも再同期できる
- 手動再同期CLIの引数は相互排他で `--operation-id <operationId>` / `--discord-user-id <discord_user_id>` / `--all` のいずれか1つのみ受け付ける
- 手動再同期CLIの標準出力は1行JSON固定とし、`mode`, `target`, `processed_count`, `succeeded_count`, `failed_count`, `started_at`, `finished_at`, `duration_ms` を必須キーとする（`started_at` / `finished_at` は RFC 3339 UTC）
- 手動再同期CLIの終了コードは `0=完了かつ failed_count=0`, `2=実行完了だが failed_count>0（fail-close残を含む）`, `1=CLI実行エラー（入力不正/依存障害）` に固定する
- 手動再同期CLIで `inflight_operation_*` が残留している場合は「`operationId` 突合 -> PAY.JP現状態確認 -> `members` 反映 -> Discordロール再同期 -> `last_payjp_event_created_at = max(既存値, 再同期開始Unix秒)` 更新」を1実行で行う（この反映後に到着した `event.created` がそれ未満の遅延Webhookは `ignored` としてよい）
- 手動再同期CLIの `subscribe` 不確定失敗（`charge` 後 `subscription` 不確定）は、`operationId` から対象会員を特定し `members.payjp_customer_id` でPAY.JP現状態を確認する（`members.payjp_customer_id IS NULL` の場合は即 fail-close とし、charge/subscription の再実行は禁止、`member_impact_logs` を記録し、`inflight_operation_*` は解除せずエスカレーションする）。初回 `charge` の既存判定は優先順位を固定し、(1) `members.payjp_initial_charge_id` が存在する場合はそれを正とする、(2) 無い場合は `GET /v1/charges?customer=<payjp_customer_id>&since=<inflight_operation_started_at_unix-3600>&until=<inflight_operation_started_at_unix+604800>&limit=100&offset=<0|100|...>` を `has_more=false` までページングして全件走査し、走査結果の `metadata.operation_id == operationId` のchargeを既存課金として採用し `members.payjp_initial_charge_id` を補正保存する（charge再実行禁止。ページング上限は `offset<=900`（最大1000件）とし、上限到達時に `has_more=true` の場合は一致件数に関わらず確定不能として fail-close で停止し、charge再実行は禁止・`inflight_operation_*` 解除禁止）、(3) `has_more=false` まで走査した結果として一致0件の場合のみchargeを1回実行、(4) 一致2件以上は確定不能としてfail-closeで停止し `inflight_operation_*` を解除しない（`since`/`until` はPAY.JP仕様に合わせてUNIX秒（UTC）で渡す）
- 手動再同期CLIの `cancel` 不確定失敗および `payjp_subscription_id` 欠落は、`members.payjp_customer_id` を前提に `GET /v1/customers/:id/subscriptions` を `limit=100`・`offset=0,100,200,...` で `has_more=false` までページングして候補を取得し、`status in (active,trial,canceled,paused)` かつ `metadata.discord_user_id == members.discord_user_id` の候補を評価する（`members.payjp_customer_id IS NULL` の場合は即 fail-close とし、cancel API 実行は禁止、`member_impact_logs` を記録し、`inflight_operation_*` は解除せずエスカレーションする）。ページング上限は `offset<=900`（最大1000件）とし、`offset=900` 到達時点で `has_more=true` の場合は一致件数に関わらず確定不能として fail-close で停止する（cancel API 実行禁止、`member_impact_logs` 記録、`inflight_operation_*` 解除禁止）。`metadata.discord_user_id` 欠落時は、同じ `status` 条件の候補が1件のみであることに加え、`access_end_at_unix = floor(extract(epoch from members.access_end_at))`（UTC・整数秒）を用いて `subscription.current_period_end == access_end_at_unix` の完全一致の場合に限りその1件を採用する。1件なら `members.payjp_subscription_id` を補正保存のうえ未cancel時のみcancel APIを1回実行し、0件または複数件（または `members.access_end_at` が `NULL` / 時刻整合不一致）は確定不能としてfail-closeで停止する（`member_impact_logs` 記録、`inflight_operation_*` 解除禁止）。通信エラーやJSON欠落で全件走査を完了できない場合も確定不能として fail-close で停止する
- 手動再同期CLIで `inflight_operation_*` はPAY.JP現状態と `members` 整合が確認できた場合のみ解除する。PAY.JP状態が確定不能な場合は解除しない
- 手動再同期CLI/日次再同期ジョブで不整合が解消した対象会員の未解決 `member_impact_logs`（同一 `member_id` + `issue_code`）は、`resolved_at=now()` でクローズする
- PAY.JP状態の確定不能が6時間継続した場合は当日中に運用文書の緊急時手順へエスカレーションし、解除可否・担当者・実施時刻を記録する（手動での無条件解除は禁止）
- 手動再同期CLIは実行結果として `failed_count` を必須出力する（`failed_count` は全体の `member_impact_logs` における `resolved_at IS NULL` 件数）
- `failed_count` は全体未解決の会員影響件数を表し、完了判定は `failed_count=0` のみを必須とする

## 11. 開発スケジュール（〜2026-04-20）

- 機能凍結日: 2026-04-16（Day 9 終了時）
- リリース実行日: 2026-04-20

## Week 1

1. Day 1（2026-04-06）
- プロジェクト雛形
- DBマイグレーション（5テーブル: `members`, `payjp_events`, `oauth_states`, `discord_link_sessions`, `member_impact_logs`）
- 環境変数管理
- 静的1ページの骨組み（UI最小、文言のみ）
- 本番外部依存の確認チェックリストを作成する（PAY.JP本番キー、Webhook設定、Discordアプリ/OAuth設定、ロール序列確認）
- Day10/Day11用に「受付期間内cancel（初回200）」検証専用テストユーザーを2件（A/B）固定する（`first_trial_granted_at` 既存扱いで、Day10時点に受付期間内となる `access_end_at` を満たす）。A/BはDay10/Day11でのみ使用し、Day7事前検証では使用しない。Day9までの事前検証計画とユーザーIDを固定し、再実施時は未使用ユーザーへ切り替える
- 「初回1か月目課金 + 2か月目/3か月目無料」の課金フローを確定（charge + subscription trial の分離）
- 本番DB反映手順（migration適用 -> `/health` -> 主要API疎通）を必須2文書の付録としてドラフト化する（独立deliverable化しない）
- `2weeks-spec.md` を実装・テストの正本として固定する

2. Day 2（2026-04-07）
- `GET /v1/auth/discord/start`
- `GET /v1/auth/discord/callback`
- `GET /v1/auth/discord/session`
- Cookieバインド（`__Host-oauth_session` / `__Host-link_session`、HttpOnly/Secure/SameSite）実装
- callback/session の `Cache-Control: no-store` / `Referrer-Policy: no-referrer` 実装
- フロントOAuth連携UI（`/session` 呼び出しと連携状態表示）を実装
- P0テスト（OAuth state原子的検証）を実装

3. Day 3（2026-04-08）
- 本番外部依存の確認を完了し、4項目のPass/Failを確定する（PAY.JP本番キー投入可否、Webhook URL/トークン設定、Discord OAuth redirect設定、Botのロール序列確認）。P0 blocker が未完了の場合は Day4 着手前に解消または暫定回避策を確定し、未完了項目はリリースブロッカーとして記録する
- `deep-research-report.md` の未確定事項（課金失敗時イベント遅延/Dunning、長時間5xxフェイルセーフ、トークン移管手順）をベンダー確認し、回答ソースを運用文書へ記録する
- Day3終了時点でP0 blocker未解消の場合は、Day4-7の課金系API着手を後ろ倒しし、先行可能タスク（フロントUI、テスト基盤、運用文書）を先行する。解消翌日に課金系APIへ復帰する
- Day3終了時点でP0 blocker未解消かつDay9凍結維持が困難な場合は、同日中にScope-Transfer Noteを起票し、移管対象と新期限を固定する。あわせてDay4開始前に「移管対象」または「Day10-11で実施する残タスク（P0是正のみ。未完了スコープはScope-Transfer必須）」を確定し、未確定のままDay5へ進まない
- Day6（2026-04-13）12:00 JST時点でP0 blocker未解消の場合は、2026-04-20リリースをNo-Go確定とし、同日中に新リリース日を固定する
- `operationId` 共通ログ出力（API応答/失敗ログ）を実装

4. Day 4（2026-04-09）
- `POST /v1/subscriptions` コア実装（3プラン選択でPAY.JP顧客/購読作成）
- `planId` 許可リスト検証実装
- 初回「1か月目課金 + 2か月目/3か月目無料」判定（同一メールに紐づく `members` 行の `first_trial_granted_at` 基準）実装
- ユーザー単位ロック（advisory lock）+ 既存有効契約ガード（既存 `active/trial`、または `canceled && access_end_at > now` は新規作成拒否）
- `members` 仮行作成 + `inflight_operation_*` 保存/クリアを実装
- `POST /v1/subscriptions` は `link_session` なしで受理する（メール・同意・PAY.JP トークンのみ）。`__Host-link_session` の消費は課金後の `POST /v1/members/link-discord` 側で行う
- P0テスト（代表1プランE2E、残り2プラン設定整合、並列登録、既存契約ガード）を実装

5. Day 5（2026-04-10）
- 3Dセキュア必須フロー（`verified` のみ受理）
- PAY.JP Token再取得検証（`used=false` + 3DS状態）
- 3Dセキュア中断/失敗/タイムアウト時の失敗表示 + 再試行導線を実装
- `subscription.current_period_end` の `next_billing_at/access_end_at` 反映をtrial有無に関係なく実装
- 不確定失敗時の `503 + operationId` 契約（自動再試行禁止、`inflight_operation_*` 保持）を実装
- `503` 代表ケースを決定的に再現できるテスト用注入経路を実装し、固定する（subscribe/cancel）
- 機密マスキング（固定キー）と raw header/body ログ禁止を実装

## Week 2

1. Day 6（2026-04-13）
- `POST /v1/subscriptions` 仕上げ（課金前の Discord ギルド参加・ロール可否検証は行わない。初回 trial 判定・並列ロック・冪等）。初回ロール同期は Webhook / `link-discord` 経路（§6.2）で完結させる
- `POST /v1/subscriptions/cancel` 実装（請求停止 + 終了日までロール維持 + `cancel_requested_at` 冪等成功）
- 作成系PAY.JP APIの「自動再試行しない」失敗ハンドリング実装
- 退会受付の「1か月前同日 00:00 JST（存在しない日は月末繰上げ）」判定を実装
- P0テスト（退会後再加入時の trial 再適用なし）を実装
- P0テスト（subscribe で Discord 事前検証なし、cancel境界・冪等）を実装

2. Day 7（2026-04-14）
- Webhook受信 + 冪等化
- `subscription.created/updated/renewed/canceled/deleted/paused/resumed` の最小イベント処理
- `event.created` の新旧判定実装（古いイベント無視）
- Webhook最小必須項目（`event.id/event.type/event.created/data.id` + 状態反映時 `data.status`）検証を実装
- `metadata.discord_user_id` と `data.id` 逆引きの一致必須チェックを実装
- `access_end_at` 更新（`active/trial/canceled`）と終了日ロール剥奪判定実装
- `subscription.created` の「必須項目欠落時 failed / 充足時 ignored」を実装
- `subscription.updated` の `status` 不変時でも `plan/current_period_end` 反映を実装（ロール同期は実施しない）
- P0テスト（Webhook fail-close最小セット、重複/古いイベント/逆引き不一致、`paused/deleted` 剥奪）を実装
- 手動再同期CLIの最小動作（`operationId` 指定復旧）をDay7内で完了させ、Day8は全会員実行と証跡取得を主対象にする
- Day10/Day11用A/Bは未使用で保持し、Day7は別の受付期間内cancel検証ユーザーで事前検証を完了して証跡を保存する

3. Day 8（2026-04-15）
- 日次再同期ジョブ（本番同等設定で1回成功まで完了）
- 手動再同期CLI（全会員対象の実行と証跡取得）
- 運用手順ドラフト作成（再同期CLI手順、手動ロール剥奪手順）
- Day10本番スモークの事前準備として設定凍結チェックを実施する（Webhook token/livemode、OAuth設定、ロール序列、`DAILY_RESYNC_CRON`）
- Day8ドラフトの運用文書を最終版候補まで更新する
- 手動再同期CLIの完了条件出力（`failed_count`）を実装
- 503復旧オペの運用CLIリハーサルを1回実施し、Day9凍結前に証跡を保存する
- Day9本実行の前提として `12.1` の先行ドライランを1回実施し、未達があれば同日中に是正する
- P0テスト（`503` 不確定失敗の代表ケース + cancel `503` 復旧）を実装
- P0テスト（`access_end_at` 到達の代表ケース、Webhook整合）を実装

4. Day 9（2026-04-16）
- `12.1` のGo-Live必須テスト本実行を1回行い、失敗修正後は「修正影響範囲 + 12.1-3 + 12.1-4 + 12.1-6」を再実行してPassさせる（Day8先行ドライランは本実行に代替しない。Day9出口条件）
- 日次再同期ジョブを1回実行し、成功ログを受け入れ証跡として保存する
- 手動再同期CLIを全会員対象で1回実行し、全体 `failed_count=0` と `members.inflight_operation_id` 残留0件の証跡を保存する
- Day10前に `DAILY_RESYNC_CRON` の本番設定値を確定し、変更禁止として記録する
- Day8時点の最終版候補にDay9修正を反映し、運用文書を最終版として固定する
- Day9終了時点で機能凍結し、新規機能追加を停止する

5. Day 10（2026-04-17）
- バッファ（P0不具合の最終修正・Go/No-Go判定）を先に実施する（新規機能追加と受け入れ項目追加は禁止。API/DBスキーマ変更はP0是正に限り許可し、変更時は `12.1` を再実行してPassを必須とする）
- 本番環境変数投入
- migration適用 -> `/health` -> 主要API疎通（OAuth/session/subscriptions/cancel/Webhook）を確認する
- 本番最小スモーク（Webhook token/livemode、OAuth→登録→再OAuth→cancel）を1回実施する（cancel はDay1で固定した受付期間内テストユーザーA/Bの未使用側で初回 `200` 成功を必須とし、受付期間外 `409` は任意確認とする）
- 一次Go/No-Go判定を実施し、未達がある場合はDay11バッファで是正後に最終再判定して2026-04-20のリリース実行に備える

6. Day 11（2026-04-18）
- Day10で `12.1` 再実行または本番最小スモークが未達の場合の是正バッファ日とし、再実行と証跡更新を完了する

## 12. テスト要件（P0必須）

### 12.1 P0（Go-Live必須: 7件）

1. OAuthは `state + __Host-oauth_session + 未使用 + TTL内` の原子的検証/消費が行われる。代表失敗ケース（`state` 不一致）で認可失敗し、callback/session で `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を返す。`GET /v1/auth/discord/start` の認可URL `scope` が `identify` 固定であることを確認する。
2. `POST /v1/subscriptions` は `PAYJP_PLAN_IDS` 3プランに対応し、代表1プランで実課金E2E成功、残り2プランは設定整合テスト（実課金不要）で登録成功を確認する。`members.payjp_plan_id` / `members.payjp_subscription_id` 保存が行われ、初回ユーザーでは `members.payjp_initial_charge_id` も保存されることを確認する。退会後再加入時は `first_trial_granted_at` が保持され trial 再適用なしとなる。初回は `trial_end=登録時点+3か月`、非初回は `trial_endなし`、課金intervalは `month` であることを確認する。**subscribe では課金前の Discord ギルド検証を行わない**（CR-009）。`Origin` 欠落/不一致/`Origin: null` は `403` で拒否されることを確認する。3Dセキュア失敗/中断/タイムアウト時は `POST /v1/subscriptions` が呼ばれないことを確認する。3Dセキュアに伴う個人情報取り扱い同意が無い場合は `createToken` を開始せず、`POST /v1/subscriptions` も送信されないことを確認する。初回 `charge` とsubscriptionの双方について、PAY.JPから取得したオブジェクトに `metadata.member_id` と `metadata.operation_id`（=`operationId`）が保存されていることを確認する（`metadata.discord_user_id` は連携後に付与されうる）。あわせて成功レスポンスが `{ ok: true, memberId: uuid文字列, subscriptionStatus: enum, planId: string, trialApplied: boolean, accessEndAt: RFC3339 UTC文字列 }` を満たすことを確認する。
3. 同一 `discord_user_id` への並列 `POST /v1/subscriptions` で二重購読が作成されず、`charge=1` / `subscription=1` が保たれる。既存 `active/trial` または `canceled && access_end_at > now` の契約では新規作成されない。
4. 不確定失敗（`503`）の代表ケース（`charge` 後の `subscription` 不確定）を、テスト用注入経路で決定的に再現して検証する。運用CLIで `members.payjp_initial_charge_id` または `metadata.operation_id=operationId` を決定キーに既存課金を検知しつつ `charge=1` / `subscription=1` を維持し、`operationId` で追跡できる。検証では `members.payjp_initial_charge_id` が欠落している場合でも `metadata.operation_id=operationId` により既存課金を検知して復旧できることを必須とする（この検索は `GET /v1/charges` を `limit=100`・`offset` ページングで `has_more=false` まで走査した結果であることを必須とし、`offset<=900` 上限到達時に `has_more=true` の場合は確定不能として fail-close・再課金禁止とする。検索の `since/until` は `members.inflight_operation_started_at` をUTCとしてUnix秒化（整数）した `inflight_operation_started_at_unix` を用いる。`members.payjp_customer_id IS NULL` の場合は即 fail-close とし復旧を続行しない）。手動再同期CLIの引数相互排他（`--operation-id` / `--discord-user-id` / `--all`）、1行JSON出力（`mode,target,processed_count,succeeded_count,failed_count,started_at,finished_at,duration_ms`）、終了コード（`0/2/1`）を満たすことを確認する。
5. Google Form退会では `POST /v1/subscriptions/cancel/google-form-link` が署名付きワンタイムトークン付きのGoogle Form URLを返し、Apps Script からの `POST /v1/subscriptions/cancel/google-submit` がPAY.JP cancel APIを1回実行して `200` 成功となることを確認する。`cancel_requested_at` 既存時はPAY.JP再呼び出しなしで冪等成功（200）となること、Discordロール剥奪失敗時は `503` と `role_state=unknown` が残り、再試行または再同期で整合回復できることを確認する。`payjp_subscription_id` 未設定時も `409` で再同期要求になり、再同期CLIの再構築手順では `GET /v1/customers/:id/subscriptions` を `limit=100`・`offset=0,100,200,...` で `has_more=false` まで走査し（`offset<=900` 上限、`offset=900` 到達時点で `has_more=true` は確定不能fail-close）、`status in (active,trial,canceled,paused)` かつ `metadata.discord_user_id` 一致で1件確定した場合のみ補正できることを確認する。`metadata.discord_user_id` 欠落時は `status` 条件の候補が1件のみの場合に限り補正できること（かつ `next_billing_at_unix = floor(extract(epoch from members.next_billing_at))`（UTC・整数秒）を用いて `subscription.current_period_end == next_billing_at_unix` の完全一致の場合に限る）、0件または複数件（または `members.next_billing_at` が `NULL` / 時刻整合不一致）はfail-closeで停止することを確認する。通信エラーやJSON欠落で走査を完了できない場合も fail-close として停止することを確認する。あわせて `members.payjp_customer_id IS NULL` の場合は fail-close とし cancel 復旧を続行しないことを確認する。成功レスポンスが `{ ok: true, memberId: uuid文字列, cancelEffectiveAt: RFC3339 UTC文字列, roleRemovalAt: RFC3339 UTC文字列 }` を満たすことを確認する。
6. `canceled` で `access_end_at` 到達後、`paused` / `deleted` 到達時にロールが除去される（Webhookまたは日次再同期）。あわせて日次再同期でPAY.JP subscription `404` を検知した会員が `deleted` 扱いで剥奪されることを確認する。
7. Webhookで `event.id` 重複送信は二重処理されず、`event.created` が古いWebhookは `ignored` となり会員状態が巻き戻らない。`event.created == members.last_payjp_event_created_at`（同秒）は `ignored` にせず処理対象とし、順序は単一ワーカーでは到着順になり得るが複数ワーカーでは非決定であることを確認する。`metadata.discord_user_id` と `data.id` 逆引き不一致・必須項目欠落は `failed` で `members` 非更新、トークン不一致は `401`、`subscription.created` は必須項目欠落時 `failed` / 充足時 `ignored` とする。`data.status` が不明値の場合は `failed` 記録・`members` 非更新・安全側のロール剥奪を確認する。加えて、認証/課金APIとWebhookで raw header/body がログ出力されないことを確認する。さらに、payloadに `data.metadata.operation_id` が存在する場合は `payjp_events.data_metadata_operation_id` に保存され、存在しない場合は `NULL` で記録されることを確認する。

## 13. 運用ルール（MVP）

1. 毎朝、前日失敗ログ件数を確認する（`payjp_events.process_status=failed` 件数、課金/解約APIの `503/5xx` 件数、`member_impact_logs.resolved_at IS NULL` 件数を対象とする）。
2. 手動再同期CLIの `failed_count`（全体の未解決会員影響件数）が0でない場合は、同日中に再同期と手動復旧を継続する。
3. 再同期の完了条件は「`failed_count = 0`」とする。
4. 課金作成API/退会申請APIでタイムアウト等の不確定失敗（`503`）が発生した場合は、`operationId` をキーにPAY.JP現状態を確認してから再同期CLIを実行する（クライアント自動再試行は禁止。再試行は運用CLIのみ）。
5. `members.inflight_operation_id` が残っている間は同一ユーザーの課金/解約APIを再実行しない。`operationId` 突合 -> PAY.JP状態確認 -> `members` 反映 -> Discordロール再同期 -> `last_payjp_event_created_at` 単調増加更新を完了した場合のみ `inflight_operation_*` を解除できる。`inflight_operation_started_at` から30分は監視強化の閾値とし、30分未満でも上記整合条件を満たせば解除してよい。6時間超の確定不能は緊急時手順へエスカレーションし、解除可否を記録する。
6. 緊急時手順として手動剥奪を定義し、実施条件・手順・確認方法を運用文書に固定する。
7. OAuth失敗率が高い場合は `redirect_uri` とクライアント設定を再確認する。
8. 重大障害（課金不整合1件以上、または `access_end_at` 到達済みのロール未剥奪1件以上）が判明した場合は当日中に手動復旧を実施する。
9. `access_end_at` が当日到達する退会申請ユーザーを毎日確認し、ロール除去漏れがあれば当日中に手動再同期で補正する。
10. 2026-04-20 までに必須の運用文書は「再同期CLI手順」「手動ロール剥奪手順」の2点に限定する（正本: `docs/ops/resync-cli.md` / `docs/ops/manual-role-revoke.md`）。

## 14. 受け入れ条件（Go-Live）

各受け入れ項目の証跡は「実施日時 / テストIDまたは実行コマンド / 結果」を必須とし、再現可能な証跡として `CI実行ID` または `主要ログ参照` のいずれか1つを必ず添付する。証跡は `docs/evidence/YYYYMMDD-<testid>.md` に保存し、同一命名規則を用いる。

1. Day9で `12.1` の7件を1回実行してPassしている。不具合修正後は「修正影響範囲 + 12.1-3 + 12.1-4 + 12.1-6」を再実行してPassしている。
2. Day10に本番最小スモーク（Webhook token/livemode、OAuth→登録→Google Form退会）を1回実施し、cancel はDay1で固定した受付期間内テストユーザーA/Bの未使用側で初回 `200` 成功（PAY.JP cancel API実行あり、`access_end_at` が `current_period_end` 相当で保持され、Discordロール即時剥奪が確認できる）を確認している。Day10未達の場合はDay11までに再実施してPassしている。
3. 手動再同期CLIを全会員対象で実行し、全体 `failed_count=0` を確認済みで、`members.inflight_operation_id` 残留0件を確認している。
4. 2026-04-20時点の運用文書として「再同期CLI手順」「手動ロール剥奪手順」が最終化されており、前者には「6時間超の確定不能時エスカレーション分岐（解除可否/担当者/実施時刻の記録必須）」が明記されている。
5. 本番反映時に `migration適用 -> /health -> 主要API疎通`（OAuth/session/subscriptions/cancel/Webhook）を確認済み。
6. 機密マスキング（固定キー）と raw header/body 非出力がログ/レスポンスで確認済み。
7. 日次再同期ジョブのスケジュールが有効化済みで、直近1回の成功ログを確認済み。
8. Day9機能凍結前までに「503復旧オペの運用CLIリハーサル1回」と「受付期間内cancel検証ユーザーの事前検証1回」の証跡が保存されている。
9. `deep-research-report.md` の未確定事項3件（課金失敗時イベント遅延/Dunning、長時間5xxフェイルセーフ、トークン移管手順）について、ベンダー回答と採用判断が運用文書に反映されている。

## 15. 将来拡張（リリース後）

1. プロダクト機能拡張（会員ポータル、プラン変更、プラン別ロール、独自grace period）
2. 運用UI/管理機能（**write 系**管理画面、会員ポータル、手動修復補助の高度化）。**read-only 管理 Phase A と招待制は CR-010 で実装済み**。導入境界・認証・段階ロールアウトの正本は `docs/admin-console-boundary.md`（CR-005 / CR-006 / CR-010）。
3. 課金API堅牢化（`Idempotency-Key` 厳密検証、レスポンス再返却）
4. Webhook高度化（`event.id` 再取得照合、厳密時刻補正、補償upsert、DLQ）
5. 同期/ジョブ基盤拡張（ロール同期の非同期化、期限切れデータ掃除ジョブ）
6. 通知・不正検知（課金失敗/剥奪通知、不正利用検知）
7. セキュリティ強化（Webhook送信元IP制限、秘密鍵ローテーション自動化）
8. 監視・検証高度化（監視SaaS/SLO、バースト耐性試験、障害注入試験）

具体タスクは別バックログ（Issue/Project）で管理し、本章ではカテゴリのみを固定する。

## 16. 用語・表記ルール（本書固定）

1. 本文の用語は「ロール」に統一する（必要時のみ初出で `Role` を併記）。
2. 本文の用語は「Webhook」に統一する（APIパス `/v1/payjp/webhook` は固定）。
3. 本文の用語は「3Dセキュア」に統一する。
4. 月の表記は「1か月/2か月目」の形式に統一する。
5. `*_unix` はDBの `timestamptz` をUTCとして Unix 秒（整数）へ変換した値を指す（例: `inflight_operation_started_at_unix = floor(extract(epoch from members.inflight_operation_started_at))`、`access_end_at_unix = floor(extract(epoch from members.access_end_at))`）。PAY.JP APIの `since/until/current_period_end` との比較・送信はUTCのUnix秒（整数）で行い、JSTはログ/運用表示のみに用いる。
6. **購読（課金）** と **Discord** の関係: ユーザー価値の主目的は購読の開始・維持である。`POST /v1/subscriptions` では **Discord を課金前提にしない**。OAuth・`guilds.join`・ロール付与は **課金成功後**（§5、§6.2 item5、`POST /v1/members/link-discord`）。
7. 旧称「Discord-first」（課金API前に Discord を検証する順序）は **本リリースの正本フローでは用いない**（CR-009）。

## Change Request 履歴

### CR-001: advisory lock の hashtext 廃止 → Discord Snowflake ID (bigint) 直接使用

- 日付: 2026-04-07
- 起票: Issue #3「#1 レビューからの引き継ぎ事項」
- 変更内容: `pg_advisory_lock(discord_user_id::bigint)` → `pg_try_advisory_lock(discord_user_id::bigint)` / `pg_advisory_xact_lock(discord_user_id::bigint)`
- 理由: `hashtext` は 32bit ハッシュであり衝突リスクがある。Discord Snowflake ID は 64bit 整数（PostgreSQL signed bigint 範囲内）であるため直接使用することで衝突を排除する
- 影響範囲: §5.1 step2、§5.2 step2、§8 item13、billing-service shell 層、shared DB アダプタ

### CR-002: Google Form退会フローへの切り替え

- 日付: 2026-04-11
- 起票: Google Form退会フロー計画
- 変更内容: 退会導線を `Discord再OAuth -> POST /v1/subscriptions/cancel` から `POST /v1/subscriptions/cancel/google-form-link -> Google Form -> Apps Script -> POST /v1/subscriptions/cancel/google-submit` へ切り替える
- 理由: 退会理由をGoogle Sheetsへ集約しつつ、PAY.JP解約・アプリ利用停止・Discordロール剥奪をフォーム送信直後に即時反映するため
- 影響範囲: §2 scope item5、§5 user flow step9-11、§6.1 front-end cancel flow、§6.2 cancel APIs、§6.3-6.5 role/cancel policy、§8 security、§10 resync、§12.1 P0-5/6、frontend cancel UI、billing/sync/server routes

### CR-003: `google-submit` 共有シークレット用ヘッダー名の変更

- 日付: 2026-04-11
- 起票: Google Form Secret Header Fix（Apps Script 実地調査）
- 変更内容: `POST /v1/subscriptions/cancel/google-submit` の共有シークレット検証用 HTTP ヘッダーを `X-Google-Cancel-Secret` から `X-Cancel-Secret` に変更する。移行期間は `X-Google-Cancel-Secret` をフォールバックとして受け付ける
- 理由: Google Apps Script `UrlFetchApp` から `X-Google-*` カスタムヘッダーがサーバーに届かない可能性があり、curl では通過するが Apps Script では `401 INVALID_GOOGLE_SECRET` になる事象を解消するため
- 影響範囲: §6.2 item7 `google-submit`、README Apps Script サンプル、server `billing.routes`、運用手順

### CR-004: 退会後の権限維持（`current_period_end` まで）

- 日付: 2026-04-11
- 起票: 退会後表示と利用期限の整合
- 変更内容: 退会申請後は PAY.JP で定期請求を停止しつつ、`members.access_end_at = subscription.current_period_end` とし、それまではアプリ利用とDiscord有料ロールを維持する。`members.cancel_requested_at` は課金停止申請日時として別項目で保持する。`access_end_at` 到達後は日次再同期/Webhookでロール剥奪を行う。
- 理由: 利用期間終了までの利用可否とUI表示を一致させ、誤解を防ぐため
- 影響範囲: §2 scope item5、§5 user flow、§6.3〜6.6、Webhook、billing/sync/server routes、frontend 購読画面

### CR-005: 管理画面（運用UI）導入方針の文書化

- 日付: 2026-04-11
- 起票: 管理画面導入方針（別サブドメイン・認証境界・VPS分離の判断基準）
- 変更内容: Go-Live 後に検討する運用UIについて、**MVP では実装しない**前提を維持しつつ、`docs/admin-console-boundary.md` に **別サブドメイン・セッション分離・IdP+MFA 主軸・同一VPSからの開始可・段階ロールアウト** を固定する。実装は別Issueとする。
- 理由: 利用者向け `__Host-` セッションと管理操作を混在させず、緊急時の手動手段を安全な境界で追加するため
- 影響範囲: §15 item2、`docs/implementation-design-mvp.md` §9、`docs/tdd-acceptance-matrix-mvp.md` §6

### CR-006: 管理画面の具体仕様固定（`admin.and--line.com` / Cloudflare Access / 同一VPS）

- 日付: 2026-04-11
- 起票: 管理画面仕様化（ホスト名・認証・段階導入）
- 変更内容: 管理画面のホスト名を `admin.and--line.com` に固定し、前段認証を Cloudflare Access + 外部IdP + MFA に固定する。配置は同一VPSとするが、公開アプリとは別プロセス/別コンテナ/別ポートで隔離する。Phase A は read-only、Phase B は単一会員中心の緊急操作とし、利用者向け導線・CORS 許可・Cookie 共有を禁止する。
- 理由: 利用者が誤って到達・利用できない境界を明確化しつつ、リリース後の運用UI実装を安全に進められるようにするため
- 影響範囲: §15 item2、`docs/admin-console-boundary.md` 全体、`docs/implementation-design-mvp.md` §9、`docs/tdd-acceptance-matrix-mvp.md` §6

### CR-007: 利用終了後の再入会（`GET /v1/subscriptions/status` とフロント導線）

- 日付: 2026-04-11
- 起票: 退会済みユーザの再入会（画面から課金フォームへ）
- 変更内容: `members.access_end_at` 到達後は、課金コアの `hasActiveSubscription` と同一の判定で「有効な購読なし」とみなし、`GET /v1/subscriptions/status` は `subscription: null` を返す（DB上 `subscription_status=canceled` が残っていても同様）。フロントは同じ判定で退会済み表示の合成を猶予期間内に限定し、Discord 連携済みかつ購読なしの場合は既存の課金フォーム（`POST /v1/subscriptions`）へ誘導する。
- 理由: 退会後の利用終了日経過後も購読状況画面に固定され再入会できない問題を解消し、仕様どおり再加入（トライアル再適用なし等）を画面から可能にするため
- 影響範囲: `GET /v1/subscriptions/status`、server `billing.routes`、frontend `member-entitlement` / `main` 初期化、`docs/implementation-design-mvp.md` §3.1

### CR-008: 購読主目的と「Discord-first」俗称の明文化（用語のみ）

- 日付: 2026-04-12
- 起票: 購読フロー説明の誤解防止（課金API前の Discord 検証との混同）
- 変更内容: §5 冒頭および §16 に、**ユーザー価値の中心は購読（課金）**であり、Discord 検証は **PAY.JP 書き込み前の前提** であること、俗称「Discord-first」が **検証順序** を指すこと（課金より Discord を価値上優先する意味ではないこと）を明記する。`docs/implementation-design-mvp.md` §5.0 を追加し、`docs/tdd-acceptance-matrix-mvp.md` に参照一行を追加する。
- 理由: 実装・レビューで「Discord-first」と略した際に、主目的の取り違えが起きないようにするため
- 影響範囲: `docs/2weeks-spec.md` §5・§16、`docs/implementation-design-mvp.md` §5.0、`docs/tdd-acceptance-matrix-mvp.md` 冒頭、`課金先行` / `billing-first` 等の誤解を招くコメントの置換（挙動変更なし）

### CR-009: B2B 支払後 Discord 連携（メール起点購読）と料金表

- 日付: 2026-04-12
- 起票: PAY.JP B2B 審査整合（企業向けコミュニティ参加権・支払後招待）
- 変更内容: 商材を **法人向け SES コミュニティ参加権** に明文化。ユーザーフローを **課金 → `member_session` → Discord OAuth（`identify`+`guilds.join`）→ `guilds.join` 自動参加** に変更。`POST /v1/subscriptions` から **`__Host-link_session` 必須**および**課金前 Discord ギルド検証**を削除。初回無料判定を **メールに紐づく `members` 行**基準で維持。税込月額の代表値を **20,000 / 50,000 / 70,000 円** に更新（環境変数・公開ページと同期）。
- 理由: 審査・公開法務・実装のストーリーを一致させ、案件/人材仲介と誤認されないようにするため
- 影響範囲: `docs/2weeks-spec.md` §2・§5・§6・§16、`docs/implementation-design-mvp.md`、`docs/tdd-acceptance-matrix-mvp.md`、`packages/billing-service/src/shell/subscribe.ts`、`frontend/src/main.ts`、`frontend/public/*.html`、E2E `subscribe.test.ts`

### CR-010: 共有パスコードゲート + 管理画面 Phase A（read-only）

- 日付: 2026-04-12（CR-011 で招待URL方式から共有ゲートへ差し替え）
- 起票: 購読導線の限定公開と運用可視化（`docs/admin-console-boundary.md` Phase A 整合）
- 変更内容:
  1. **共有パスコードゲート（任意）**: `SUBSCRIBE_GATE_CODE` が非空のときのみ、`GET /v1/access-gate/session` でフロントがロック状態を確認し、`POST /v1/access-gate/verify` で共有コード検証後 `__Host-access_gate` を発行する。`POST /v1/subscriptions` は **新規購読** に限り有効なゲートセッション（DB にハッシュが存在し未失効）を必須とする。コード未設定時はゲートなし。旧 `GET /v1/invites/accept` はフロントオリジンへリダイレクトのみ（互換）。詳細は `docs/ops/access-gate.md`。
  2. **管理画面 Phase A**: `admin.and--line.com` 向けに **別プロセス** `@hayane/admin-server`（Fastify、**GET のみ**）と静的 `admin-frontend` を追加。会員一覧・検索・詳細・概要（未解決影響件数・inflight 件数）を PostgreSQL 正から read-only 表示。前段は Cloudflare Access 前提（アプリは `CF-Access-Authenticated-User-Email` / `X-Admin-Audit-Actor` を監査ログ用に参照しうる）。
- 理由: 公開ポータル（`service.html` 等）と購読フォームのリスクを分離し、運用が会員状態を安全に俯瞰できるようにするため
- 影響範囲: `packages/shared`（`access_gate_sessions` DDL、レガシー `invite_*` はマイグレーション互換のみ）、`packages/billing-service`、`packages/server`（access-gate/billing routes、cleanup）、`frontend`（`index.html` SPA のみゲート）、`packages/admin-server`、`admin-frontend`、`nginx/nginx.conf`、`docker-compose.yml`、`docs/ops/*`、`docs/admin-console-boundary.md` §2 ロールアウト表、`docs/implementation-design-mvp.md`、`docs/tdd-acceptance-matrix-mvp.md`

### CR-011: 署名付き招待URLから共有パスコードゲートへ移行

- 日付: 2026-04-12
- 起票: 運用負荷とオンボーディング簡素化（単一URL + ローテーション可能な共有コード）
- 変更内容: `INVITE_*` / `invite-cli` / per-user 署名URL / 購読成功時の `invite_tokens` 消費を廃止し、**`SUBSCRIBE_GATE_CODE` + `ACCESS_GATE_SESSION_TTL_SECONDS` + `access_gate_sessions`** に一本化。API は `GET/POST /v1/access-gate/*`、Cookie は `__Host-access_gate`。
- 理由: MVP 公開範囲のサーバ強制は維持しつつ、発行CLIと1回限りトークン運用を避けるため
- 影響範囲: `packages/server`、`packages/billing-service`、`packages/shared`、`frontend`、E2E、`.env.example`、`docs/ops/access-gate.md`（`docs/ops/invite-urls.md` 置換）

### CR-012: 退会時Discordロール即時剥奪

- 日付: 2026-04-12
- 起票: Google Form退会の実地確認で、課金停止成功後もDiscordロールが残存していた
- 変更内容: `POST /v1/subscriptions/cancel/google-submit` および `POST /v1/subscriptions/cancel` 成功時に、PAY.JP解約反映後ただちに Discord 有料ロールを剥奪する。`members.access_end_at` / `members.next_billing_at` は引き続き `current_period_end` を保持するが、これは契約終了予定日の表示・運用確認にのみ用いる。`canceled` は Webhook / 日次再同期 / 再連携のいずれでも grant 対象にしない。
- 理由: 退会導線の期待結果を「課金停止とDiscordアクセス停止の即時反映」に統一し、フォーム送信成功後の残留ロールを防ぐため
- 影響範囲: §1, §2 scope item5, §5 user flow step7, §6.2 cancel APIs, §6.3〜6.5 role/cancel policy, `packages/billing-service`, `packages/sync-service`, `packages/server`, `frontend`, `docs/implementation-design-mvp.md`, `docs/tdd-acceptance-matrix-mvp.md`

### CR-013: `google-submit` HMAC 署名 (X-Cancel-Signature) 追加

- 日付: 2026-04-14
- 起票: 2026-04-14 セキュリティ監査（F-001）— `X-Cancel-Secret` bearer token のみでは Apps Script 側 secret 漏洩時に第三者が任意 body で cancel submit 可能
- 変更内容: `POST /v1/subscriptions/cancel/google-submit` に `X-Cancel-Signature` ヘッダーを **必須** で追加する。値は `HMAC-SHA256(GOOGLE_FORM_CANCEL_SECRET, ${normalizedEmail}\n${token})` の hex。サーバー側は `X-Cancel-Secret` 検証の直後に `X-Cancel-Signature` を再計算し `timingSafeEqual` で比較、不一致は `401 INVALID_CANCEL_SIGNATURE` を返す。`normalizedEmail` はサーバー側の `normalizeEmail` と同一（小文字化＋前後空白除去）。name / reason は署名対象外（GAS ログに平文で残るため）。
- 理由: bearer-only 認証に対する defense-in-depth。bearer secret 漏洩シナリオ（GAS 実行ログ視認・開発者端末盗難など）でも、攻撃者は HMAC を再計算できなければ任意ペイロードの submit を偽造できない。
- 影響範囲: §6.2 `POST /v1/subscriptions/cancel/google-submit` の仕様、`docs/implementation-design-mvp.md` §5.3 / API 表、`packages/billing-service` core + shell、`packages/server` routes、`docs/ops/apps-script-cancel.md`（新規）、Apps Script 側実装（リポジトリ外・本 CR と同時デプロイ必須）
- 運用注意: Apps Script 側 HMAC 生成コードは `Utilities.computeHmacSha256Signature(message, secret)` を使用。transition 期間は設けず、本 CR マージと同時に Apps Script もデプロイ更新する（移行フラグ不要）。
