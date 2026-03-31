# PAY.JP × Discord 連携サービス 2週間MVP仕様書（OAuth Lite + Multi Plan + Monthly Billing版）

- 作成日: 2026-03-28
- 更新日: 2026-03-30
- 対象: 日本向け有料Discordコミュニティ（約150名）
- 体制: 1名
- リリース目標: 2026-04-20（当初2週間目安: 2026-04-15 から変更）
- 方針: 要件を満たす最小実装（フロント最小、バックエンド最小）
- 本リリースの正本仕様: `2weeks-spec.md`（`spec.md` は参照用であり、2026-04-20 リリース判定の正本ではない）

## 1. 目的

本MVPは、次の3点を最優先で実現する。

1. 課金状態に応じてDiscord有料ロールを自動付与・自動剥奪する。
2. Discord OAuthで正しいユーザーIDを自動取得し、手入力運用を廃止する。
3. 異常時の調査に必要な情報をログへ記録し、手動復旧できる状態を維持する。

特に、最終失効状態（`paused/deleted`）ではDiscord有料ロールが確実に剥奪されることを必須要件とする。

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
18. `subscription.created` Webhookのみでの会員自動復元（補償upsert）の有効化
19. Webhook `event.created` 同秒競合のtie-break規則（`payjp_event_id` 辞書順など）
20. Day9での「P0全20件を2回全件実行」の必須化
21. Day9/Day10で同一内容の本番疎通を二重実施する運用
22. OAuth/Cookieヘッダ詳細マトリクス（旧P0 #1-3の網羅）
23. `__Host-link_session` 再利用不可の成功/失敗両系統の網羅（旧P0 #4の網羅）
24. CSRF/CORS全否定ケース網羅（旧P0 #5-6の網羅）
25. 許可外 `planId` 単体テスト（旧P0 #7の独立必須化）
26. Webhook不正入力全マトリクス（旧P0 #18の全面網羅）
27. Webhook期待値表フル自動アサート + 機密マスキング詳細網羅 + CLI完了条件同時検証（旧P0 #20の拡張）
28. `first_trial_granted_at` の改ざん不能監査ログ
29. `operationId` ログの90日保持固定
30. `Sec-Fetch-Site` 強制（OAuth start/保護POST）
31. 同名Cookie重複を常時 `400` 拒否
32. 3Dセキュア入力UIの厳密制約（`card.name` 正規表現、`card.phone` など）
33. `SELECT ... FOR UPDATE` の常時必須併用
34. Webhook `Content-Type` 厳密前方一致と固定サイズ上限
35. Discord API再試行の高度制御（指数バックオフ/長時間リトライ）
36. 公開APIレート制限の詳細値固定
37. CORS単一値fail-fast
38. 再帰キー走査 + 値パターン一致まで含む高度マスキング
39. 孤立subscription復旧手順の必須運用化
40. trial手動上書き判断フローの必須運用化
41. 緊急時手順4種の文書化必須化
42. 課金失敗/ロール剥奪時のユーザー自動通知（DM/メール）
43. Webhook失敗イベントのDLQ（遅延再処理キュー）
44. 運用者向けread-only会員状態確認API（`discord_user_id` 検索）
45. Webhook送信元IP許可リスト
46. 秘密鍵ローテーション自動化（KMS/Secret Manager連携）
47. 不正利用検知（短時間の失敗集中・国別異常）
48. Webhookバースト耐性試験（重複・順序乱れ・遅延の高負荷）
49. Discord API障害注入（429/5xx/timeout）での回復試験
50. PAY.JP `event.id` 再取得照合テスト
51. `subscription_request_keys` レスポンス再返却テスト
52. Day9再実行順の固定定義（旧12.2）
53. 受け入れ証跡5点セットの全項目必須化（実施者/CI実行ID/主要ログを全件必須）
54. 手動再同期CLIで `failed_count/role_mismatch_count/revocation_miss_count` の3値すべて0を必須化
55. 3Dセキュア中断/失敗/タイムアウト時の再送信恒久無効化
56. 日次再同期の実行時刻を `JST 03:30` に固定
57. Go-Live判定で `PAYJP_PLAN_IDS` 3プランすべての実課金E2Eを必須化
58. OAuth失敗4系統 + no-store/no-referrer同時網羅のGo-Live必須化
59. Webhook fail-close全マトリクスのGo-Live必須化
60. ステージング総合疎通で4ヶ月目課金相当までを必須化
61. `operationId` 自己照会用read-only API（ユーザー向け）
62. `access_end_at` 到達前リマインド通知（Discord DM/メール）
63. `inflight_operation` 残留監視ダッシュボード
64. CSP/HSTSの本番強化
65. 依存パッケージ脆弱性スキャンのCIゲート化
66. Webhook送信元IP許可リストの自動更新運用
67. 匿名化した実Webhookログの長時間リプレイ回帰
68. Discord/PAY.JP障害注入（429/5xx/timeout）の定期カオステスト
69. 受け入れ証跡の自動収集（CI ID/operationId/ログ紐付け）
70. `503` 不確定失敗時の「運用者による手動API再実行」運用の必須化
71. Week1 Day1終了時点での課金/解約状態遷移表の変更凍結
72. Webhookの `event.type` 別必須項目の詳細固定（`data.current_period_end` を含む厳密必須）
73. Discord API `429` 時の `Retry-After` 優先 + 最大3秒待機の詳細制御
74. 手動再同期CLIで `role_mismatch_count/revocation_miss_count` 出力を必須化
75. `role_mismatch_count/revocation_miss_count` 残件の手順・担当者・期限記録をGo-Live必須化
76. Webhook処理/再同期処理まで含む全面 `pg_advisory_xact_lock` 必須化
77. Webhook処理で `payjp_events` 記録・`members` 更新・`process_status` 更新の3点同時トランザクション必須化
78. Discord API再試行の詳細制御（短時間/待機制限）の必須化
79. セキュリティ必須としてのUTC保持/JST換算ルール
80. `payjp_events` 監査項目最小化の詳細規定の必須化
81. `operationId` を全ログ/外部API呼出へ必須付与
82. 再同期CLIの `--dry-run`（差分表示のみ）
83. Webhookペイロード再生ツール（保存イベントのローカル再実行）
84. Discord未参加ユーザーへの招待リンク自動提示UI
85. 保護POSTへのCSRFトークン（二重送信）
86. 秘密鍵ローテーション訓練（手順リハーサル）
87. Webhook異常トラフィック向けWAFルール
88. `paused/deleted` 剥奪の受け入れ別立て必須化
89. `operationId` 追跡可能性の受け入れ別立て必須化
90. 受け入れ項目ごとの個別証跡（毎回ログ添付）の必須化
91. `access_end_at` 「1か月前同日 00:00:00 JST」境界マトリクス全面網羅
92. `503` 不確定失敗時のUI文言固定（「再OAuthが必要です」固定）

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
9. 退会申請ユーザーは `POST /v1/subscriptions/cancel` を呼び、定期請求は停止しつつ終了日まではRoleを維持する（`__Host-link_session` が失効または消費済みの場合は再OAuthで再取得する）。
10. 以後はWebhookイベントと日次再同期で状態を維持する。

