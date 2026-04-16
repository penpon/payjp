# Periodic Code Review Findings

自動定期レビュー（20分間隔）の発見事項蓄積ドキュメント。
後続のコード修正タスクの入力として使用する。

## 凡例

- **[CRITICAL]** — 本番障害・データ損失・セキュリティ侵害に直結
- **[HIGH]** — 論理バグ・未処理エラーパス・仕様違反
- **[MEDIUM]** — コード品質・保守性・冗長コード
- **[LOW]** — 軽微な改善提案
- **(verified)** — 実コードで確認済み
- **(false-positive)** — 実コード検証で否定

---

## Iteration 1 — 2026-04-16

5 専門エージェント並行レビュー: Security / Logic / Silent Failure / Frontend / DB

---

### CRITICAL (3件)

#### C-01: `cancel.ts:117-118` — `setInflightOperation` 未ガード **(verified)**

- **発見元**: Security + Silent Failure
- **問題**: `await deps.db.setInflightOperation(member.id, operationId, 'cancel', now)` が try/catch なし。DB 書き込み失敗時に例外が素通りし、billing.routes.ts の外側 catch で `503 INTERNAL_ERROR`（operationId なし）が返る
- **仕様違反**: 「不確定失敗は `503 + operationId` を返す」ルール
- **影響**: ユーザーが operationId を手がかりに状態調査不可。inflight 残存も不明
- **修正案**:
  ```typescript
  try {
    await deps.db.setInflightOperation(member.id, operationId, 'cancel', now);
  } catch (err) {
    slog('error', 'setInflightOperation failed', { memberId: member.id, operationId, error: String(err) });
    return { ok: false, statusCode: 503, errorCode: 'DB_UPDATE_FAILED', message: 'Failed to set inflight operation', operationId };
  }
  ```
- **備考**: `subscribe.ts:188` にも同じパターンあり。両方修正が必要

---

#### C-02: `migrate.ts:34` — 空 catch で全マイグレーションがサイレントスキップ **(verified)**

- **発見元**: Silent Failure
- **問題**: `readdirSync(migrationsDir)` の catch ブロックが完全に空。ディレクトリ読み取り失敗（パス計算バグ、権限問題、ディスク障害）を一切区別せず `migrationFiles = []` にフォールバック
- **影響**: アプリは「正常起動」するが ALTER TABLE 系マイグレーション全てが未適用。実行時に `column does not exist` エラーが発生し、根本原因（起動時）との距離が極めて遠い
- **修正案**:
  ```typescript
  try {
    migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      migrationFiles = []; // ディレクトリ不在 = マイグレーション 0 件（正常）
    } else {
      throw new Error(`Failed to read migrations dir "${migrationsDir}": ${String(err)}`);
    }
  }
  ```

---

#### C-03: `admin-server/main.ts:36-44` — `Cache-Control: no-store` 欠落 **(verified)**

- **発見元**: Logic Review
- **問題**: `onSend` フックで CSP / HSTS 等のセキュリティヘッダーを設定しているが `Cache-Control: no-store` が欠落。`packages/server/src/app.ts:61` では設定済み — parity コメントがあるが実際には不一致
- **影響**: プロキシ/CDN（CF Access 前段含む）がメンバー一覧・課金状態レスポンスをキャッシュし、他ユーザーへ個人情報が漏洩するリスク
- **修正案**: `reply.header('Cache-Control', 'no-store');` を onSend フックに追加

---

### HIGH (5件)

#### H-01: `cancel.ts:47-49` vs `subscribe.ts:123` — ロックキー不整合 **(verified)**

- **発見元**: Silent Failure
- **問題**:
  - subscribe: `member:${provisional.id}` (prefixed)
  - cancel: `member.discord_user_id ?? fallbackDiscordUserId ?? member.id` (no prefix)
  - 異なるロック名前空間のため、同一メンバーの subscribe と cancel が**並行実行可能**
- **影響**: PAY.JP でサブスクリプション作成と解約が同時進行 → 不整合な DB 状態、課金済みだが subscription_status が canceled など
- **修正案**: cancel のロックキーを `member:${member.id}` に統一

---

