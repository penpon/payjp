# Periodic Review Findings — 2026-04-16 v2

Iteration 1: billing-service / auth+server / sync-service+admin-server
Iteration 2: frontend / server routes 入力バリデーション / shared+DB+CLI
Iteration 3: Docker/nginx / scripts / 仕様整合性
Iteration 4: テストコード品質 + 既発見バグのカバレッジ検証
Iteration 5: Convergence check — 高リスクパス深堀り

## Summary

| Severity | Count |
|----------|-------|
| Critical | 6     |
| High     | 20    |
| Medium   | 12    |
| Low      | 3     |

**Total: 41 findings across 5 iterations**

---

## Critical

### C1. subscribe.ts:358-360 — Charge reconciliation で `paid` 状態未検証

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:356-374`

`createCharge` 失敗後のリカバリで `member.payjp_initial_charge_id` が存在する場合、PAY.JP から charge を取得して `existingCharge.id` をそのまま使用。`PayjpCharge.paid: boolean` (types.ts:29) を一切確認していない。

**リスク:** 過去に declined/3DS失敗した charge ID が DB に残存していた場合、`paid: false` の charge で subscription 作成に進行する。

**修正案:**
```typescript
const existingCharge = await payjp.fetchCharge(member.payjp_initial_charge_id);
if (!existingCharge.paid) {
  // Charge exists but was not paid — treat as definite failure
  await clearInflightOnDefinitePayjpFailure(db, member.id, normalizedEmail, operationId, 'createCharge_unpaid');
  return { ok: false, statusCode: 422, errorCode: 'PAYJP_ERROR', message: 'Stored charge was not paid', operationId };
}
initialChargeId = existingCharge.id;
```

---

### C2. cli.ts:509 — `handleAllReconciliation` catch がエラーをサイレント握りつぶし

**ファイル:** `packages/sync-service/src/shell/cli.ts:509-513`

```typescript
catch {          // ← err 未束縛
  failed++;
  await insertImpactLog(deps.db, member.id as string, 'resync_individual_error', undefined);
}
```

- エラー内容（DB/Discord/型エラー等）が完全消失
- `insertImpactLog` 自体が throw した場合、for ループ全体が中断（REQ-SYNC-030 の「継続処理」要件違反）

**修正案:**
```typescript
catch (err) {
  failed++;
  deps.log({ timestamp: formatRfc3339Utc(deps.now()), service: 'sync-service', endpoint: 'cli/resync', result: 'error', error: 'reconcile_member_threw', member_id: member.id as string, errorMessage: err instanceof Error ? err.message : String(err) });
  try { await insertImpactLog(deps.db, member.id as string, 'resync_individual_error', undefined); } catch { /* best-effort */ }
}
```

---

## High

### H1. cancel.ts:195-199 — `periodEnd` fallback が `member.access_end_at` を飛ばす

**ファイル:** `packages/billing-service/src/shell/cancel.ts:195-199`

```typescript
const periodEnd = nextBillingAt ?? now;  // ← member.access_end_at 未参照
```

正規化ブランチ (line 78) は `member.next_billing_at ?? member.access_end_at ?? now` と3段 fallback。メインキャンセルパスは `nextBillingAt ?? now` の2段のみで `member.access_end_at` を飛ばす。`current_period_end` が 0/null かつ `next_billing_at` が null の場合、アクセスが即時終了する。

**修正案:**
```typescript
const periodEnd = nextBillingAt ?? member.access_end_at ?? now;
```

---

### H2. cancel.ts:267-284 — inflight 解除済みなのに 503 + operationId を返却

**ファイル:** `packages/billing-service/src/shell/cancel.ts:267-284`

`applyImmediateCancelState` (line 202-210) で `inflight_operation_id: null` に更新済み。その後 `finalizeImmediateCancel` でロールマッピング未検出時に 503 + `operationId` を返すが、DB 上の inflight レコードは既に消失。

- クライアントは stale な operationId を受け取る
- 手動 CLI で照会しても該当レコードなし
- PAY.JP 側のキャンセルは成功済み（部分的成功）

**修正案:** 503 ではなく、キャンセル成功 + ロール同期失敗の部分成功レスポンスを返すか、inflight クリアをロール同期後に移動。

---

### H3. cli.ts:621-630 — `syncRoleIds` が Discord API エラーをサイレント握りつぶし

**ファイル:** `packages/sync-service/src/shell/cli.ts:621-630`

```typescript
catch {          // ← err 未束縛
  allOk = false;
}
```

`syncRole` の失敗原因（rate limit / 403 / network）が完全消失。`handleSubscribeRecovery` と `reconcileMember` の no-subscription-id ブランチから呼ばれ、ロール同期失敗の根本原因を追跡不能にする。

**修正案:** `err` を束縛し、呼び出し元の log 関数 or deps.log でログ出力。

---

### H4. admin-server/routes.ts:59-63 — CF Access JWT 未検証（既知・cloudflared 未展開）

**ファイル:** `packages/admin-server/src/routes.ts:59-63`

`cf-access-authenticated-user-email` ヘッダーの値を信頼し、JWT (`Cf-Access-Jwt-Assertion`) を検証しない。同一 Docker ネットワーク内からヘッダー詐称で KEY 不要アクセス可能。

**状態:** 既知。cloudflared Tunnel 展開後に JWT 検証を有効化する計画が TODOコメントに記載済み。

---

### H5. shared/db/migrate.ts:46-64 — migration の並行実行でサイレント重複適用の可能性

**ファイル:** `packages/shared/src/db/migrate.ts:46-64`

`CREATE TABLE IF NOT EXISTS schema_migrations` はトランザクション外。`SELECT 1 FROM schema_migrations WHERE name = $1` チェックと `INSERT INTO schema_migrations` + migration SQL の実行は BEGIN/COMMIT 内だが、2プロセスが同時に advisory lock を取得→解放すると同一 migration を重複実行する。非冪等 DDL (ALTER TABLE 等) でエラーとなる。

**緩和:** `pg_advisory_lock` でシリアライズされるため低頻度。しかし構造的に脆弱。

---

## Medium

### M1. cli.ts:163-197 — 未知の operation type がサイレントに `{ success: false }`

**ファイル:** `packages/sync-service/src/shell/cli.ts:163-197`

`operationType` が `'subscribe'` でも `'cancel'` でもない場合、ログなしで `{ success: false }` を返す。スキーマ変更後の古いレコードで原因不明の失敗となる。

---

### M2. subscribe.ts:482-483 — Trial 時の `access_end_at` が `trial_end` ではなく `current_period_end`

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:482-483`