## 6. 機能仕様

## 6.1 フロントエンド（1ページ）

1. ページ: `/`

2. 入力項目
- `planId`（選択式: 3プラン）
- `email`
- カード入力（PAY.JP提供UI）

3. 動作
- 連携完了確認: `GET /v1/auth/discord/session`（`linked` のみ参照）
- 3-Dセキュア方式は `PAY.JP.js` のiframe方式に固定する（redirect方式はMVP非対応）
- 「登録する」押下で `payjpToken` を生成
- `PAY.JP.js` の `createToken` で `three_d_secure: true` を必須にする
- 3Dセキュア認証が完了し、`three_d_secure_status = verified` のトークンを取得できた場合のみ `POST /v1/subscriptions` を実行する
- 3Dセキュアが中断/失敗/タイムアウトした場合は `POST /v1/subscriptions` を呼ばない
- 3Dセキュア中断/失敗/タイムアウト時は、画面に失敗理由を表示し、再試行導線を提示する
- `planId` は3プランの許可リストから選択し、`POST /v1/subscriptions` に含める
- 退会申請は `POST /v1/subscriptions/cancel` を呼ぶ（定期請求停止、Roleは終了日まで維持。`__Host-link_session` が失効または消費済みの場合は再OAuth）

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
- 入力: `{ planId, email, payjpToken }`
- 処理:
  - `Origin == FRONTEND_BASE_URL` を必須検証する（不一致/欠落/`Origin: null` は `403`）
  - `__Host-link_session` Cookie を検証し、失効/不正/消費済みは `401` で拒否して再OAuthを要求する
  - `planId` が `PAYJP_PLAN_IDS` の許可リスト内であることを検証
  - ユーザー単位の排他制御として `pg_advisory_xact_lock(hashtext(discord_user_id))` を取得する
  - `members` 行が存在しない場合は `discord_user_id` と `email` で仮行を作成する（購読作成中状態の永続化に利用）
  - `members.inflight_operation_id` が存在する場合は既存契約有無に関わらず新規課金処理を開始せず `503` を返す（既存 `operationId` を返却。解除はPAY.JP状態確認後の再同期CLIのみ）
  - ロック後に `members` を参照し、既存 `active/trial`、または `canceled` かつ `access_end_at > now()` の契約がある場合は新規作成せず既存結果を返す
  - `discord_user_id` が `DISCORD_GUILD_ID` のメンバーであることを検証（未参加は409）
  - Botに `Manage Roles` 権限があり、`DISCORD_PAID_ROLE_ID` を付与可能な序列であることを検証（不可は503）
  - `payjpToken` をPAY.JP APIで再取得し、`used=false` かつ `card.three_d_secure_status = verified` を検証する（`attempted` / `failed` / `error` / `unverified` / `null` は422）
  - PAY.JP API呼び出しは公式SDKまたは `application/x-www-form-urlencoded` で実行する（JSON POSTしない）
  - 初回無料判定は `discord_user_id`（人間単位）で行う。`members.first_trial_granted_at IS NULL` の場合のみ初回ユーザーとして扱う
  - PAY.JP書き込み（customer/charge/subscription）開始前に `operationId` を生成し、`members.inflight_operation_id` / `members.inflight_operation_type=subscribe` / `members.inflight_operation_started_at` を保存する
  - 認証前提検証（`Origin` / `__Host-link_session` / `planId` / Discord参加・権限）を通過した時点で `__Host-link_session` を消費する（以後は成功/失敗に関わらず再利用不可）
  - PAY.JPでcustomer作成（既存あれば再利用）
  - 初回ユーザーは「入会時に選択プランの1ヶ月分を `charge` で即時課金」してから、月次subscriptionを `trial_end = now + 3ヶ月` で作成する（2ヶ月目/3ヶ月目無料）
  - 非初回ユーザーは月次subscriptionを通常作成する（`trial_end` なし）
  - subscription作成時は `metadata.discord_user_id` を保存する
  - `members` をupsert
  - `subscription.current_period_end` を trial適用有無に関係なく `members.next_billing_at` と `members.access_end_at` に保存する
  - 初回無料を適用した場合は `members.first_trial_granted_at` を保存する（一度保存したら解除しない）
  - 初回ロール同期を実行する（最大3回、短時間同期リトライ）
  - 成功時は `members.inflight_operation_*` をクリアする
