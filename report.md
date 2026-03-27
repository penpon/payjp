# PAY.JP × Discord 定期課金連動サービス 事前調査レポート

- 作成日: 2026-03-27
- 対象構成: 独自ドメイン + Cloudflare Pages（フロント）+ WebARENA Indigo（API/Webhook）
- 目的: 「フロントはシンプル、バックエンドは商用品質・高セキュリティ」の実現可能性を検証

## 1. エグゼクティブサマリー

本調査の結論は、以下の通りです。

1. 提案構成は現実的で、150ユーザー規模に対して十分実装可能。
2. WordPressを決済導線から除外する判断は妥当。
3. Cloudflare Pagesは静的配信用途であれば無料枠で開始可能。
4. WebARENA Indigo 4GBはコスト効率が高く初期構成として成立。
5. ただし「金融レベルの商用品質」を満たすには、カード情報非保持・Webhook冪等化・再同期・監査ログ・復旧設計が必須。

現状案は「低コストで強いMVP」までは妥当ですが、運用要件（障害時整合性維持）を加えて初めて商用品質に到達します。

## 2. 要件整理（確定済み）

- 課金モデル: 定期課金中心
- 連携対象: Discordコミュニティ（ロール制御）
- 失効方針: 課金停止時にロールを即時剥奪
- フロント: 簡素ページで可
- バックエンド: センシティブ情報を扱うため、セキュリティ最優先
- WordPress: 今回は非採用

## 3. 技術実現性調査

### 3.1 PAY.JP

- Webhookによりイベント通知が可能。
- Webhook受信側は `POST` を受け取り `200` 応答が必要。
- 失敗時は3分間隔で最大3回再送。
- 多重送信・遅延・欠落を想定した設計が必要。
- `X-Payjp-Webhook-Token` ヘッダで正当性検証が可能。
- 定期課金イベントとして `subscription.created/paused/resumed/canceled/renewed` などが存在。
- 定期課金ステータスは `trial/active/canceled/paused`。
- `current_period_end` の時刻ちょうど更新は保証されず、状態判定は `status` 中心が推奨。
- 3Dセキュア導入に関するガイド・要件あり。

### 3.2 Discord

- Webhookはメッセージ送信用途であり、ロール付与/剥奪はできない。
- ロール制御は Guild Member Role API（Bot + `MANAGE_ROLES`）が必要。
- ユーザー紐付けは OAuth2 `identify` を使うのが安全。
- OAuth2では `state` 検証が必須（CSRF対策）。
- レート制限はヘッダベースで動的制御する必要。
- 本要件（課金連動ロール制御）では、常時接続のGateway Botは必須ではない。
- ただしBotアカウント自体は必須で、バックエンドからBotトークンでDiscord REST APIを呼ぶ実装が必要。
- Botロールは対象有料ロールより上位に配置しないと付与/剥奪が失敗する。

### 3.3 インフラ（Cloudflare Pages + Indigo）

- Cloudflare PagesはFreeプランで静的配信に十分。
- 静的配信と機密APIを分離すると攻撃面が縮小。
- Indigo 4GBは小規模〜中規模初期運用に対してコスト効率が高い。
- ただしIndigo単体はSLA/運営バックアップの性質上、障害復旧設計を別途実装する必要。

## 4. 現実性評価（採点）

### 4.1 実装可能性

- 判定: 高
- 理由: 必要なAPI/Webhook/OAuth2がすべて標準仕様で揃っている。

### 4.2 コスト妥当性

- 判定: 高
- 理由: フロント無料枠 + 低価格VPSで初期コストを抑制可能。

### 4.3 セキュリティ妥当性

- 判定: 条件付きで高
- 条件: 下記「必須追加設計」を満たすこと。

### 4.4 運用耐性

- 判定: 中（現状）
- 改善後: 高
- ボトルネック: Webhook不整合、外部API障害時リカバリ、証跡管理。

## 5. 推奨アーキテクチャ（商用品質前提）