#### H-02: `cancel.ts:236-253` — Discord + DB 二重障害で impact log なし **(verified)**

- **発見元**: Silent Failure
- **問題**: `removeRole` 失敗後、`updateMemberRoleState(member.id, 'unknown')` も失敗した場合、slog のみ。`member_impact_logs` に記録されないため ops alert が発火しない
- **影響**: メンバーは `subscription_status: canceled` だが `role_state: granted` のまま。daily resync が唯一の回復パスだが DB 障害継続時は回復不能
- **修正案**: 二重障害時に `member_impact_logs` へ INSERT する try/catch を追加

---

#### H-03: `webhook.ts:491-500` — 0行 UPDATE を `succeeded` 記録 **(verified)**

- **発見元**: Silent Failure
- **問題**: `updateMemberFromWebhook` で `rowCount === 0` のとき `console.warn` のみで例外なし。呼び出し元トランザクション内で `payjp_events` に `process_status: 'succeeded'` が INSERT される
- **影響**: audit trail が嘘をつく。メンバー削除によるものなら許容だが、WHERE 条件のバグの場合は完全に不可視
- **修正案**: 0行時は例外を throw し、トランザクション全体を rollback → `process_status: 'failed'` で記録

---

#### H-04: `billing.routes.ts:158-186` — クロスメンバー情報漏洩パス **(verified)**

- **発見元**: Logic Review
- **問題**: `member_session` のメンバー A の `subscription_status` が null/deleted → `subscriptionStatusBodyForMember` が null 返却 → `link_session` フォールバックでメンバー B の情報を返す可能性
- **影響**: メンバー A のブラウザにメンバー B のサブスクリプション情報が表示（金銭的権限昇格ではないが情報漏洩）
- **修正案**: `member_session` でメンバーが存在するなら即 `{ subscription: null }` を返し、`link_session` フォールバックをスキップ:
  ```typescript
  if (member) {
    const body = subscriptionStatusBodyForMember(member, now);
    return reply.status(200).send(body ?? { subscription: null });
  }
  ```

---

#### H-05: `daily-resync.ts:25` — 非ゼロ exit code が正常解決 **(verified)**

- **発見元**: Silent Failure
- **問題**: `runResyncCli` が `exitCode !== 0` で返った場合、log に `result: 'failure'` 記録するが `runDailyResync` は resolve。呼び出し元（Fastify route / cron wrapper）は成功として扱う
- **影響**: daily resync 全メンバー失敗でも ops system にエラー通知なし。webhook 障害の最終回復手段が沈黙
- **修正案**: `if (output.exitCode !== 0) throw new Error(...)` を追加

---

### MEDIUM (7件)

#### M-01: `main.ts:353` — `formUrl` プロトコル未検証（XSS昇格） **(verified)**

- **発見元**: Frontend
- **問題**: `window.location.href = result.formUrl` で `javascript:` / `data:` スキームを遮断していない
- **修正案**: `new URL(result.formUrl)` で parse し `protocol !== 'https:'` なら reject

#### M-02: `pg-db-client.ts:500-519` — advisory lock 接続リーク **(verified)**

- **発見元**: DB
- **問題**: `acquireAdvisoryLock` で lockClients に格納した client がプロセス終了時に release されない
- **修正案**: シャットダウンハンドラで全 lockClients を強制 release

#### M-03: `pg-db-client.ts:506,533,543` — `hashtext()` 32bit 衝突 + 名前空間混在 **(verified)**

- **発見元**: DB
- **問題**: session-level lock と xact-level lock が同一 `(0, hashtext)` 名前空間を共有。32bit 衝突率 1/2^32 でデッドロック可能
- **修正案**: 64bit 版 `pg_try_advisory_lock(int8)` に移行、または名前空間プレフィックス分離

#### M-04: `queries.ts:203-217` — `mode` パラメータ SQL テンプレート補間 **(verified)**

- **発見元**: DB
- **問題**: TypeScript 型ガードのみ。JS レベルの runtime guard なし
- **修正案**: switch + default throw で 3 値のみ受付

#### M-05: `pg-pool.ts:28-43` — ROLLBACK 失敗時に元エラーのみ再 throw **(verified)**