- 失敗時ポリシー:
  - customer/subscription/charge 作成系APIは自動再試行しない（重複作成リスク回避）
- タイムアウト等の不確定失敗時は `503` を返す（`operationId` を返却し、`members.inflight_operation_*` は保持する。クライアント自動再試行は禁止し、再試行は運用CLIのみとする。`__Host-link_session` は再利用不可のため再OAuth必須）
  - 確定失敗（バリデーション/事前検証失敗）では `members.inflight_operation_*` をクリアして失敗を返す
  - `operationId` は API応答ログ・失敗ログに必ず記録する
- 出力: `{ ok: true, memberId, subscriptionStatus, planId, trialApplied, accessEndAt }`

6. `POST /v1/subscriptions/cancel`
- 目的: 退会申請（定期請求停止 + 終了日までRole維持）
- 入力: `{}`
- 処理:
  - `Origin == FRONTEND_BASE_URL` を必須検証する（不一致/欠落/`Origin: null` は `403`）
  - `__Host-link_session` Cookie を検証し、失効/不正/消費済みは `401` で拒否して再OAuthを要求する
  - ユーザー単位の排他制御として `pg_advisory_xact_lock(hashtext(discord_user_id))` を取得する
  - `members` を取得し、`active/trial/canceled` の既存購読が無ければ409
  - `members.inflight_operation_id` が存在する場合は新規キャンセル処理を開始せず `503` を返す（既存 `operationId` を返却）
  - `members.access_end_at` が未設定の場合は `409` を返し、再同期CLIで状態補正後に再実行する
  - 退会申請の受付開始日時は `access_end_at` の1か月前同日 `00:00:00 JST` とする。該当日が存在しない場合は当月末日に繰り上げる（例: 3/31 -> 2/28 or 2/29）
  - `now_jst < 受付開始日時` の場合は早期申請として `409` を返す
  - 認証前提検証（`Origin` / `__Host-link_session` / 受付期間判定）を通過した時点で `__Host-link_session` を消費する（以後は成功/失敗に関わらず再利用不可）
  - `members.cancel_requested_at` が既存の場合はPAY.JP cancel APIを再実行せず `200` を返す（冪等成功、Cookieは消費済み）
  - PAY.JP書き込み（cancel API）開始前に `operationId` を生成し、`members.inflight_operation_id` / `members.inflight_operation_type=cancel` / `members.inflight_operation_started_at` を保存する
  - PAY.JP subscriptionキャンセルAPIを呼び、次回請求を停止する（即時削除はしない）
  - `members.cancel_requested_at` を記録し、`members.access_end_at` をPAY.JP応答の終了時刻で更新する
  - ロール同期は行わない（終了日到達までは付与維持）
  - 成功時は `members.inflight_operation_*` をクリアする
- 失敗時ポリシー:
  - subscriptionキャンセルAPIは自動再試行しない