1. `pay.example.com`:
   - Cloudflare Pages
   - 静的フロント（課金導線、連携状態表示）

2. `api.example.com`:
   - Indigo上のAPIサーバ
   - PAY.JP Webhook受信
   - Discordロール制御
   - OAuth2コールバック処理
   - Botトークンを使ったDiscord REST API実行（常駐Gateway不要）

3. データストア:
   - ユーザー/Discord紐付け
   - サブスク状態スナップショット
   - Webhookイベント冪等テーブル
   - 監査ログ

4. 非同期処理:
   - Webhookは即時ACK（200）
   - 本処理はジョブキューで実行
   - 失敗時は指数バックオフ + DLQ

5. 再同期ジョブ:
   - 定期的にPAY.JP状態を取得
   - Discordロール状態との差分修復

## 6. レッドチーム観点の脅威と対策

### 6.1 Webhook偽装・リプレイ

- リスク: 不正イベントでロール操作される。
- 対策:
  - `X-Payjp-Webhook-Token` 検証
  - 受信時刻・イベントID記録
  - イベントID冪等化（再処理禁止）
  - レート制限とWAF適用

### 6.2 順不同・重複イベント

- リスク: 最新状態が上書きされ誤付与/誤剥奪。
- 対策:
  - 状態遷移ガード
  - 冪等キー + 楽観ロック
  - 再同期バッチで最終整合

### 6.3 OAuth2連携悪用

- リスク: アカウント紐付け乗っ取り。
- 対策:
  - `state` 検証必須
  - リダイレクトURI固定
  - コールバック1回性トークン

### 6.4 Bot権限過多・秘密漏えい

- リスク: 侵害時の被害拡大。
- 対策:
  - Bot権限最小化
  - 秘密情報の外部管理（環境分離）
  - 定期ローテーション

### 6.5 障害時の整合性喪失

- リスク: 課金停止後もロール残存。
- 対策:
  - 失敗キュー監視
  - 自動再試行
  - 手動再実行手順
  - 日次差分修復

## 7. 商用品質に必要な最低実装チェックリスト

1. セキュリティ
- [ ] Webhookトークン検証
- [ ] OAuth2 `state` 検証
- [ ] API入力バリデーション
- [ ] TLS強制・HSTS
- [ ] 機密情報ローテーション
- [ ] Discord Botトークンの安全保管と最小権限化（`MANAGE_ROLES`）

2. 整合性
- [ ] Webhook冪等化テーブル
- [ ] 非同期キュー処理
- [ ] 失敗時DLQ
- [ ] 再同期ジョブ
- [ ] バックエンド経由のDiscord REST APIロール同期（Gateway非依存）の疎通確認

3. 監査・運用
- [ ] 監査ログ（イベントID、ユーザーID、ロール変更、結果）
- [ ] アラート（連続失敗、DLQ蓄積、再同期差分増加）
- [ ] 復旧Runbook

4. 可用性
- [ ] バックアップ運用（DBスナップショット/リストア訓練）
- [ ] 障害時フェイルセーフ方針（安全側に倒す）

## 8. お金周りのセキュリティ担保要件（確定）

### 8.1 決済データの責務境界

- 金銭データ（カード番号/CVC/完全な有効期限）はPAY.JP管理とし、自社システムに保存しない。
- カード情報は `Checkout` または `payjp.js` で直接PAY.JPへ送信し、自社バックエンドを通過させない。
- 自社側で扱うのは `token` / `customer_id` / `subscription_id` / `status` / 監査情報に限定する。

### 8.2 保存してよいデータ / 禁止データ

- 保存可: `payjp_customer_id`, `subscription_id`, `subscription.status`, `discord_user_id`, 処理結果ログ。
- 保存禁止: カード番号、CVC、完全な有効期限、秘密鍵平文、OAuthアクセストークンの長期平文保存。
- ログ禁止: リクエストボディ中の機密値をそのまま出力すること。

### 8.3 課金有効性の判定ルール