- **発見元**: Silent Failure
- **問題**: 両エラーを wrap した新 Error で呼び出し元にDB状態不定を通知すべき
- **修正案**: `throw new Error('TX failed AND rollback failed: ...')` に変更

#### M-06: `cancel.ts:117-182` — uncertain failure 後の retry UX **(verified, downgraded)**

- **発見元**: Silent Failure
- **問題**: 不確定失敗 → INFLIGHT_OPERATION 返却。operationId は含まれている（line 66 で確認）が、メッセージが "Another operation is in progress" で自分の操作とわからない
- **修正案**: メッセージを `'Your previous cancel operation (${operationId}) is still in progress'` に変更

#### M-07: `webhook.ts:337-339` — unknown_status 時の stale reference

- **発見元**: Silent Failure
- **問題**: `txResult.lockedMember` がトランザクション前の状態を参照。`attemptRoleSyncAllRoles` が不要な Discord API 呼び出しを実行しうる
- **備考**: `critical_failure` ログの ops alert 連携を確認すべき

---

### LOW (8件)

#### L-01: `access-gate.routes.ts:85-88` — `insertAccessGateSession` 構造化ログ欠落

- **発見元**: Security

#### L-02: `frontend/types.ts` — `BillingStep.success` / `AppState.cancel_complete` デッドコード

- **発見元**: Frontend
- **問題**: 実フローで到達するコードパスなし

#### L-03: `cancel-ui.ts:57` — ESC ハンドラでイベントリスナーリーク

- **発見元**: Frontend
- **問題**: `callbacks.onDismiss()` を直接呼び `dismiss()` 経由でない → `removeEventListener` 不実行

#### L-04: `main.ts:82-95` — `pollAfterGoogleFormSubmit` getMember エラー未処理

- **発見元**: Frontend
- **問題**: ネットワーク一時エラーでポーリング中断

#### L-05: `truncate-app-data.ts:14-16` — 本番ガードなし

- **発見元**: DB
- **問題**: `NODE_ENV` チェックなし。共有 index からエクスポート済み

#### L-06: `pool.ts:9-12` — SSL スキップが文字列マッチ依存

- **発見元**: DB
- **問題**: `localhost` / `127.0.0.1` 以外のローカルパターン（`::1`, Docker service名）未考慮

#### L-07: `pg-db-client.ts:133-134` — `toMember` 型アサーションのみ

- **発見元**: DB
- **問題**: `role_state` / `last_synced_at` に `assertString` 未適用（他フィールドとの不一致）

#### L-08: `admin-server/routes.ts:49-51` — OPTIONS 認証スキップがデッドコード

- **発見元**: Logic Review
- **問題**: `@fastify/cors` が `onRequest` で先に処理するため到達しない

---

### FALSE POSITIVES (排除済み)

- `cancel.ts:60-67` INFLIGHT_OPERATION に operationId 欠如 → **実コード line 66 で `operationId: member.inflight_operation_id` 含む。UX 問題として M-06 に downgrade**
- `addMemberToGuild` の `queueRequest` 型安全性 → **Logic Review agent 自身が confidence 不足で除外**

---

## Iteration 2 — 2026-04-16 (テスト品質・Docker/nginx・仕様整合性)

### subscribe.ts 同パターン確認 **(verified)**

- `subscribe.ts:188` の `setInflightOperation` も C-01 と完全同一の未ガードパターン。修正は C-01 と同時に実施

---

### Docker / Nginx

#### H-06: マルチステージビルド未使用 — devDependencies 本番混入

- **File**: `Dockerfile`, `Dockerfile.admin`, `Dockerfile.frontend`
- **問題**: 全 Dockerfile が単一ステージ。biome/vitest/tsx 等が本番イメージに同梱。`Dockerfile.frontend` は `npm run dev` を CMD に持つ
- **影響**: イメージサイズ増大、攻撃面拡大、HMR サーバー本番起動リスク
- **修正案**: builder + runtime 2 ステージ構成に分離

#### H-07: ベースイメージタグ未ピン留め