- タイムアウト等の不確定失敗時は `503` を返す（`operationId` を返却し、`members.inflight_operation_*` は保持する。クライアント自動再試行は禁止し、再試行は運用CLIのみとする。UIは `operationId` を提示し、再OAuthまたは運用CLI確認へ誘導する）
  - `operationId` は API応答ログ・失敗ログに必ず記録する
- 出力: `{ ok: true, memberId, cancelEffectiveAt, roleRemovalAt }`

7. `POST /v1/payjp/webhook`
- 目的: 課金状態更新
- ヘッダ検証: `X-Payjp-Webhook-Token`
- 処理:
  - `X-Payjp-Webhook-Token` 不一致は `401` を返し、`payjp_events` とは分離したセキュリティログに記録する（`payjp_event_id` 一意領域に入れない）
  - `livemode` が `PAYJP_LIVEMODE` と一致することを検証（不一致は `ignored` 記録して200）
  - `event.type` は `subscription.created/updated/renewed/canceled/deleted/paused/resumed` の許可リストのみ処理し、それ以外は `ignored` 記録して200で受理する
  - `data.object` は `subscription` を必須とし、不一致は `ignored` 記録して200で受理する
  - 必須項目は `event.id` / `event.type` / `event.created` / `data.id` を最小必須とする。`members.subscription_status` を反映するイベント（`created`/`deleted` 以外）は `data.status` も必須とする
  - `subscription.created` は必須項目充足時のみ `ignored` として記録し、必須項目欠落時は `failed` として記録する（`members` は更新しない）
  - `data.metadata.discord_user_id` と `data.id` 逆引きで解決した `discord_user_id` が両方得られる場合は一致必須とし、不一致時は `failed` 記録で `members` 非更新（fail-close）
  - 上記必須項目が欠落/不正な場合、`members` 更新は行わず `failed` 記録して200を返す
  - `event.id` / `event.type` / `event.created` / `livemode` / `data.id` / `data.object` / `data.status` / `data.plan.id` / `data.current_period_end` / `data.metadata.discord_user_id` を `payjp_events` に保存する（`payjp_event_id` unique はトークン検証通過イベントのみに適用）
  - 重複なら何もしないで200
  - 新規イベントは `payjp_events` 記録・`members` 更新・`process_status` 更新を同一処理で実行する（`succeeded/failed/ignored`）
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

共通処理:

1. 受信時に `X-Payjp-Webhook-Token` / `livemode` / `event.type` 許可リスト / `data.object=subscription` を検証する。
2. トークン不一致は `401` を返し、`payjp_events` と分離したセキュリティログへ記録する。
3. 必須項目は `event.id,event.type,event.created,data.id` を最小必須とし、`members.subscription_status` を反映するイベント（`created/deleted` 以外）は `data.status` も必須とする。
4. `event.id` を `payjp_events` へ保存して冪等化する（`payjp_event_id` unique はトークン検証通過イベントのみに適用）。
5. 重複 `event.id` は二重処理せず `200` を返す。
6. `subscription.created` は必須項目欠落時は `failed`、充足時は `ignored` を記録して終了する（`members` は更新しない）。
7. 新規イベント（`created` 以外）は payload の `data` をsubscription本体として扱い、`status/plan/metadata.discord_user_id/current_period_end` を読む。
8. `discord_user_id` はまず `data.metadata.discord_user_id` から取得する。欠落時は対象イベント（`subscription.updated/renewed/canceled/paused/resumed/deleted`）で `data.id`（subscription id）から `members.payjp_subscription_id` を逆引きし、解決できない場合は `failed` として記録する。
9. `data.metadata.discord_user_id` と `data.id` 逆引きが両方解決できる場合は一致必須とし、不一致時は `failed` として記録する（`members` 非更新）。
10. `event.created`（Unix秒）が欠落/不正なイベントは `failed` として記録する。
11. `event.created < members.last_payjp_event_created_at` の場合は順不同到着の古いイベントとして `ignored` にする（状態を巻き戻さない）。`event.created` が同秒の場合は到着順で処理し、最終整合は日次再同期で補正する。
12. `subscription.deleted` は `event.type` で判断し、`data.status` によらず `members.subscription_status = deleted` として扱う。その他イベントは `data.status`（`active/trial/canceled/paused`）を `members.subscription_status` に反映する。
13. `data.plan.id` が取得できた場合のみ `members.payjp_plan_id` を更新する。
14. `data.current_period_end` は取得できた場合のみ `members.next_billing_at` に保存する。`status=active/trial/canceled` の間は同値を `members.access_end_at` にも保存する（アクセス保証終了時刻）。
15. `ignored` 以外で処理したイベントは `status` 不変でも `members.last_payjp_event_created_at = event.created` を更新する。
16. `status` 不変の `subscription.updated` でも `payjp_plan_id` と `next_billing_at/access_end_at` の更新は行う。Role同期のみ省略できる。
17. 状態に応じてDiscordロール同期を実行する。
18. Discord API `429/5xx` は短時間の同期リトライを最大3回行い、最終失敗時は `process_status = failed` を記録する。
19. 必須項目欠落や検証失敗時は fail-close（`members` 非更新）とし、`failed` を記録する（DB障害以外は `200`）。

