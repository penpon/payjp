# PAY.JP × Discord 連携サービス 開発仕様書（TypeScript統一 / TDD前提）

- 作成日: 2026-03-28
- 対象: 150ユーザー規模のDiscord有料コミュニティ運用
- 構成: Cloudflare Pages（Frontend）+ Indigo（Backend API/Webhook）
- 方針: フロント/バックエンドともTypeScript、テスト駆動開発、商用品質のセキュリティ実装

## 1. 目的

本仕様書は、以下を満たす実装着手用ドキュメントである。

1. フロントエンド仕様が明確で、画面実装を開始できる。
2. バックエンド仕様が明確で、API/Webhook/ジョブ実装を開始できる。
3. TDDで進めるためのテスト戦略とDoD（Definition of Done）が明確である。
4. 運用時の整合性（Webhook欠落・外部API障害時）を担保する。

## 2. 開発原則

1. `subscription.status == active` のときのみ有料ロールを付与・維持する。
2. Webhookは必ず「即時200応答 + 非同期処理」で取り扱う。
3. Webhookイベントは `event.id` で冪等化し、重複処理を防止する。
4. PAY.JP/Discordを真実源として、定期再同期ジョブで最終整合を担保する。
5. カード情報（番号/CVC/完全有効期限）は自社で保持・ログ出力しない。
6. すべての機能は先に失敗テストを書く（Red-Green-Refactor）。

## 3. 採用技術スタック

## 3.1 共通

- 言語: TypeScript（strictモード）
- パッケージ管理: pnpm
- リポジトリ形態: Monorepo（pnpm workspace）
- Lint/Format: ESLint + Prettier
- Git運用: Conventional Commits + PRベース

## 3.2 フロントエンド（Cloudflare Pages）

- ランタイム: Browser（静的配信）
- フレームワーク: React + Vite + TypeScript
- UI: Tailwind CSS（必要最低限）
- フォーム検証: React Hook Form + Zod
- API通信: TanStack Query + fetch wrapper
- E2E: Playwright
- 単体/コンポーネントテスト: Vitest + Testing Library

## 3.3 バックエンド（Indigo）

- ランタイム: Node.js 22 LTS
- Webフレームワーク: Fastify
- バリデーション: Zod
- DB: PostgreSQL 16
- ORM: Prisma
- ジョブキュー: pg-boss（PostgreSQLベース、DLQ対応）
- HTTPクライアント: undici
- ログ: pino（JSON構造化ログ）
- テスト: Vitest + Supertest + Testcontainers

## 4. ディレクトリ仕様（Monorepo）

```text
/apps
  /web                 # フロントエンド
  /api                 # バックエンド
/packages
  /shared              # 型・ドメインルール・共通バリデーション
  /config              # tsconfig/eslint/prettier共通設定
  /test-kit            # テストユーティリティ（factory, fixtures）
/infrastructure
  docker-compose.yml   # local(Postgres)起動用
/docs
  payjp-discord-development-spec.md
```

## 5. ユースケース定義

1. ユーザーがDiscord連携し、支払い情報を登録して購読開始する。
2. PAY.JPのWebhookイベントで購読状態を更新する。
3. 状態更新に応じてDiscord有料ロールを付与/剥奪する。
4. Webhook遅延/欠落/重複があっても再同期ジョブで正状態に戻す。
5. 管理者が監査ログで処理履歴を追跡できる。

## 6. フロントエンド仕様

## 6.1 画面一覧

1. `/` ランディング
- サービス説明
- 「Discord連携」ボタン

2. `/connect` 連携開始/状態確認
- Discord連携済みか表示
- 未連携時にOAuth2開始

3. `/billing` 課金登録
- プラン表示（単一プランでもUI上は抽象化）
- PAY.JP入力フォーム（payjp.js/Checkout）
- 購読開始実行

4. `/membership` 会員状態
- 課金状態（active/paused/canceled/trial）
- Discordロール同期状態
- 最終同期時刻

5. `/billing/result` 決済結果
- 成功/失敗表示
- 再試行導線

## 6.2 フロント状態モデル

- `authState`: `anonymous | discord_linked`
- `subscriptionState`: `none | trial | active | paused | canceled`
- `roleState`: `granted | revoked | syncing | error`

## 6.3 フロントAPI呼び出し仕様

1. `GET /v1/me`
- 目的: Discord連携状態、購読状態を取得

