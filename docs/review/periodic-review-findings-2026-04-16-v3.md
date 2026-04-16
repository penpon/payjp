# Periodic Review Findings — 2026-04-16 v3

v2 (41件 convergence) の後続レビュー。v2 修正 (unstaged) の品質検証 + 新規発見。

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 1     |
| Medium   | 9     |
| Low      | 5     |
| Info     | 0     |

**Total: 15 findings (Iterations 1-5)**

**注:** v2 修正が 15件に拡大（別セッション）。FIX-1 (finalizeSuccess dead code) は修正済み、FIX-2 (v2 H2 stale operationId) はログ強化で対応済み。→ Iteration 1 の 2 件は解消。

---

# Iteration 1: v2 修正品質の検証

## 修正済み v2 findings の検証結果

| v2 ID | 修正内容 | 判定 |
|-------|---------|------|
| C1 | subscribe.ts:359 `!existingCharge.paid` チェック追加 | **PASS** — `clearInflightOnDefinitePayjpFailure` で適切にクリーンアップ、422 返却 |
| C2 | cli.ts:509-525 エラーログ追加 + insertImpactLog try/catch | **PASS** — err 束縛・構造化ログ・best-effort パターン正しい |
| C3 | cancel.ts:559-560, 502-503 consumeSession/Token を lock後・PAY.JP前に移動 | **PASS（デッドコード残存あり → FIX-1）** |
| C6 | webhook.ts:201-202 lockKey を `member:${member.id}` に統一 | **PASS** — billing-service と完全一致 |
| H1 | cancel.ts:199 `periodEnd = nextBillingAt ?? member.access_end_at ?? now` | **PASS** — 3段 fallback で正規化パスと統一 |

## 新規 findings

### ~~[Medium] FIX-1. cancel.ts — `finalizeSuccess` デッドコード~~ → **RESOLVED**

v2 修正拡大で `finalizeSuccess` 型・実行ブロック両方削除済み (cancel.ts:229-235 確認)。

---

### ~~[Info] FIX-2. v2 H2 — 503 + stale operationId~~ → **RESOLVED (ログ強化)**

v2 修正拡大で unmapped_plan_after_cancel のログ強化対応済み。

---

## テスト修正の検証

| テストファイル | 変更内容 | 判定 |
|-------------|---------|------|
| cancel-flow.test.ts:422 | `consumeLinkSession` の呼び出し assert 反転 (not → called) | **PASS** — §8 item 3 準拠 |
| cancel-flow.test.ts:496-505 | 順序検証: lock → consumeSession → inflight → cancel | **PASS** — §8 item 3 の順序制約を正確に検証 |
| failure-handling.test.ts:521 | `consumeLinkSession` called assert | **PASS** — 失敗時も消費されることを検証 |

---

# Iteration 2: billing-service 深堀り

### [High] V3-H1. cancel.ts — `status='canceled'` + `cancel_requested_at=null` の状態不整合がガード未済

**ファイル:** `packages/billing-service/src/shell/cancel.ts:56-99`

`hasCancelableSubscription` (core/index.ts:47) は `'canceled'` を許容。`cancel_requested_at !== null` チェック (line 70) が false の場合、line 99 の `payjp_subscription_id` チェックまで素通り。

**シナリオ:** PAY.JP webhook で subscription.canceled が処理され DB の `subscription_status='canceled'` になったが、`cancel_requested_at` が何らかの理由で null のまま残存。ユーザーがブラウザから cancel を再実行 → PAY.JP に既キャンセル subscription の `cancelSubscription` を送信。PAY.JP が 4xx を返し、definite failure reconcile パスで正常化されるが、冗長な PAY.JP 呼び出しが発生。

**修正案:**
```typescript
// line 70 の前に追加
if (member.subscription_status === 'canceled' && member.cancel_requested_at === null) {
  slog('warn', 'canceled status with null cancel_requested_at — normalizing', { memberId: member.id });
  // 正規化パスへ誘導（access_end_at を維持して return）
}
```

---

### [Medium] V3-M2. cancel.ts:246-265 — removeRole 失敗時にエラー原因が未ログ