注記:

1. Webhook受信ごとの PAY.JP `event.id` 再取得照合はMVPでは実施しない（リリース後拡張）。
2. 分単位以上の待機を伴う再試行はWebhook内で実施しない（PAY.JP再送と二重処理リスクを避ける）。

## 6.4 Discordロール同期ルール

1. `active` / `trial` / `canceled` のとき付与する。
2. `canceled` は `access_end_at` 到達までは付与を維持し、`subscription.deleted` 到達時は即時剥奪する。Webhook欠落時は次回日次再同期で `access_end_at` 超過を補正して剥奪する。
3. `paused` / `deleted` / 不明ステータスは剥奪する。
4. APIエラー時は短時間の同期リトライを最大3回実行する。長時間待機は行わず、失敗時は再同期へ回す。
5. `payjp_plan_id` はRole判定に使わない（3プランでもRoleは共通）。

## 6.5 解約時ポリシー（MVP）

1. 退会申請時はPAY.JP subscriptionキャンセルAPIで定期請求を停止する（即時削除はしない）。
2. 退会申請後も `access_end_at` 到達まではRoleを維持する（即時剥奪しない）。
3. `access_end_at` 到達時点でRoleを剥奪する（Webhook `subscription.deleted` 到達時は即時、Webhook欠落時は次回日次再同期で補正）。
4. 退会申請の受付開始日は `access_end_at` の1か月前同日 `00:00:00 JST` とし、それ以前の早期申請は拒否する。
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

## 7. データモデル（最小）

## 7.1 `members`

- `id` (uuid, pk)
- `discord_user_id` (text, unique)
- `email` (text)
- `payjp_customer_id` (text, null許可, NOT NULL時のみunique)
- `payjp_subscription_id` (text, null許可, NOT NULL時のみunique)
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

詳細実装は `6.2` / `6.3` を正とし、ここではP0のみを固定する。