2. `GET /v1/auth/discord/start`
- 目的: OAuth2認可URL取得またはリダイレクト

3. `POST /v1/subscriptions`
- 目的: 購読開始
- body: `{ planId: string, payjpToken: string }`

4. `POST /v1/subscriptions/cancel`
- 目的: 購読停止

5. `GET /v1/subscriptions/current`
- 目的: 最新購読状態を取得

## 6.4 フロントセキュリティ要件

1. PAY.JP公開鍵のみフロントに保持。秘密鍵は保持しない。
2. カード情報をアプリログ・analyticsに送信しない。
3. OAuth2 `state` はバックエンド発行値を必ず利用。
4. APIエラー時は内部詳細をUI表示しない（ユーザ向け文言へ変換）。
5. 本番の決済導線はEMV 3-Dセキュア対応フロー（PAY.JP 3Dセキュア有効）に限定する。

## 6.5 フロント受け入れテスト（E2E）

1. Discord未連携ユーザーが連携を完了できる。
2. 有効なPAY.JPトークンで購読開始できる。
3. `active` 以外では有料会員表示にならない。
4. API失敗時に再試行導線が表示される。

## 7. バックエンド仕様

## 7.1 APIエンドポイント

1. `GET /health/liveness`
- 常時200（プロセス生存確認）

2. `GET /health/readiness`
- DB接続/キュー接続を確認

3. `GET /v1/auth/discord/start`
- Discord OAuth2開始
- stateを生成し、一時保存後に認可URLへリダイレクト

4. `GET /v1/auth/discord/callback`
- `state` 検証
- DiscordユーザーID取得
- `users` と紐付け作成/更新
- フロントへリダイレクト

5. `GET /v1/me`
- ログインユーザーの連携・購読・ロール同期状態を返す

6. `POST /v1/subscriptions`
- 入力: `planId`, `payjpToken`
- 処理: PAY.JPでcustomer/subscription作成
- 出力: 作成結果と現在状態

7. `POST /v1/subscriptions/cancel`
- PAY.JP購読停止
- 即時でDiscordロール剥奪ジョブを積む

8. `GET /v1/subscriptions/current`
- DB上の最新購読状態を返す

9. `POST /v1/payjp/webhook`
- `X-Payjp-Webhook-Token` 検証
- イベント冪等保存（`event.id` unique）
- 非同期ジョブ投入
- 即時200

10. `POST /v1/internal/reconcile/run`
- Cron専用（Secret必須）
- 再同期ジョブを起動

## 7.2 Webhook処理仕様

1. 受信時に署名/トークン検証。失敗は `401`。
2. `event.id` を `webhook_events` に `INSERT`。
3. unique違反なら重複イベントとして `200` 返却（再処理しない）。
4. 正常登録時に `process-payjp-event` ジョブを投入。
5. WorkerでPAY.JPから対象subscriptionを再取得し、DBを最新化。
6. 状態差分があれば `sync-discord-role` ジョブを投入。
7. 成功/失敗を監査ログに記録。

## 7.3 Discordロール同期仕様

1. 判定ルール: `active` のときのみロール付与。
2. `paused/canceled/trial/none` は剥奪。
3. Discord API呼び出しはレート制限ヘッダを解釈し、`429` 時は `Retry-After` に従う。
4. 同一ユーザーへの同時同期を防ぐため、`user_id` 単位で排他制御。
5. 失敗時は指数バックオフ（例: 1m, 5m, 15m, 1h）で再試行。
6. 規定回数超過でDLQへ移送、アラートを発火。

## 7.4 再同期ジョブ仕様

1. 10分間隔で直近更新ユーザーを差分再同期。
2. 日次1回（JST 03:30）で全対象ユーザーをフル再同期。
3. PAY.JP状態とDiscordロールが不一致なら即修復。
4. 修復結果を監査ログへ記録。

## 7.5 Discord連携実装方針（Bot要件）

1. 本要件では、常時接続のGateway Botプロセスは必須ではない。
2. ただしDiscordのBotアカウント作成は必須であり、Botトークンをバックエンドで利用する。
3. ロール付与/剥奪は、バックエンドからDiscord REST APIを呼び出して実行する。
4. 必要権限は最小化し、少なくとも `MANAGE_ROLES` を付与する。
5. Botのロール階層は対象有料ロールより上位に配置する（Discord仕様上必須）。
6. 将来、スラッシュコマンドやリアルタイムイベント連携が必要になった場合のみGateway Botを追加実装する。