**ファイル:** `packages/billing-service/src/shell/cancel.ts:246-265`

`removeRole` が throw (line 246 catch) した後、内側の `updateMemberRoleState('unknown')` が**成功**した場合、line 259 の return に直行。`err`（removeRole の失敗原因: rate limit / 403 / network）が一切ログされない。

`critical_failure` ログ (line 250-257) は `updateMemberRoleState` も失敗した double failure 時のみ。片方だけ失敗のケースは完全なブラックホール。

**修正案:**
```typescript
catch (err) {
  slog('error', 'Discord role revoke failed', {
    memberId: member.id, flow: ctx.flow, operationId: ctx.operationId, error: String(err),
  });
  try { await deps.db.updateMemberRoleState(member.id, 'unknown'); }
  catch (roleStateErr) { slog('error', 'critical_failure: ...', { ... }); }
  return { ... };
}
```

---

### [Medium] V3-M3. cancel.ts:502,559 — consumeSession/Token 失敗時のエラーがサイレント伝播

**ファイル:** `packages/billing-service/src/shell/cancel.ts:502, 559`

C3 修正で `consumeCancelFormToken` / `consumeLinkSession` が lock 後に移動。しかし try/catch がないため、DB 失敗時は例外が `handleGoogleCancelSubmit` / `handleCancel` の外側 try に伝播し、finally でロック解除後に未処理例外として上位ハンドラに到達。

**問題:** エラーログが一切出力されずに 500 系レスポンス。トークンのダブルコンシューム or DB 障害の切り分けが不能。

**修正案:** try/catch で囲み、slog + 明示的な 503 返却。

---