- 課金の真実源はPAY.JPの `subscription.status` とする。
- `active` のときのみDiscord有料ロールを付与・維持する。
- `paused` / `canceled` は即時剥奪対象とする。
- Webhook未達や遅延を前提に、定期再同期ジョブで最終整合を担保する。

### 8.4 受け入れ基準（お金周り）

- [ ] 本番ログにカード情報・CVC・秘密鍵が一切出力されない。
- [ ] Webhook同一 `event.id` の再送でロール変更が重複実行されない。
- [ ] Webhookを意図的に1件欠落させても、再同期ジョブでDiscordロールが正状態へ戻る。
- [ ] `subscription.status=active` 以外で有料ロールが残存しない。
- [ ] 3Dセキュア要件を満たす導線のみ本番有効化されている。

## 9. 結論

- 現在の構成案は、要件に対して十分現実的。
- 特に「Cloudflare Pages（静的） + Indigo（機密処理）」の責務分離は適切。
- ただし、金融レベルの品質目標を満たすには、
  - Webhook冪等化
  - 非同期再試行
  - 再同期バッチ
  - 監査証跡
  の4点を実装必須条件として扱うべき。

この4点を満たせば、150人規模のDiscord課金コミュニティ運用として、実務上十分に堅牢な構成になります。

## 10. やるべきこと（優先順位）

単独運用（開発者兼保守運用者が1名）を前提に、以下の順で実施する。

1. 最優先: 課金開始APIの冪等化
- 金銭事故（重複課金）を直接防ぐ最重要項目。
- `POST /v1/subscriptions` に冪等キーを導入し、同一要求の再送で課金処理を1回に固定する。

2. 最優先: 最小監視アラートの実装
- 障害を「気づけない」状態を防ぐ。
- 初期アラートは `DLQ > 0` / `Webhook処理失敗連続` / `再同期差分 > 0` の3点に限定する。

3. 最優先: DBバックアップ + 復元手順の固定化
- 単独運用では「復旧できること」が可用性の中核。
- 日次バックアップと、月1回の復元テストを必須運用にする。

4. 次点: internal再同期APIの防御強化
- Secret検証だけでなく、実行元制限（IP制限・閉域・Cron専用経路）を追加する。

5. 後回し可: 監査ログ保持期間/権限制御の詳細化
- 初期運用を回しながら、保持期間・閲覧権限・削除方針を段階的に明文化する。

6. 後回し可: 3Dセキュア日付表現の更新
- 重要だが、直近の実害リスクは上位項目より低い。
- 外部監査や説明で誤解が出ないよう、日付表現は最新要件に合わせる。

## 11. 参照ソース

- PAY.JP Webhook: https://docs.pay.jp/v1/webhook
- PAY.JP Subscription: https://docs.pay.jp/v1/subscription
- PAY.JP API: https://docs.pay.jp/v1/api/
- PAY.JP CardToken: https://docs.pay.jp/v1/cardtoken
- PAY.JP 3Dセキュアガイド: https://docs.pay.jp/v1/guideline-payjp-three-d-secure
- PAY.JP 導入指針: https://docs.pay.jp/v1/payjs-guidance
- PAY.JP Checkout: https://docs.pay.jp/v1/checkout
- Discord Webhook: https://docs.discord.com/developers/resources/webhook
- Discord Guild API: https://docs.discord.com/developers/resources/guild
- Discord OAuth2: https://docs.discord.com/developers/topics/oauth2
- Discord Rate Limits: https://docs.discord.com/developers/topics/rate-limits
- Cloudflare Pages Limits: https://developers.cloudflare.com/pages/platform/limits/
- Cloudflare Pages Functions Pricing: https://developers.cloudflare.com/pages/functions/pricing/
- Cloudflare Workers Pricing: https://developers.cloudflare.com/workers/platform/pricing/
- WebARENA Indigo Price: https://web.arena.ne.jp/indigo/price/
- WebARENA Indigo Security: https://web.arena.ne.jp/indigo/spec/security.html
- WebARENA Indigo Data Protection: https://web.arena.ne.jp/indigo/spec/dataint.html