### 7.5.1 連携フロー（ユーザー操作）

1. ユーザーが `/connect` で「Discord連携」を押下する。
2. Discord OAuth2認可（`identify`）を許可する。
3. バックエンドが `discord_user_id` を保存する。
4. 課金状態変化（Webhook/再同期）時にバックエンドがBotトークンでロール同期APIを実行する。

## 7.6 運用監視BOT仕様（単独運用MVP）

1. 監視通知はDiscordの専用チャンネル（例: `#ops-alerts`）へ集約する。
2. 常時接続のGateway Botは不要。バックエンドの定期ジョブからDiscord REST APIで通知する。
3. アラート対象は初期は3つに限定する（過剰運用を防ぐ）。

### 7.6.1 最小アラートルール（初期運用）

1. `DLQ件数 > 0` が5分以上継続したら `critical` 通知。
2. `webhook_events.result=failed` が10分で3件以上なら `warning` 通知。
3. 再同期で不整合修復対象が1件以上なら `warning` 通知（初回のみ）。

### 7.6.2 通知フォーマット

1. 通知本文には以下を必ず含める。
- `severity`（warning/critical）
- `alert_key`（例: `dlq_backlog`, `webhook_fail_streak`）
- `count`
- `window`
- `first_detected_at`
- `runbook_url`

2. 例:

```text
[critical] dlq_backlog
count: 4 (window: 5m)
first_detected_at: 2026-03-28T01:25:00+09:00
action: role_sync DLQを確認し再実行
runbook: https://example.com/runbooks/payjp-discord-alerts
```

### 7.6.3 重複通知抑制（必須）

1. 同一 `alert_key` は30分以内に再送しない（状態が悪化した場合は再送可）。
2. `resolved` 通知を送る（例: `DLQ=0` に復帰した時）。
3. 通知抑制状態はDBまたは永続ストアに保存し、プロセス再起動で失わない。

### 7.6.4 実行頻度

1. 1分間隔のCronで監視クエリを実行する。
2. 深夜帯も停止しない（課金・失効は24時間発生する前提）。
3. 監視ジョブ自体の失敗もDiscordへ通知する。

## 8. データモデル仕様

## 8.1 テーブル一覧

1. `users`
- `id` (uuid, pk)
- `discord_user_id` (text, unique, not null)
- `discord_username` (text)
- `created_at`, `updated_at`

2. `payjp_customers`
- `id` (uuid, pk)
- `user_id` (uuid, unique, fk users.id)
- `payjp_customer_id` (text, unique)
- `created_at`, `updated_at`

3. `subscriptions`
- `id` (uuid, pk)
- `user_id` (uuid, fk users.id, unique)
- `payjp_subscription_id` (text, unique)
- `status` (enum: trial, active, paused, canceled, none)
- `current_period_end` (timestamptz, nullable)
- `last_payjp_event_id` (text, nullable)
- `version` (int, default 0)
- `created_at`, `updated_at`

4. `webhook_events`
- `id` (uuid, pk)
- `event_id` (text, unique)
- `event_type` (text)
- `payload_json` (jsonb)
- `received_at` (timestamptz)
- `processed_at` (timestamptz, nullable)
- `result` (enum: pending, done, failed)

5. `role_sync_jobs`
- `id` (uuid, pk)
- `user_id` (uuid, fk users.id)
- `desired_role` (boolean)
- `attempt` (int)
- `last_error` (text, nullable)
- `next_run_at` (timestamptz)
- `dead_lettered_at` (timestamptz, nullable)

6. `audit_logs`
- `id` (uuid, pk)
- `trace_id` (text)
- `user_id` (uuid, nullable)
- `action` (text)
- `resource_type` (text)
- `resource_id` (text)
- `result` (enum: success, failure)
- `metadata` (jsonb)
- `created_at` (timestamptz)

7. `oauth_states`
- `state` (text, pk)
- `expires_at` (timestamptz)
- `used_at` (timestamptz, nullable)

## 8.2 整合性制約

1. `subscriptions.user_id` は一意（1ユーザー1購読）。
2. `webhook_events.event_id` は一意（冪等化）。
3. `oauth_states.state` は1回使用後に `used_at` を設定し再利用不可。
4. `subscriptions.version` で楽観ロックし、順不同更新の上書きを防止。