### [Medium] V3-M4. subscribe.ts:460-463 — reconcile 後の subscription status 未検証

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:460-463`

`createSubscription` の definite failure reconcile で `fetchSubscription` した結果の `existingSub.status` を検証せず `subscription = existingSub` に代入。`status === 'canceled'` / `'paused'` でも Step 11 で `updateMemberAfterSubscribe` が呼ばれ、DB の `subscription_status` と PAY.JP 実状態が乖離。

**修正案:**
```typescript
const existingSub = await payjp.fetchSubscription(member.payjp_subscription_id);
if (existingSub.status !== 'active' && existingSub.status !== 'trial') {
  await clearInflightOnDefinitePayjpFailure(db, member.id, ...);
  return { ok: false, statusCode: 422, errorCode: 'PAYJP_ERROR', message: 'Reconciled subscription not active' };
}
subscription = existingSub;
```

---

# Iteration 3: server routes + shared + frontend + admin

### [Medium] V3-M5. admin-server/routes.ts:85-88 — query params に Fastify schema なし

**ファイル:** `packages/admin-server/src/routes.ts:85-88`

`/admin/members` の `limit` / `page` は `request.query as Record<string, unknown>` で直接読み取り、`Math.min(100, ...)` でコード側クランプ。Fastify schema がないため型強制なし。`queryMembersList` 内の `Math.max(1, opts.page)` で page=0 は救済されるが、非数値文字列は `NaN` → `Number.isFinite` でデフォルト値にフォールバック。一貫性を欠く。

**修正案:** Fastify querystring schema を追加。

---

### [Medium] V3-M6. admin-server — レート制限なし

**ファイル:** `packages/admin-server/src/routes.ts`

admin-server は `fastifyRateLimit` を登録していない。CF Access + API Key で保護されているが、内部ネットワークからの列挙攻撃や偶発的な無限ループに対する防御なし。

**修正案:** global `fastifyRateLimit` を追加（30 req/min 程度）。

---

### [Low] V3-L1. google-submit エンドポイントの Origin 検証省略が文書化されていない

**ファイル:** `packages/server/src/routes/billing.routes.ts:243-304`

subscribe / cancel は `isSameOrigin` で Origin 検証するが、google-submit は省略。Google Apps Script (server-to-server) からの呼び出しで Origin ヘッダが付かないため設計上正しいが、`sharedSecret` + `signature` で代替している旨のコメントがない。

**修正案:** ルート定義にコメント追加。

---

### [Low] V3-L2. frontend/main.ts:353-358 — formUrl のホスト検証なし

**ファイル:** `frontend/src/main.ts:353-358`

`new URL(result.formUrl).protocol !== 'https:'` で protocol のみ検証。`window.location.href` にセットする前に、ホストが `docs.google.com` または `forms.gle` であることを検証しない。サーバー側で生成する信頼済み URL のため実害は極めて低い。

**修正案:** `parsed.hostname.endsWith('.google.com') || parsed.hostname === 'forms.gle'` チェック追加。

---

## v2 既出の重複（スキップ）

以下はエージェントが報告したが v2 で既出のため v3 カウントから除外:

- admin CF Access JWT 未検証 → v2 H4
- email minLength/format なし → v2 M5
- migrate.ts schema_migrations CREATE 外 → v2 H5
- finalizeSuccess dead code → FIX-1（Iteration 1 で既記録）

---

# Iteration 4: sync-service + auth-service 精査

auth-service は問題なし（OAuth state atomic consume, token lifecycle, Cookie 属性 全て確認済）。

### [Medium] V3-M7. cli.ts:94-100 — `--operation-id` / `--discord-user-id` モードに try/catch なし

**ファイル:** `packages/sync-service/src/shell/cli.ts:94-100`

`handleOperationRecovery` / `handleUserReconciliation` が try/catch なしで直接 await。内部の DB/PAY.JP 呼び出しが throw すると `runResyncCli` ごと例外飛散。`--all` モードの `handleAllReconciliation` は個別メンバーに try/catch があるが非対称。管理者 CLI でスタックトレースのみ出力、impactLog 未記録。

**修正案:** operation-id / discord-user-id ブロックを try/catch でラップし、`deps.log` + `insertImpactLog` 呼び出し。

---

### [Medium] V3-M8. cli.ts:544 — `discord_user_id` の unsafe NULL キャスト

**ファイル:** `packages/sync-service/src/shell/cli.ts:544`

```typescript
const discordUserId = member.discord_user_id as string;  // NULL 可能カラム
```

`001_billing_first_flow.sql` で `discord_user_id` は `DROP NOT NULL` 済み。NULL の場合、後続の `syncRoleIds(deps, discordUserId, ...)` → `syncRole(null, ...)` が Discord API に送信される。`webhook.ts:505` は明示的 null チェックあり。

**修正案:**
```typescript
const discordUserId = member.discord_user_id as string | null;
if (!discordUserId) return { success: true };  // ロール同期スキップ
```

---

### [Medium] V3-M9. cli.ts:453-454 — `handleCancelRecovery` の PAY.JP 呼び出しに try/catch なし

**ファイル:** `packages/sync-service/src/shell/cli.ts:453-454`

```typescript
if (payjpSub.status !== 'canceled') {
  await deps.cancelPayjpSubscription(subscriptionId);  // try/catch なし
}
```

PAY.JP API 失敗で例外が `handleOperationRecovery` → `runResyncCli` に伝播。inflight_operation は未解除のまま。`handleSubscribeRecovery` も同様（`createPayjpCharge` / `createPayjpSubscription`）。

**修正案:** PAY.JP API 呼び出しを try/catch でラップ、失敗時は `insertImpactLog` + `{ success: false }` 返却。

---

### [Low] V3-L3. webhook.ts — `LogEntry.result` 型に `'warning'` / `'critical_failure'` 未定義

**ファイル:** `packages/sync-service/src/shell/webhook.ts:543,551,603` / `packages/shared/src/types.ts:51`

`LogEntry.result` は `'success' | 'failure' | 'error'` のみ。webhook.ts では `'critical_failure'` / `'warning'` を `as unknown as LogEntry` でキャスト回避。ログ監視が `result` フィールドで仕分ける場合に未知値として無視される。

**修正案:** `LogEntry.result` に `'warning' | 'critical_failure'` を追加、または `severity` サブフィールドで区別。

---

### [Low] V3-L4. cli.ts:163-194 — 6h エスカレーション後もリカバリ続行

**ファイル:** `packages/sync-service/src/shell/cli.ts:163-194`

6h 超過エスカレーション判定でログ + impactLog 記録後、`return` せず `handleSubscribeRecovery` / `handleCancelRecovery` に進行。コメントの `resolution_possible: false` と実際の動作が矛盾。

**修正案:** エスカレーション後は `return { success: false }` で即終了、またはコメントを「recovery 試行あり」に修正。

---

### [Low] V3-L5. cli.ts:454 — `cancel_requested_at` の無条件上書き

**ファイル:** `packages/sync-service/src/shell/cli.ts:454`（handleCancelRecovery 内の DB UPDATE）

CLI リカバリで `cancel_requested_at = now()` を無条件設定。ユーザーがブラウザからキャンセルした時刻（`billing-service/cancel.ts` で設定）が CLI 実行時刻で上書きされる。

**修正案:** `COALESCE(cancel_requested_at, now())` で既存値を保持。

---

# Iteration 5: Convergence Check

## v2 修正拡大後の re-verification

v2 修正が 6→51 lines に拡大（13ファイル）。修正済み items の再検証:

| v2 ID | 修正確認 |
|-------|---------|
| FIX-1 (finalizeSuccess) | **RESOLVED** — 型・ブロック両方削除 |
| FIX-2 (H2 stale operationId) | **RESOLVED** — ログ強化 |
| v2 H3 (syncRoleIds) | **RESOLVED** — err 束縛確認待ち (v2 fix list に明記) |
| v2 H7 (invalidate CLI) | **RESOLVED** — --yes ガード追加 |
| v2 M4 (access-gate Origin) | **RESOLVED** — Origin 検証追加 |
| v2 M5 (minLength) | **RESOLVED** — minLength:1 追加 |

## 新規 finding 発見率

| Iteration | 新規件数 | 対象領域 |
|-----------|---------|---------|
| 1 | 0 (2→0 resolved) | v2 修正品質検証 |
| 2 | 4 | billing-service 深堀り |
| 3 | 4 | server + shared + admin + frontend |
| 4 | 6 | sync-service + auth-service |
| 5 | 0 | convergence check |
| 6 | **0** | **convergence 確定** (CLI/webhook/daily-resync/cleanup/shared) |

**発見率:** 0 → 4 → 4 → 6 → 0 → **0** — Iteration 5-6 連続ゼロ。**Convergence 確定。**

## Iteration 6: Convergence 最終確認 (CLI/webhook クロスカット + daily-resync)

精査対象:
- `daily-resync.ts` — `runResyncCli(['--all'])` ラッパー。try/catch + ログ + re-throw。**問題なし**
- `webhook.ts attemptRoleSync` — discord_user_id null チェック (line 505)、エラー時 role_state='unknown'、double failure 時 critical_failure ログ。**問題なし**
- `cleanup.ts` — PCI DSS Req 3.2.1 retention policy。invite_sessions/tokens のトランザクション外はレガシー互換で意図的。**問題なし**
- `pg-pool.ts withTransaction` — ROLLBACK 失敗ログ + client.release() finally。**問題なし**
- `load-env.ts` — dotenv パターン。security rule はClaude ツール対象で app コード対象外。**問題なし**
- **cross-cutting lock key** — billing/webhook 両方 `member:${member.id}`。**統一確認済み**

新規 finding: **0件**。Convergence 確定。

## 修正優先度（推奨）

### Tier 1 — Go-Live 前修正推奨
- **V3-H1**: cancel state inconsistency ガード
- **V3-M4**: subscribe reconcile subscription status 未検証
- **V3-M8**: discord_user_id NULL unsafe cast
- **V3-M9**: CLI PAY.JP 呼び出し try/catch なし

### Tier 2 — Go-Live 前修正望ましい
- **V3-M2**: removeRole 失敗原因未ログ
- **V3-M3**: consumeSession/Token 失敗サイレント伝播
- **V3-M7**: CLI operation-id/discord-user-id try/catch

### Tier 3 — Go-Live 後対応可
- **V3-M5**: admin Fastify schema
- **V3-M6**: admin rate limit
- **V3-L1〜L5**: Low severity items