`PayjpSubscription.trial_end: number | null` (types.ts:37) が利用可能だが未使用。PAY.JP の現行仕様では subscription 作成時に `current_period_end === trial_end` となるため即座のバグではないが、コード意図の明確性に欠ける。

---

### M3. shared/db/pg-pool.ts:31-39 — ROLLBACK 失敗時の `console.error` 直接出力

**ファイル:** `packages/shared/src/db/pg-pool.ts:31-39`

アプリ全体は `deps.log(LogEntry)` パターンだが、ここだけ `console.error(JSON.stringify(...))` で出力。呼び出し元コンテキスト消失。

---

## Low

### L1. server/src/main.ts:281 — Discord REST パスの `encodeURIComponent` 不統一

`checkMembership` / `assignRole` / `removeRole` はテンプレートリテラル直接埋め込み、`addMemberToGuild` (line 322) は `encodeURIComponent` 使用。Discord snowflake ID は数値文字列のため実害なし。

---

### L2. sync.routes.ts:20 — `request.ip` が常に Cloudflare IP（既知）

Cloudflare Tunnel 経由で TCP 接続元が常に CF の IP。監査ログ目的のみで認証には不使用。前回レビュー (PR #87) でも記録済み。

---

---

# Iteration 2: frontend / server routes / shared+DB+CLI

## High

### H6. e2e-serve.ts:93 — syncDeps の planRoleMapping が billingConfig と不整合

**ファイル:** `packages/server/src/e2e-serve.ts:93` + `packages/server/src/e2e/e2e-mocks.ts:147`

`e2e-serve.ts:86` は `billingConfig.planRoleMapping` に `E2E_BROWSER_PLAN_ROLES` (`plan_starter`, `plan_business`, `plan_enterprise`) を設定。一方 `buildSyncDepsForE2EPlain` (line 93) は内部で `E2E_PLAN_ROLE_MAPPING` (`plan_e2e`, `plan_e2e_standard`, `plan_e2e_premium`) を使用。

**影響:** ブラウザ E2E 環境で webhook が届いた場合、`resolveRoleIdForPlan` がすべての plan でマッピング未検出。grant 時は `logUnmappedPlanWarning`（サイレント劣化）、revoke 時は全ロール一括 revoke にフォールバック。

**修正案:** `buildSyncDepsForE2EPlain` に `planRoleMapping` 引数を追加し、`e2e-serve.ts` から `E2E_BROWSER_PLAN_ROLES` を渡す。

---

### H7. invalidate-access-gate-sessions-cli.ts:18-19 — 破壊的 CLI に確認フラグなし

**ファイル:** `packages/server/src/invalidate-access-gate-sessions-cli.ts:18-19`

`DATABASE_URL` が存在するだけで即 `TRUNCATE access_gate_sessions` を実行。全 `__Host-access_gate` セッションを無効化する。`truncate-app-data-cli.ts` は `--yes` / `TRUNCATE_APP_DATA_CONFIRM=1` の確認機構を持つが、このCLIにはない。

**修正案:** `--yes` フラグまたは `INVALIDATE_CONFIRM=1` 環境変数による確認ガード追加。

---

### H8. api.ts:97 — サーバー任意メッセージが SubscriptionStatusError.message に無検証格納

**ファイル:** `frontend/src/api.ts:97`

```typescript
return typeof obj.message === 'string' ? obj.message : fallbackMessage;
```

`readSubscriptionStatusErrorMessage` がサーバーの `obj.message` をそのまま `SubscriptionStatusError.message` に格納。`textContent` 挿入のため XSS にはならないが、`parseErrorBody` との設計不一致。サーバー制御の任意文字列が error object に流入する。

**修正案:** `fallbackMessage` のみ返す（サーバーメッセージを捨て、固定文字列に統一）。

---

## Medium

### M4. access-gate.routes.ts:39-93 — POST /v1/access-gate/verify に Origin 検証なし

**ファイル:** `packages/server/src/routes/access-gate.routes.ts:39-93`

他の全 POST エンドポイントは `isSameOrigin` で Origin を検証するが、access-gate/verify は未実施。passcode 知識が必須のためCSRFリスクは低いが、設計の一貫性を欠く。

---

### M5. billing.routes.ts:72-79 — email/planId/payjpToken スキーマに minLength なし

**ファイル:** `packages/server/src/routes/billing.routes.ts:72-79`

`email: { type: 'string', maxLength: 254 }` — 空文字列がスキーマ通過。業務ロジック側で弾かれるが、防御の深さとして `minLength: 1` を追加推奨。

---

### M6. billing-ui.ts:55-67 — `step === 'success'` ブランチが dead code

**ファイル:** `frontend/src/billing-ui.ts:55-67`

`BillingStep` 型に `'success'` が含まれるが、`main.ts` のフローで `step: 'success'` が設定されるパスが存在しない。`renderSuccess` 自体は `ui.ts:194` から直接呼ばれるため到達可能だが、`renderBilling` の `case 'success'` は到達不能。

---

## Low

### L3. billing.routes.ts:308-338 — POST /v1/subscriptions/cancel にボディスキーマなし

ボディを使用しないが、Fastify デフォルト bodyLimit (1 MiB) が適用されるのみ。`additionalProperties: false` の空スキーマ追加で一貫性向上。

---

## 確認済み — 問題なし (Iteration 2)

- **XSS**: `dom.ts` の `el()` が全テキストを `createTextNode` 経由挿入。危険な DOM API の使用なし。安全
- **SQL injection**: 全クエリ `$1`/`$2` パラメータ化。文字列結合 SQL なし
- **Crypto**: AES-256-GCM、12バイト IV、16バイト認証タグ。正しい実装
- **Cookie**: `buildCookieAttributes` / `serializeCookieAttributes` 経由で統一管理
- **OAuth CSRF**: `consumeOAuthState` で `state_hash` + `oauth_session_hash` 両方照合 + one-time 消費
- **Webhook**: `timingSafeEqual` による定数時間比較
- **Error leakage**: `setErrorHandler` はスタックを `console.error` のみ出力

---

# Iteration 3: Docker/nginx / scripts / 仕様整合性

## Critical

### C3. cancel.ts:564-569 — `__Host-link_session` が失敗時に消費されない（仕様違反）

**仕様:** §8 item 3 — 「`__Host-link_session` は認証前提検証通過後かつPAY.JP書き込み前に消費し、成功/失敗に関わらず再利用不可とする」

**実装:** `packages/billing-service/src/shell/cancel.ts:564-569`

`consumeLinkSession` は `finalizeSuccess` コールバック内のみで呼ばれる。`finalizeImmediateCancel` が失敗（DISCORD_ROLE_REVOKE_FAILED 等）した場合、`finalizeSuccess` は呼ばれず link_session が残存。テスト `failure-handling.test.ts:521` が `expect(deps.db.consumeLinkSession).not.toHaveBeenCalled()` で明示的にこの動作を検証済み。

**実害:** PAY.JP 側のキャンセルは成功しているため、link_session 再利用時は正規化パスで冪等処理される。リスクは限定的だが仕様と不一致。

**修正案:** `consumeLinkSession` を `finalizeImmediateCancel` 呼び出し前（advisory lock 取得後）に移動。`consumeCancelFormToken` (line 511) も同様。

---

### C4. CR-001 advisory lock — 仕様は hashtext 廃止を要求するが実装は hashtext 使用中

**仕様:** CR-001 (2weeks-spec.md:684) — 「advisory lock の hashtext 廃止 → Discord Snowflake ID (bigint) 直接使用」

**実装:** `packages/shared/src/db/pg-db-client.ts:507` — `pg_try_advisory_lock(0, hashtext($1))`

subscribe flow では `lockKey = 'member:${provisional.id}'` (UUID文字列) を hashtext にかけている。email-first フローでは Discord ID が未確定のため UUID ベースが現実的判断だが、仕様 CR-001 と乖離。

**判定:** 実装の判断は合理的（subscribe 時に Discord ID 未取得）。**仕様側 CR を起票し CR-001 を更新すべき**。hashtext(UUID) の 32bit 衝突確率は 2^16（約65536会員）で 50% に達するため、member.id をアプリケーション側で deterministic に bigint 化する方式の検討も推奨。

---

## High

### H9. backup-db.sh:36-38 — pg_dump パイプライン失敗検出の不確実性

**ファイル:** `scripts/ops/backup-db.sh:36-38`

```bash
/usr/bin/docker compose exec -T db sh -c \
  'pg_dump ...' | gzip -9 > "$OUT"
```

`pipefail` 下でも `docker compose exec -T sh -c` が内部コマンドの exit code を伝播しないエッジケースがある。空/不完全な `.sql.gz` が書き込まれ、size チェック (500B) のみが安全網。

**修正案:** 中間ファイル経由で exit code を明示確認。

---

### H10. b2-quota-check.sh:28 — `B2_DRILL_APPLICATION_KEY` 存在確認の欠落

**ファイル:** `scripts/ops/b2-quota-check.sh:28`

`B2_DRILL_KEY_ID` は `[[ -r ... ]]` で確認するが、`B2_DRILL_APPLICATION_KEY` は確認なし。`offsite-upload.sh` と `restore-drill.sh` は両方確認しており、パターン不整合。

---

### H11. deploy.sh:110-119 — stale ロック除去と再取得間の TOCTOU

**ファイル:** `scripts/prod/deploy.sh:110-119`

`rmdir "$LOCKDIR"` → `mkdir "$LOCKDIR"` の間にウィンドウ。単一 VPS 手動運用で実害は低いが構造的弱点。

---

### H12. check-host.sh:47-48 — ストリークファイル非アトミック書き込み

**ファイル:** `scripts/ops/check-host.sh:47-48`

`printf '%s' "$streak" > "$streak_file"` — ディスクフル時に空ファイル化→ストリーク永久リセット→`HOST_LOAD_HIGH` 発火不能。`mktemp + mv` アトミックパターン推奨（memory `reference_bash_state_file_patterns.md` 参照）。

---

### H13. auth/session レスポンスに仕様外フィールド — discordUserId

**仕様:** §6.2 item 4 — 出力 `{ linked: boolean }`
**実装:** `packages/auth-service/src/shell/index.ts:395` — `{ linked: true, discordUserId: record.discord_user_id }`

仕様にない `discordUserId` を返却。フロントエンドがこの値に依存すると API 契約外の結合が発生。

---

### H14. CLI failed_count の意味が仕様と不一致

**仕様:** §10 — `failed_count` は `member_impact_logs` の `resolved_at IS NULL` 件数
**実装:** `packages/sync-service/src/shell/cli.ts:134` — 当該実行の失敗数

運用完了条件 `failed_count=0` (§14 item 3) の判定根拠が異なる。

---

### H15. Discord ロール同期リトライ未実装

**仕様:** §6.3 item 18 — 429/5xx で最大3回リトライ（0/1/2秒、各タイムアウト1秒、総6秒以内）
**実装:** `syncRole` は単一呼び出しのみ。`@discordjs/rest` の 429 自動ハンドリングはあるが、仕様の具体的制約（タイムアウト・回数制限・総時間制限）は未実装。

---

## Medium

### M7. nginx X-Forwarded-For が $remote_addr 上書き（既知の CF IP 問題）

**ファイル:** `nginx/nginx.conf:150,178,232,258,309`

`proxy_set_header X-Forwarded-For $remote_addr` — Cloudflare edge IP で上書き。`$proxy_add_x_forwarded_for` ではないため実 IP 喪失。前回レビューでも L2 として記録済み。upstream アプリの rate limiting・不正検知への影響は nginx rate limit で緩和。

---

### M8. Dockerfile/Dockerfile.admin — 不要パッケージの package.json COPY

api Dockerfile が `frontend/package.json` と `admin-server/package.json` を COPY。npm workspace で不要な依存がインストールされ image サイズ肥大化・攻撃面拡大。

---

### M9. Dockerfile.frontend — dev server 起動コマンド

`CMD ["npm", "-w", "frontend", "run", "dev", "--", "--host"]` — docker-compose で未使用（nginx が `frontend/dist` を静的マウント）。誤って compose に追加された場合に Vite dev server が起動するリスク。

---

## 仕様内部矛盾（要 CR）

### SPEC-1. OAuth scope 矛盾

- §8 item 24: `scope` は `identify` 固定
- §6.2 item 2: `scope` は `identify guilds.join`
- 実装: `identify guilds.join`（§6.2 準拠、guilds.join は CR-009 で必要と判断）
- §12.1 P0 item 1 が字義通り検証されると Go-Live 判定ブロック

**対応:** §8 item 24 と §12.1 P0 item 1 を `identify guilds.join` に更新する CR 起票。

---

## 確認済み — 問題なし (Iteration 3)

**Docker/nginx:**
- db port コメントアウト（UFW bypass 対策）正常
- admin-api は `expose` のみ（ports なし）正常
- `user: "appuser:appgroup"` で非 root 実行
- `no-new-privileges:true` + `cap_drop: ALL` + 最小 `cap_add`
- `read_only: true` + `tmpfs` パターン
- CSP: `frame-ancestors 'none'` / `object-src 'none'` / `base-uri 'none'`
- scanner-blocklist: `.env` / `.pem` / `.key` を 444 遮断
- OAuth callback `access_log off`（code= 漏洩防止）
- `cf-access-authenticated-user-email` ヘッダー strip（スプーフィング防止）
- BREACH 対策: `application/json` を gzip 除外

**Scripts:**
- 全スクリプト `set -euo pipefail` 準拠
- シークレットは `systemd-creds` / `CREDENTIALS_DIRECTORY` / `op run` 経由
- webhook URL は stderr でマスク (`sed 's#https://discord[^ ]*#[WEBHOOK]#g'`)

---

# Iteration 4: テストコード品質 + 既発見バグのカバレッジ検証

## 既発見バグのテストカバレッジ状況

| Bug ID | 概要 | テスト有無 |
|--------|------|-----------|
| C1 | charge reconciliation `paid` 未検証 | **未カバー** — `paid: false` のテストなし |
| H1 | cancel `periodEnd` fallback 不整合 | **未カバー** — `current_period_end=0` + `next_billing_at=null` + `access_end_at` set のテストなし |
| C2 | resync catch サイレント握りつぶし | **未カバー** — エラー詳細がログされることの assertion なし |
| H3 | syncRoleIds エラー握りつぶし | **未カバー** — テスト自体なし |
| H2 | 503 + stale operationId | 部分カバー — operationId 存在は検証、inflight 状態の DB 検証なし |

## Critical

### C5. billing-routes.test.ts:204 — `withTransactionLock` モックが空オブジェクト渡し

**ファイル:** `packages/server/src/__tests__/billing-routes.test.ts:204`

```typescript
withTransactionLock: vi.fn().mockImplementation((_key, fn) => fn({})),
```

`fn({})` で空オブジェクトを `txDb` として渡す。トランザクション内の DB 操作（`txDb.findMemberByDiscordUserId` 等）が `undefined` を返し、本番と異なるコードパスを通る。並行キャンセル・inflight 設定後の確認が正しく検証されない。

**修正案:** `fn({})` → `fn(db)` （同ファイル内で構築済みのモック db を渡す）。

---

## High

### H16. subscribe 成功テストで setInflightOperation 順序未検証

**ファイル:** `packages/server/src/__tests__/billing-routes.test.ts:194,306-316`

セキュリティルール「PAY.JP 書き込みは operationId 保存後」の保証として、`setInflightOperation` → PAY.JP 呼び出しの順序検証がない。`setInflightOperation` mock は `vi.fn().mockResolvedValue(undefined)` で呼び出し回数すら未チェック。

---

### H17. sync-routes.test.ts SQL 文字列 includes 比較によるモック脆弱性

**ファイル:** `packages/server/src/__tests__/sync-routes.test.ts:86-99`

`queryFn` が SQL の `includes()` でルーティング。実装の SQL 変更でモックが一致しなくなるとデフォルト `{ rows: [], rowCount: 1 }` にフォールバックし、バグを隠す。

---

### H18. E2E テストで 3DS 失敗パスが未検証

E2E mock PAY.JP client は常に `three_d_secure_status: 'verified'` を返却。3DS 失敗時に「DB 書き込みが一切発生しない」ことの E2E レベル検証がない。unit テスト (billing-routes.test.ts:384-398) のみでカバー。

---

### H19. rate-limit.test.ts — google-submit テストが link_session Cookie で認証

**ファイル:** `packages/server/src/__tests__/rate-limit.test.ts:197`

`POST /v1/subscriptions/cancel/google-submit` はヘッダーベース認証だが、テストは `__Host-link_session` Cookie を送信。認証エラーが先に発生し、レートリミット到達前にエラーを返す。429 assertion が偶然成立している可能性。

---

### H20. e2e/cancel.test.ts:650-656 — 同時キャンセルテストの偽陽性リスク

`cancelCallCount <= 1` のみ検証。PAY.JP が 0 回呼ばれ、DB の `cancel_requested_at` 未設定のまま両リクエストが 200 を返す偽陽性が通り得る。キャンセル後の DB 状態を直接確認する assertion がない。

---

## Medium

### M10. cancel-flow.test.ts:383-398 — cancelEffectiveAt が RFC3339 形式チェックのみで具体値未検証

日付計算バグがあっても RFC3339 regex マッチだけで通過する。`cancelEffectiveAt === expected.toISOString()` の具体値 assertion 推奨。

---

### M11. subscribe-flow.test.ts:701 — clearInflightOperation の呼び出し回数のみ検証、引数未チェック

`toHaveBeenCalledTimes(1)` だが `toHaveBeenCalledWith(MEMBER_ID)` がない。誤った member ID で inflight 解除しても通過。

---

### M12. main.test.ts:91-95 — 非同期完了が `setTimeout(0)` 依存で脆弱

`await new Promise(r => setTimeout(r, 0))` は Promise マイクロタスクキューの完全解消を保証しない。複数 `await` チェーンで競合状態リスク。

---

---

# Iteration 5: Convergence Check — 高リスクパス深堀り

## Critical

### C6. webhook.ts:201 — advisory lock キーが billing-service と異なりレースコンディション

**ファイル:** `packages/sync-service/src/shell/webhook.ts:201,229` vs `packages/billing-service/src/shell/cancel.ts:48` / `subscribe.ts:123`

| コンポーネント | lockKey | lock 関数 |
|---|---|---|
| billing (subscribe/cancel) | `"member:<UUID>"` | `pg_try_advisory_lock(0, hashtext($1))` |
| webhook | `discord_user_id` or `member.id` (prefix なし) | `pg_advisory_xact_lock(0, hashtext($1))` |

同一メンバーに対して billing と webhook が **異なるキーでロックを取得** するため、相互排他にならない。

**シナリオ:**
1. ユーザーがブラウザで cancel を実行 → billing が `"member:uuid-xxx"` でロック取得
2. 同時に PAY.JP が更新 webhook を送信 → webhook が `"123456789"` (discord_user_id) でロック取得
3. 両方がロックを取得し、DB の `subscription_status` / `access_end_at` を同時更新
4. 最後に書き込んだ方が勝ち、状態が不整合になる可能性

**修正案:** webhook の lockKey を `"member:${member.id as string}"` に統一。

---

---

# Iteration 6: Final Convergence Check — auth-service OAuth + pure core

auth-service shell/index.ts（426行）と core/index.ts（全 pure functions）を精査。
新規の Critical/High/Medium 発見なし。Confidence >= 80% の新規 issue ゼロ。

**確認済み:**
- OAuth state は `consumeOAuthState` で原子的に消費（replay 防止）
- Discord access_token は暗号化保存 or 即時 revoke（REQ-AUTH-016 準拠）
- link_session 保存失敗時も access_token revoke あり
- Origin 検証: missing Origin は same-origin ブラウザリクエストとして許可（FIND-008）
- pure core: `isExpired` / `isUsed` / `validateOAuthStateRecord` / `validateLinkSessionRecord` すべて正常

---

## Convergence 確定

Iteration 6 で新規 issue ゼロ。**Convergence 達成。**

## 最終統計

**全体統計: C6 / H20 / M12 / L3 = 41件**

| Iteration | 新規件数 | 対象領域 |
|-----------|---------|---------|
| 1 | 12 | billing / auth / sync / admin |
| 2 | 7 | frontend / routes / shared+DB |
| 3 | 12 | Docker/nginx / scripts / 仕様整合 |
| 4 | 8 | テスト品質 + カバレッジ |
| 5 | 1 | convergence check (lock key race) |
| 6 | 0 | **convergence confirmed** |

**発見率の推移:** 12 → 7 → 12(新領域) → 8 → 1 → **0** — convergence 達成。

## 修正優先度（推奨）

### Tier 1 — Go-Live 前に修正必須 (Critical)
- C1: charge reconciliation `paid` 未検証
- C2: resync catch サイレント握りつぶし + ループ中断
- C3: `__Host-link_session` 失敗時未消費（仕様違反）
- C6: webhook-billing advisory lock キー不整合（レースコンディション）

### Tier 2 — Go-Live 前に修正推奨 (Critical + 高影響 High)
- C4: CR-001 仕様乖離（仕様 CR 起票）
- C5: billing-routes テスト withTransactionLock 空オブジェクト
- H1: cancel periodEnd fallback 不整合
- H2: 503 + stale operationId
- H3: syncRoleIds エラー握りつぶし
- H6: E2E planRoleMapping 不整合
- H15: Discord ロール同期リトライ未実装

### Tier 3 — Go-Live 後に対応可 (残りの High + Medium)
- 残り H/M/L 30件