## 9. API契約（抜粋）

## 9.1 `POST /v1/subscriptions`

request:

```json
{
  "planId": "premium_monthly",
  "payjpToken": "tok_xxx"
}
```

response 201:

```json
{
  "subscriptionId": "sub_xxx",
  "status": "active",
  "currentPeriodEnd": "2026-04-28T00:00:00Z"
}
```

error response:

```json
{
  "error": {
    "code": "PAYMENT_FAILED",
    "message": "決済の処理に失敗しました"
  }
}
```

## 9.2 `POST /v1/payjp/webhook`

- 成功時: 常に `200 OK`
- 検証失敗時: `401 Unauthorized`
- レスポンス本文は最小化（`{"ok": true}`）

## 10. セキュリティ仕様

1. 機密情報は環境変数 + 秘密管理基盤で管理（平文コミット禁止）。
2. `PAYJP_SECRET_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET` は90日ローテーション。
3. サイト全体（`pay.example.com` / `api.example.com`）でHTTPSを強制し、HTTPは301でHTTPSへリダイレクトする。
4. TLS 1.2以上を必須とし、HSTS（`includeSubDomains` 推奨）を有効化する。
5. 日本国内EC要件として、EMV 3-Dセキュアを本番決済で必須化する。
6. 3Dセキュア未実施または判定不能な取引は決済確定させず、再認証導線へ遷移させる。
7. 本番導入前にPAY.JPの3Dセキュア設定・テストカード検証を完了させる。
8. `2025-03-31` までのEMV 3-Dセキュア導入目標と、`2025-04-01` 以降のセキュリティ対策強化を前提に運用する。
9. CORSはフロントドメインのみ許可。
10. WebhookエンドポイントにはIP制限を検討（適用可能範囲で実施）。
11. 監査ログにはカード情報・トークン生値・秘密鍵を記録しない。
12. 依存ライブラリは週次で脆弱性スキャン。

## 11. TDD実践仕様

## 11.1 テストレベル

1. Unit Test
- 対象: ドメインルール、状態遷移、バリデーション
- 実行速度: 最速（PRごと必須）

2. Integration Test
- 対象: API + DB + キュー連携、Webhook冪等化
- 手段: Testcontainers(PostgreSQL)

3. Contract Test
- 対象: PAY.JP/Discord APIクライアント
- 手段: モックレスポンス固定化 + スキーマ検証

4. E2E Test
- 対象: 主要ユーザーフロー（連携→課金→状態表示）
- 手段: Playwright

## 11.2 重要テストケース（最初に書く）

1. 同一 `event.id` のWebhook再送時、ロール変更が二重実行されない。
2. `active -> canceled` でロールが剥奪される。
3. Webhook1件欠落時、再同期ジョブで正状態に修復される。
4. Discord API `429` で `Retry-After` に従い再試行される。
5. OAuth2 callbackで `state` 不一致は拒否される。
6. APIログに機密値が出力されない。
7. 3Dセキュア未完了取引では購読作成APIが成功しない。
8. HTTPアクセスがHTTPSへ正しくリダイレクトされる。
9. Gateway未接続構成でも、バックエンドからのDiscord REST API呼び出しでロール同期が成立する。

## 11.3 TDDワークフロー

1. 受け入れ条件をテストで定義（失敗を確認）。
2. 最小実装でテストを通す。
3. リファクタし、テストを維持。
4. 回帰テストを追加。
5. PR作成前に `lint + typecheck + test` を全通過。

## 12. CI/CD仕様