1. OAuth callbackで `state + __Host-oauth_session + 未使用 + TTL内` を1トランザクションで検証/消費する。
2. OAuth連携Cookieは `__Host-oauth_session`、課金連携Cookieは `__Host-link_session` を使用し、後者はTTL 15分のワンタイムとする。
3. `__Host-link_session` は認証前提検証通過後かつPAY.JP書き込み前に消費し、成功/失敗に関わらず再利用不可とする。
4. OAuth/linkトークンはURLに載せない（Cookieのみ）。
5. `POST /v1/subscriptions` / `POST /v1/subscriptions/cancel` は `Origin == FRONTEND_BASE_URL` を必須化し、欠落/不一致/`Origin: null` は `403` で拒否する。
6. Cookieベース連携を成立させるため、本番はフロントとAPIを同一サイト（同一eTLD+1）に配置する。
7. `POST /v1/subscriptions` の課金実行前にDiscord参加状態とBotのロール付与可能性を検証し、不成立時は課金しない。
8. `createToken` の `three_d_secure: true` を必須化し、本番の購読作成は3-Dセキュア `verified` トークンのみ受け付ける。
9. customer/subscription/charge/cancel のPAY.JP書き込みAPIは自動再試行しない。
10. 不確定失敗（タイムアウト等）は `503 + operationId` を返し、クライアント自動再試行は禁止する。
11. 不確定失敗に備え、PAY.JP書き込み前に `members.inflight_operation_id/type/started_at` を保存し、成功時のみクリアする。
12. `members.inflight_operation_id` が残っている間は課金/解約APIを再実行せず `503` とし、解除は再同期CLIのみで行う。
13. 購読作成・退会申請APIでは `pg_advisory_xact_lock(hashtext(discord_user_id))` によるユーザー単位排他を取得する。
14. Webhookはトークン検証を必須化し、不一致は `401` を返して `payjp_events` と分離したセキュリティログへ記録する。
15. Webhookは `livemode` / `event.type` 許可リスト / `data.object=subscription` を検証する。
16. Webhookの最小必須項目は `event.id,event.type,event.created,data.id` とし、状態反映イベントは `data.status` も必須とする。欠落・不正入力は fail-close（`members` 非更新）で `failed` 記録とする。
17. `subscription.created` は必須項目欠落時のみ `failed`、充足時は `ignored` とする。
18. `event.id` の冪等化（トークン検証通過イベントのみ）と `event.created` 新旧判定を実施し、古いイベントで会員状態を巻き戻さない。
19. `data.metadata.discord_user_id` と `data.id` 逆引きが両方解決できる場合は一致必須とし、不一致時は `failed` とする。
20. カード情報を保存・ログ出力しない。機密値は固定キーでマスクし、`/v1/payjp/webhook` と認証/課金APIで raw header/body をログ保存しない。
21. `callback` / `session` 応答は `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を必須とする。
22. `planId` は `PAYJP_PLAN_IDS` の許可リスト照合を必須化し、購読作成APIで不正値を拒否する。
23. 初回無料適用は `discord_user_id` 単位で一度のみ許可し、`first_trial_granted_at` を保存する。

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
- 日次1回（JST）で実行する（実行時刻は運用設定で固定し、仕様で固定しない）
- 全会員を対象にPAY.JP状態とDiscordロールを再照合
- PAY.JPのsubscription取得で `404` を返した会員は `deleted` とみなしてロール剥奪対象にする
- `access_end_at` 超過（`canceled`/`trial` の終了到達）会員はロール剥奪対象として再同期する
- 障害対応として同じ再同期処理を運用CLIから手動実行可能にする（公開HTTP endpointは設けない）
- 手動再同期CLIは `operationId` または `discord_user_id` 指定で対象会員を再同期できる
- `inflight_operation_*` 残留時は「`operationId` 突合 -> PAY.JP現状態確認 -> `members` 反映 -> Discordロール再同期 -> `last_payjp_event_created_at = max(既存値, 再同期開始Unix秒)` 更新」を1実行で行う（この反映後に到着した `event.created` がそれ未満の遅延Webhookは `ignored` としてよい）
- `inflight_operation_*` はPAY.JP現状態と `members` 整合が確認できた場合のみ解除する。PAY.JP状態が確定不能な場合は解除しない
- 手動再同期CLIは実行結果として `failed_count` を必須出力する
- `failed_count` は未解決の会員影響件数を表し、完了判定は `failed_count=0` のみを必須とする

2. 期限切れデータ掃除ジョブ
- 日次1回で `oauth_states` / `discord_link_sessions` の期限切れ行を削除

## 11. 開発スケジュール（〜2026-04-20）

- 機能凍結日: 2026-04-16（Day 9 終了時）
- リリース実行日: 2026-04-20

## Week 1

1. Day 1（2026-04-06）
- プロジェクト雛形
- DBマイグレーション（4テーブル）
- 環境変数管理
- 静的1ページの骨組み（UI最小、文言のみ）
- 本番外部依存の事前確認を開始（PAY.JP本番キー、Webhook設定、Discordアプリ/OAuth設定、Role序列確認）
- 「初回1ヶ月目課金 + 2/3ヶ月目無料」の課金フローを確定（charge + subscription trial の分離）
- 本番DB反映手順（migration適用 -> `/health` -> 主要API疎通）を文書化開始する
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
- 本番外部依存の確認を実施する（PAY.JP本番キー投入可否、Webhook URL/トークン設定、Discord OAuth redirect設定、Bot Role序列確認）。P0 blocker が未完了の場合は Day4 着手前に解消または暫定回避策を確定し、未完了項目はリスクとして記録する
- `operationId` 共通ログ出力（API応答/失敗ログ）を実装

4. Day 4（2026-04-09）
- `POST /v1/subscriptions` コア実装（3プラン選択でPAY.JP顧客/購読作成）
- `planId` 許可リスト検証実装
- 初回「1ヶ月目課金 + 2/3ヶ月目無料」判定（`discord_user_id` 単位）実装
- ユーザー単位ロック（advisory lock）+ 既存有効契約ガード（`canceled && access_end_at > now` のみ新規作成拒否）
- `members` 仮行作成 + `inflight_operation_*` 保存/クリアを実装
- `__Host-link_session` の認証前提検証後消費を実装
- P0テスト（代表1プランE2E、残り2プラン設定整合、並列登録、既存契約ガード）を実装

5. Day 5（2026-04-10）
- 3-Dセキュア必須フロー（`verified` のみ受理）
- PAY.JP Token再取得検証（`used=false` + 3DS状態）
- 3Dセキュア中断/失敗/タイムアウト時の失敗表示 + 再試行導線を実装
- `subscription.current_period_end` の `next_billing_at/access_end_at` 反映をtrial有無に関係なく実装
- 不確定失敗時の `503 + operationId` 契約（自動再試行禁止、`inflight_operation_*` 保持）を実装

## Week 2

1. Day 6（2026-04-13）
- `POST /v1/subscriptions` 仕上げ（課金前Discord参加チェック + ロール付与可能性チェック + 初回ロール同期）
- `POST /v1/subscriptions/cancel` 実装（請求停止 + 終了日までRole維持 + `cancel_requested_at` 冪等成功）
- 作成系PAY.JP APIの「自動再試行しない」失敗ハンドリング実装
- 退会受付の「1か月前同日 00:00 JST（存在しない日は月末繰上げ）」判定を実装
- P0テスト（退会後再加入時の trial 再適用なし）を実装
- 機密マスキング（固定キー）と raw header/body ログ禁止を実装
- P0テスト（課金前Discord未参加/権限不足拒否、cancel境界・冪等）を実装

2. Day 7（2026-04-14）
- Webhook受信 + 冪等化
- `subscription.created/updated/renewed/canceled/deleted/paused/resumed` の最小イベント処理
- `event.created` の新旧判定実装（古いイベント無視）
- Webhook最小必須項目（`event.id/event.type/event.created/data.id` + 状態反映時 `data.status`）検証を実装
- `metadata.discord_user_id` と `data.id` 逆引きの一致必須チェックを実装
- `access_end_at` 更新（`active/trial/canceled`）と終了日ロール剥奪判定実装
- `subscription.created` の「必須項目欠落時 failed / 充足時 ignored」を実装
- `subscription.updated` の `status` 不変時でも `plan/current_period_end` 反映を実装（Role同期は省略可）
- P0テスト（Webhook fail-close最小セット、重複/古いイベント/逆引き不一致、`paused/deleted` 剥奪）を実装

3. Day 8（2026-04-15）
- 日次再同期ジョブ
- 手動再同期CLI
- OAuth/Linkセッション期限切れ掃除（日次）
- 運用手順ドラフト作成（再同期CLI手順、手動ロール剥奪手順）
- 手動再同期CLIの完了条件出力（`failed_count`）を実装
- P0テスト（`503` 不確定失敗の代表ケース + cancel `503` 復旧）を実装
- P0テスト（`access_end_at` 到達の代表ケース、Webhook整合）を実装
- 503復旧オペの運用CLIリハーサルを1回実施する

4. Day 9（2026-04-16）
- `12.1` のGo-Live必須テストを1回実行し、失敗修正後は「修正影響範囲 + 二重課金系 + 503整合系 + `access_end_at` 境界」を再実行してPassさせる（Day9出口条件）
- 日次再同期ジョブを1回実行し、成功ログを受け入れ証跡として保存する
- Day10本番スモークの事前準備として設定凍結チェックを実施する（Webhook token/livemode、OAuth設定、Role序列）
- Day8ドラフトの運用文書へDay9修正内容を反映し、最終版を固定する
- Day9終了時点で機能凍結し、新規機能追加を停止する

5. Day 10（2026-04-17）
- バッファ（最終不具合修正・Go/No-Go判定）を先に実施する
- 本番環境変数投入
- migration適用 -> `/health` -> 主要API疎通（OAuth/session/subscriptions/cancel/webhook）を確認する
- 本番最小スモーク（Webhook token/livemode、OAuth→登録→cancel）を1回実施する（cancel は受付期間外 `409` または受付期間内 `200` のいずれか期待どおりで成功とする）
- Go/No-Go判定を確定し、2026-04-20のリリース実行に備える

## 12. テスト要件（P0必須）

### 12.1 P0（Go-Live必須: 7件）

1. OAuthは `state + __Host-oauth_session + 未使用 + TTL内` の原子的検証/消費が行われる。代表失敗ケース（`state` 不一致）で認可失敗し、callback/session で `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を返す。
2. `POST /v1/subscriptions` は `PAYJP_PLAN_IDS` 3プランに対応し、代表1プランで実課金E2E成功、残り2プランは設定整合テスト（実課金不要）で登録成功を確認する。`members.payjp_plan_id` 保存とRole付与が行われ、退会後再加入時は `first_trial_granted_at` が保持され trial 再適用なしとなる。Discord未参加時は `409`、Bot権限不足またはRole序列不足時は `503` で課金前に失敗する（いずれもPAY.JP APIは呼ばれない）。
3. 同一 `discord_user_id` への並列 `POST /v1/subscriptions` で二重購読が作成されず、`charge=1` / `subscription=1` が保たれる。既存 `active/trial` または `canceled && access_end_at > now` の契約では新規作成されない。
4. 不確定失敗（`503`）の代表ケース（`charge` 後の `subscription` 不確定）を検証し、運用CLIで `charge=1` / `subscription=1` を維持し、`operationId` で追跡できる。
5. `POST /v1/subscriptions/cancel` は受付開始日前を `409` で拒否し、`cancel_requested_at` 既存時はPAY.JP再呼び出しなしで冪等成功（200）となる。`503` 不確定失敗後は `operationId` 確認 + 再同期で整合回復でき、`access_end_at` 未設定時は `409` で再同期要求になる。
6. `access_end_at` 到達時にRoleが除去される（Webhookまたは日次再同期）。`paused/deleted` 到達時の剥奪も確認する。
7. Webhookで `event.id` 重複送信は二重処理されず、`event.created` が古いWebhookは `ignored` となり会員状態が巻き戻らない。`metadata.discord_user_id` と `data.id` 逆引き不一致・必須項目欠落は `failed` で `members` 非更新、トークン不一致は `401`、`subscription.created` は必須項目欠落時 `failed` / 充足時 `ignored` とする。