- **File**: `Dockerfile:2`, `Dockerfile.admin:2`, `Dockerfile.frontend:2`
- **問題**: `node:22-bookworm-slim` は floating tag。ビルド再現性なし
- **修正案**: `@sha256:<digest>` ピン留め、月次更新サイクル

#### M-08: nginx admin vhost `0.0.0.0:8443` — コメント「loopback only」と乖離

- **File**: `nginx/nginx.conf:280`
- **問題**: コメントは internal-only だが `listen` は全インターフェース。Docker ネットワーク内から到達可能
- **修正案**: `listen 127.0.0.1:8443 ssl;` に変更

#### M-09: `X-Forwarded-For` が `$remote_addr` のみ — CF 経由の実クライアント IP 喪失

- **File**: `nginx/nginx.conf:150,179,232,258,309`
- **問題**: Cloudflare edge IP がログに記録される。実クライアント IP は `CF-Connecting-IP` にある
- **影響**: レート制限・監査証跡・fail2ban が CF IP 対象になる
- **修正案**: `set_real_ip_from` + `$http_cf_connecting_ip` 設定

#### M-10: admin-api healthcheck が TCP のみ

- **File**: `docker-compose.yml:133-141`
- **問題**: HTTP レベル障害を検知不可（既知: memory `reference_admin_server_no_health_endpoint.md`）
- **修正案**: `/health` エンドポイント追加 + fetch ベースチェック

#### M-11: nginx:alpine タグ未ピン留め

- **File**: `docker-compose.yml:43`
- **修正案**: `nginx:1.27-alpine` 等のマイナー固定

#### M-12: groupadd/useradd が COPY 後

- **File**: `Dockerfile:25-26`, `Dockerfile.admin:23-24`
- **修正案**: ユーザー作成を COPY 前に移動、`COPY --chown=appuser:appgroup`

#### L-09: `Dockerfile.frontend` が dev mode CMD

- **問題**: `CMD npm run dev -- --host` で HMR サーバー起動。本番で誤使用すると全インターフェースにバインド

#### L-10: `.deploy.log` が .gitignore 未追加

- **File**: `scripts/prod/deploy.sh`
- **問題**: リポジトリ内にログ生成される可能性

---

### テスト品質

#### H-08: `errors.test.ts` — `isUncertainError` カバレッジ不足

- **問題**: ETIMEDOUT/ECONNRESET/EPIPE/HTTP 5xx が未テスト。本番最頻出パターン
- **修正案**: errno code 別 + HTTP status 別のテストケース追加

#### H-09: `subscribe-flow.test.ts` — `releaseAdvisoryLock` finally 呼出未検証

- **問題**: lock 取得後の release 保証がテストされていない。失敗時に永続 503
- **修正案**: 成功/失敗両パスで `releaseAdvisoryLock` 呼出回数を assert

#### H-10: `cancel-flow.test.ts` — トークンハッシュ mock が甘い

- **問題**: `findLinkSession` が常に session 返却。任意トークンでも通過
- **修正案**: `linkSessionTokenHash` 一致条件を mock に追加

#### H-11: `billing-routes.test.ts` — `__Host-member_session` Cookie 属性未検証

- **問題**: `Secure`/`HttpOnly`/`SameSite=Lax`/`Path=/` の検証なし。§6 固定ルール違反検出不能
- **修正案**: Set-Cookie ヘッダーの属性アサーション追加

#### M-13: google-submit トークン再利用/メール改ざんテスト欠如

- **問題**: `CONSUMED_CANCEL_FORM_TOKEN` と `TOKEN_EMAIL_MISMATCH` のテストなし
- **影響**: replay attack / email 改ざんの防御リグレッション検知不能

#### M-14: `cross-cutting.test.ts` ヘルスチェック — dead test

- **問題**: テスト内独自関数を検証。本番 `/health` エンドポイント未呼出

#### M-15: `subscribe-flow.test.ts` PROP-BILL-038 — mock 自体を検証

- **問題**: `makePayjpSubscription().plan.interval` を assert。プロダクションコード未検証

#### M-16: `cancel-flow.test.ts` — `updateMemberAfterCancel` 失敗パス未テスト

- **問題**: DB 保存失敗 → 503 + operationId の検証なし