## 12.1 CI（PR時必須）

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test:unit`
4. `pnpm test:integration`
5. `pnpm build`
6. 依存脆弱性チェック

## 12.2 CD

1. Frontend: mainマージでCloudflare Pagesへデプロイ。
2. Backend: mainマージでDocker build後、Indigoへデプロイ。
3. デプロイ後にスモークテスト（health/readiness）を実行。
4. 失敗時は前バージョンへロールバック。

## 13. 環境変数定義

## 13.1 Frontend

- `VITE_API_BASE_URL`
- `VITE_PAYJP_PUBLIC_KEY`
- `VITE_APP_ENV`

## 13.2 Backend

- `NODE_ENV`
- `PORT`
- `DATABASE_URL`
- `PAYJP_SECRET_KEY`
- `PAYJP_WEBHOOK_TOKEN`
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_PAID_ROLE_ID`
- `DISCORD_ALERT_CHANNEL_ID`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI`
- `SESSION_SECRET`
- `CRON_SHARED_SECRET`
- `CORS_ORIGIN`
- `LOG_LEVEL`
- `MONITOR_WEBHOOK_FAIL_THRESHOLD`（default: `3`）
- `MONITOR_DLQ_THRESHOLD`（default: `1`）
- `MONITOR_ALERT_DEDUP_MINUTES`（default: `30`）

## 14. DoD（Definition of Done）

1. 仕様化したAPI/画面の受け入れテストが通過している。
2. セキュリティ要件（Webhook検証、state検証、機密非出力）を満たす。
3. Webhook重複/欠落シナリオの自動テストがある。
4. 再同期ジョブで不整合を修復できる。
5. 監査ログで「誰に何が起きたか」を追跡できる。
6. 運用Runbook（障害時手順）が整備されている。
7. 本番決済がEMV 3-Dセキュア必須であることをテスト/設定の両面で証明できる。
8. `pay.example.com` と `api.example.com` のHTTP経路がすべてHTTPSへ統一されている。
9. Discord運用監視BOTが `DLQ/失敗連続/再同期差分` を検知して通知できる。
10. 同一障害で通知スパムしない抑制ロジックと `resolved` 通知がある。

## 15. 初期実装バックログ（着手順）

1. Monorepo初期化（apps/packages構成、共通tsconfig、lint、CI雛形）。
2. Backend基盤（Fastify, Prisma, health API, logging, error handling）。
3. Discord OAuth2連携（start/callback/state検証）。
4. PAY.JP購読作成API（`POST /v1/subscriptions`）。
5. PAY.JP Webhook受信 + 冪等テーブル実装。
6. Role同期Worker + 再試行 + DLQ。
7. 再同期ジョブ（差分/日次フル）。
8. Frontend画面（connect/billing/membership/result）。
9. E2E整備（主要3シナリオ）。
10. Discord監視BOT（最小3アラート + 重複通知抑制）。
11. 本番デプロイと監視アラート設定。

## 16. 補足（実装時の判断基準）

1. 迷った場合は「安全側に倒す」。
2. Discord API障害時は有料ロール剥奪漏れを検知可能にし、再試行優先。
3. 時刻依存ロジックは `current_period_end` 単独で判断せず、常に `status` を優先。
4. 仕様変更はこのドキュメントに追記し、テストを先に更新する。

## 17. 開発着手チェック（Day 0）

## 17.1 前提ツール

1. Node.js 22 LTS
2. pnpm 10+
3. Docker Desktop（PostgreSQLローカル起動用）
4. GitHub Actions利用権限（CI/CD）

## 17.2 初期コマンド（推奨）

```bash
# ルート初期化
pnpm init
pnpm add -Dw typescript turbo eslint prettier vitest @types/node

# ワークスペース雛形
mkdir -p apps/web apps/api packages/shared packages/config packages/test-kit infrastructure
cat > pnpm-workspace.yaml <<'YAML'
packages:
  - apps/*
  - packages/*
YAML
```

```bash
# frontend
pnpm create vite apps/web --template react-ts
pnpm -C apps/web add @tanstack/react-query react-hook-form zod @hookform/resolvers
pnpm -C apps/web add -D tailwindcss @playwright/test @testing-library/react @testing-library/jest-dom
```

```bash
# backend
pnpm -C apps/api init
pnpm -C apps/api add fastify zod pino undici pg pg-boss @prisma/client
pnpm -C apps/api add -D prisma supertest testcontainers tsx
pnpm -C apps/api prisma init
```

## 17.3 初回で作る最低限エンドポイント

1. `GET /health/liveness`
2. `GET /health/readiness`
3. `POST /v1/payjp/webhook`（検証 + 冪等保存 + 即時200）

## 18. 最初のTDDチケット（推奨順）

1. `Webhook冪等化`
- 受け入れ条件: 同一 `event.id` を2回送っても、`webhook_events` 登録1件 + ジョブ投入1回。

2. `課金状態->ロール同期ルール`
- 受け入れ条件: `status=active` のみロール付与、他状態は剥奪。

3. `再同期ジョブ`
- 受け入れ条件: Webhook欠落を再現しても、再同期実行後にDB状態とDiscordロールが一致。