## 13. 運用ルール（MVP）

1. 毎朝、前日失敗ログ件数を確認する。
2. 手動再同期CLIの `failed_count`（当該CLI実行対象の未解決会員影響件数）が0でない場合は、同日中に再同期と手動復旧を継続する。
3. 再同期の完了条件は「`failed_count = 0`」とする。
4. 課金作成API/退会申請APIでタイムアウト等の不確定失敗（`503`）が発生した場合は、`operationId` をキーにPAY.JP現状態を確認してから再同期CLIを実行する（クライアント自動再試行は禁止。再試行は運用CLIのみ）。
5. `members.inflight_operation_id` が残っている間は同一ユーザーの課金/解約APIを再実行しない。`inflight_operation_started_at` から30分超過時は、`operationId` 突合 -> PAY.JP状態確認 -> `members` 反映 -> `last_payjp_event_created_at` 単調増加更新を完了した場合のみ `inflight_operation_*` を解除できる。
6. 緊急時手順として手動剥奪を定義し、実施条件・手順・確認方法を運用文書に固定する。
7. OAuth失敗率が高い場合は `redirect_uri` とクライアント設定を再確認する。
8. 重大障害（課金不整合/ロール未反映）が判明した場合は当日中に手動復旧を実施する。
9. `access_end_at` が当日到達する退会申請ユーザーを毎日確認し、Role除去漏れがあれば当日中に手動再同期で補正する。
10. 2026-04-20 までに必須の運用文書は「再同期CLI手順」「手動ロール剥奪手順」の2点に限定する。