#### M-17: `resync-flow.test.ts` — 30分警告ログのアサーション弱い

- **問題**: `expect(deps.log).toHaveBeenCalled()` のみ。issue フィールド未検証

---

### 直接検証 (cross-cutting)

#### L-11: `slog` 関数が subscribe.ts と cancel.ts で重複定義

- **問題**: 同一実装が 2 ファイルに存在（`maskSensitiveLogFields` 経由の JSON ログ）
- **備考**: 他パッケージは raw `console.error(JSON.stringify(...))` で `maskSensitiveLogFields` 未使用。ただし機微データ直接出力は確認されず実害なし

---

### 仕様整合性 (Spec Compliance)

#### H-12: Discord role sync にリトライロジック未実装 **(verified)**

- **仕様**: `2weeks-spec.md` §6.3 #18 — "Discord API `429/5xx` は短時間リトライ最大3回: 0秒/1秒/2秒 待機、各回timeout 1秒、総処理 6秒 以内"
- **Code**: `cli-deps-factory.ts:97-104` (`syncRole`) / `webhook.ts:504-578` (`attemptRoleSync`)
- **問題**: 単一 Discord REST 呼出のみ。リトライループ/タイムアウトなし
- **影響**: Discord API の一時障害 (5xx) で role sync が即失敗 → `role_state: unknown` → daily resync 依存
- **修正案**: `syncRole` 内に 3 回リトライ (delay 0/1/2s, per-call timeout 1s) を追加
- **備考**: `@discordjs/rest` は 429 rate limit を内部処理するが、5xx リトライは別

#### M-18: CLI output が multi-line JSON **(verified)**

- **仕様**: `2weeks-spec.md` §10 — "標準出力は1行JSON固定"
- **Code**: `resync-cli.ts:65` — `JSON.stringify(out.result, null, 2)`
- **修正案**: `null, 2` 引数を除去

#### L-12: Access gate チェックが §5.1 sequence に未反映

- **仕様**: `2weeks-spec.md` §5.1 (steps 1-12)
- **Code**: `subscribe.ts:149-173` (step 4-5 間に挿入)
- **修正案**: spec §5.1 に access gate ステップを追記

#### L-13: §8.7 が CR-009 と矛盾（stale spec）

- **仕様**: §8.7 "課金前に Discord 参加検証" vs CR-009 "検証しない"
- **修正案**: §8.7 に "superseded by CR-009" 注記追加（コード変更不要）

#### L-14: §6.7 #2 の first-trial 識別子記述が §6.7 #3 と矛盾

- **仕様**: §6.7 #2 "`discord_user_id`" vs §6.7 #3 "`first_trial_granted_at`"
- **修正案**: §6.7 #2 を修正（コード変更不要）

---

## Iteration 3 — 2026-04-16 (Auth-service OAuth・依存グラフ)

### Auth-service OAuth

#### M-19: `/session` endpoint が `allowConsumed: true` で消費済みトークン許容

- **File**: `auth-service/src/shell/index.ts:387`
- **問題**: 消費済み link_session トークンが 15 分 TTL 内で有効のまま。replay-after-use がサイレント許容
- **影響**: トークン消費後もセッション認証が継続（`__Host-link_session` Cookie 保持者は引き続き認証済み扱い）
- **修正案**: `allowConsumed: true` を削除し、consumed 後は明示的な状態遷移に変更

#### M-20: `discordTokenEncryptionKey` 未設定で guild join サイレント失敗

- **File**: `auth-service/src/shell/index.ts:189, 295-314`
- **問題**: env var 欠如時に警告なく Discord トークンを即時 revoke、guild join 不能化。起動時検証 (`REQUIRED_ENV_VAR_NAMES`) に未含
- **影響**: 設定ミスのデプロイで全ユーザーの guild join が無音失敗
- **修正案**: `REQUIRED_ENV_VAR_NAMES` に追加、または起動時 warn ログ出力

#### L-15: `revokeDiscordToken` エラーが完全吞み込み

- **File**: `auth-service/src/shell/index.ts:307, 312, 345`
- **問題**: `.catch(() => {})` でエラー吞み込み。revoke 失敗時の運用可視性ゼロ
- **修正案**: catch 内で構造化ログ出力に変更