## 14. 受け入れ条件（Go-Live）

各受け入れ項目の証跡は「実施日時 / テストIDまたは実行コマンド / 結果」を必須とし、`CI実行ID` または `主要ログ1件` のいずれか1つを添付する。

1. Day9で `12.1` の7件を1回実行してPassしている。不具合修正後は「修正影響範囲 + 12.1-3 + 12.1-4 + 12.1-6」を再実行してPassしている。
2. Day10に本番最小スモーク（Webhook token/livemode、OAuth→登録→cancel）を1回実施し、cancel は受付期間外 `409` または受付期間内 `200` のいずれか期待どおりで成功している。
3. 手動再同期CLIの実行で `failed_count=0` を確認済みで、`members.inflight_operation_id` 残留0件を確認している。
4. 2026-04-20時点の運用文書として「再同期CLI手順」「手動ロール剥奪手順」が最終化されている。
5. 本番反映時に `migration適用 -> /health -> 主要API疎通`（OAuth/session/subscriptions/cancel/webhook）を確認済み。
6. 機密マスキング（固定キー）と raw header/body 非出力がログ/レスポンスで確認済み。
7. 日次再同期ジョブのスケジュールが有効化済みで、直近1回の成功ログを確認済み。

## 15. 将来拡張（リリース後）

1. 管理画面（会員検索/再同期/手動修復）
2. 監視高度化（外部監視SaaS、メトリクス可視化、SLO化）
3. プラン別Role分岐（料金プラン別Role要件が確定した時点で実装）
4. 会員ポータル化（解約/カード変更）
5. プラン変更API（次回更新時反映/即時反映）
6. `Idempotency-Key` 再利用時の `request_hash` 不一致チェック（不正再送検知）
7. `subscription_request_keys` テーブルによるレスポンス再返却（不確定失敗時の安全再実行）
8. Webhook `event.created` の厳密な時刻ドリフト補正と同秒競合解決（tie-break規則）
9. ロール同期の非同期ジョブキュー化
10. PAY.JP標準挙動を超える独自の期間末猶予アクセス（grace period）
11. Webhook受信ごとの PAY.JP `event.id` 再取得照合
12. `subscription.created` Webhookによる補償upsert再導入（`event.id` 再取得照合導入後）
13. 課金失敗/ロール剥奪時のユーザー自動通知（DM/メール）
14. Webhook失敗イベントのDLQ（遅延再処理キュー）
15. 運用者向けread-only会員状態確認API（`discord_user_id` 検索）
16. Webhook送信元IP許可リスト
17. 秘密鍵ローテーション自動化（KMS/Secret Manager連携）
18. 不正利用検知（短時間の失敗集中・国別異常）
19. Webhookバースト耐性試験（重複・順序乱れ・遅延の高負荷）
20. Discord API障害注入（429/5xx/timeout）での回復試験