#### L-16: Legacy `handleAuthRequest` 3 引数オーバーロード残存

- **File**: `auth-service/src/shell/index.ts:197-213`
- **問題**: 実 OAuth フローを実行できないスタブ。テストが stub 挙動を検証（実装との乖離）
- **修正案**: `@deprecated` 注記追加、テストを構造化フォームに移行

### 依存 / Import グラフ

#### M-21: `sync-service → billing-service` 依存（期待グラフ違反）

- **File**: `packages/sync-service/package.json`, `sync-service/src/shell/cli.ts:5`
- **問題**: `calculateTrialEnd` と `isFirstTimeUser` の 2 関数のみをインポート。期待グラフでは sync-service → shared のみ
- **影響**: billing-service 変更が sync-service ビルドに波及、独立デプロイ困難化
- **修正案**: 2 関数を `@hayane/shared` に移動（純粋な日付計算/null チェックで billing 依存なし）

#### M-22: vitest バージョン二重管理（root v4 vs packages v3）

- **File**: root `package.json` (vitest ^4.1.4) / packages/*/package.json (vitest ^3.1.1)
- **問題**: root v4 が全プロジェクト制御。パッケージ内 v3 宣言は無効でディスク浪費。v3→v4 Mock 型破壊の前例あり（memory参照）
- **修正案**: 各パッケージの devDependencies から vitest 削除、root に一元化

#### M-23: `@types/node` バージョン不整合

- **File**: root (^25) / server+admin-server (^22)
- **問題**: 型定義の major バージョン差異。モジュール解決順序依存で v22 にない API の型エラーリスク
- **修正案**: server/admin-server の ^22 を削除、root の ^25 に統一

#### L-17: `maskSensitiveLogFields` の `SENSITIVE_FIELD_PATTERN` が 3 パッケージで相違

- **File**: auth-service (`code` 含む) / billing-service (`email` 含む) / sync-service (どちらも不含)
- **問題**: sync-service のログに `email` フィールドが平文出力されうる
- **修正案**: `@hayane/shared` に統一実装。パターンは各パッケージの union を採用

#### L-18: `@types/cron` が不要（cron v4 はバンドル型持ち）

- **File**: `packages/server/package.json`
- **問題**: `@types/cron ^2.0.1` は cron v2 向け。v4 と型が乖離（`skipLibCheck: true` で隠蔽中）
- **修正案**: `@types/cron` 削除

#### L-19: admin-server が pg を直接依存（shared 経由不使用）

- **File**: `packages/admin-server/package.json`
- **問題**: shared が既に pg 依存を持つ。バージョン二重管理
- **修正案**: shared の re-export を使用、または現状維持（low priority）

---

## Iteration 4 — 2026-04-16 (パフォーマンス・ビルド設定)

### ビルド設定直接検証

- `tsconfig.base.json`: `strict: true`, `ES2022`, `NodeNext` — 問題なし
- `biome.json`: recommended rules + noUnusedImports/Variables — 適切
- `.gitignore`: `.env*`, `*.log`, `*.pem`, `*.key` 全てカバー済み
- テスト内秘密鍵: 全てダミー値 (`sk_test_xxx`, `bot_xxx`) — 実秘密鍵混入なし

### FALSE POSITIVE 追加

- L-10 (Iter 2): `.deploy.log` が `.gitignore` 未追加 → **`.gitignore` の `*.log` パターン (line 40) がカバー済み**

---

## Iteration 5 — 2026-04-16 (schema/rate-limit/admin-frontend・収束判定)

### Schema / Cleanup

#### M-28: `cleanup.ts` に `member_sessions` / `cancel_form_tokens` クリーンアップ欠落 **(verified)**

- **File**: `packages/server/src/cleanup.ts`
- **問題**: `oauth_states`, `discord_link_sessions`, `access_gate_sessions`, `payjp_events`, `member_impact_logs`, `invite_*` はクリーンアップ対象だが、`member_sessions` と `cancel_form_tokens` が未対象
- **影響**: 期限切れセッション/トークンが無期限蓄積 → テーブル膨張。`member_sessions_expires_at_idx` / `cancel_form_tokens_expires_at_idx` があるので SEQ SCAN は回避されるが、ストレージ消費が増加
- **修正案**: cleanup.ts のトランザクション内に 2 行追加:
  ```sql
  DELETE FROM member_sessions WHERE expires_at < NOW();
  DELETE FROM cancel_form_tokens WHERE expires_at < NOW();
  ```

### Rate Limiting — 問題なし

全エンドポイントに per-route rate limit 設定済み:
- Subscribe/Cancel: 5/min, Status: 15/min, Webhook: 100/min, OAuth: 10/min, Access gate: 30/min
- 適切な粒度。追加の発見なし

### Admin Frontend — 問題なし

- `admin-frontend/src/main.ts`: read-only fetch client、`credentials: 'include'` で Cookie 認証
- XSS リスクなし（innerHTML 未使用を確認）
- 軽微な追加発見なし

### 収束判定

Iteration 5 で新規 HIGH 以上の発見は **0 件**（M-28 のみ）。
4 Iteration 連続で CRITICAL 新規 0、Iteration 5 で HIGH 新規 0 — **レビュー収束と判定**。

### 最終統計

| 重要度 | 件数 |
|---|---|
| CRITICAL | 3 |
| HIGH | 14 |
| MEDIUM | 28 |
| LOW | 19 |
| FALSE POSITIVE | 3 |
| **合計** | **64 findings + 3 FP** |

### Performance Review

#### H-13: `handleAllReconciliation` — 全メンバー一括ロード + N+1 PAY.JP API

- **File**: `sync-service/src/shell/cli.ts:496-517`
- **問題**: `SELECT * FROM members` 全行メモリロード → 1 件ずつ `getPayjpSubscription` 逐次呼出。100 会員で約 20 秒
- **影響**: daily resync 中にコネクションプール (max=10) 圧迫。PAY.JP レート制限リスク
- **修正案**: バッチサイズ 10 件 + `Promise.all` + セマフォで同時数制御

#### H-14: `link-discord` — 2 段階 advisory lock でコネクション 2 本固定占有

- **File**: `server/src/routes/member.routes.ts:151-356`
- **問題**: `member-link:{memberId}` ロック + `discordUserId` ロックで `PoolClient` 2 本専有。さらに Discord API (checkMembership → addMemberToGuild → assignRole) をロック保持中に実行
- **影響**: 3-4 同時リクエストでプール枯渇可能
- **修正案**: Discord API 呼出をロックスコープ外（前後）に移動。ロック下は DB 更新のみに限定

#### M-24: `subscribe.ts` — advisory lock 保持中に PAY.JP API 最大 4 回呼出

- **File**: `billing-service/src/shell/subscribe.ts:126-547`
- **問題**: fetchToken → createCustomer → createCharge → createSubscription を全て直列実行中にロック保持。総レイテンシ 1-2 秒
- **修正案**: `fetchToken` (read-only 3DS 確認) をロック取得前に移動可能

#### M-25: `inflight_operation_id` にインデックスなし

- **File**: `packages/shared/src/schema.sql`
- **問題**: operation recovery CLI が `WHERE inflight_operation_id = $1` で SEQ SCAN
- **修正案**: `CREATE INDEX ... ON members (inflight_operation_id) WHERE inflight_operation_id IS NOT NULL;`

#### M-26: `resolveMember` — 1 イベントごとに最大 3 クエリ直列

- **File**: `sync-service/src/shell/webhook.ts:438-471`
- **問題**: discord_user_id, payjp_subscription_id, id で順次検索。並列化されていない
- **修正案**: `Promise.all` で並列化、または `WHERE ... OR ...` 単一クエリに集約

#### M-27: `reconcileMember` — 毎メンバー 2 回の空 UPDATE

- **File**: `sync-service/src/shell/cli.ts:604-607`
- **問題**: `resolveImpactLog` が大半のメンバーで rowCount=0 の空 UPDATE。N メンバーで 2N 回の追加 DB 往復
- **修正案**: 未解決 impact log を事前一括取得、存在するもののみ resolve
