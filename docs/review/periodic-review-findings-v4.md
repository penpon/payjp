# Periodic Review Findings — 2026-04-16 v4

v2修正(13ファイル staged on `fix/periodic-review-v2-findings`)の品質検証 + 未カバー領域の新規発見。
5エージェント並列投入: Security / Silent Failure / Code Quality / Test Coverage / Payment Integration

**v2/v3 既出は除外。本ドキュメントは真に新規の findings のみ記録。**

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 4     |
| Medium   | 5     |
| Low      | 4     |
| Test Gap | 3     |

**Total: 16 findings (Iteration 1)**

---

## v2 修正品質 — 検証結果

| v2 ID | 修正内容 | 判定 |
|-------|---------|------|
| C1 (subscribe.ts paid check) | `!existingCharge.paid` → 422 | **PASS** |
| C2 (cli.ts error logging) | err束縛 + 構造化ログ + best-effort | **PASS** |
| C3 (cancel.ts consume timing) | consumeSession/Token を lock後・PAY.JP前に移動 | **PASS** (§8 item 3 準拠) |
| C6 (webhook.ts lockKey) | `member:${member.id}` 統一 | **PASS** |
| H1 (cancel.ts periodEnd) | 3段fallback | **PASS** |
| FIX-1 (finalizeSuccess dead code) | 型+実行ブロック両方削除 | **PASS** |
| FIX-2 (H2 stale operationId) | ログ強化 | **PASS** |

**追加確認:**
- lockKey一貫性: subscribe.ts / cancel.ts / webhook.ts すべて `member:<UUID>` — **PASS**
- session vs xact lock 非対称性: PostgreSQL仕様上相互排他成立 — **PASS**
- 3DS verified / operationId before PAY.JP / 503+operationId / __Host- Cookie / SQL injection / sensitive masking — 全 **PASS**
- isSameOrigin RFC 6454 準拠 — **PASS**
- buildSyncDepsForE2EPlain 呼び出し側更新 — **PASS**

---

## High

### V4-H1. subscribe.ts:350-370 — reconciliation 成功時に元の createCharge エラーが未ログ

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:350-370`

`createCharge` 失敗 → `member.payjp_initial_charge_id` 存在 → `fetchCharge` で `paid: true` → `initialChargeId = existingCharge.id` で処理続行。このパスでは**元の `err`（createCharge の失敗原因: カード拒否 / ネットワーク等）が一切ログに残らない**。

reconciliation 失敗パス (catch) や `paid: false` パスではログが出るが、成功パスのみブラックホール。運用時に「charge は成功したがなぜ createCharge が一度失敗したか」の調査が不能。

**修正案:**
```typescript
if (member.payjp_initial_charge_id) {
  slog('warn', 'createCharge failed, attempting reconciliation', {
    email: normalizedEmail, operationId, originalError: String(err),
  });
  // existing reconciliation code...
```

---

### V4-H2. access-gate.routes.ts:56 — Origin 欠落時にチェックスキップ

**ファイル:** `packages/server/src/routes/access-gate.routes.ts:55-58`

```typescript
if (origin && !isSameOrigin(origin, billingDeps.config.frontendBaseUrl)) {
  return reply.status(403).send({ error: 'Forbidden' });
}
```

`Origin: null` / ヘッダー未送信 → チェック全体がスキップ。curl等の非ブラウザクライアントがパスコードを知っていればアクセスゲート通過可能。

**仕様との関係:** §8 item 5 は `/v1/subscriptions`, `/cancel/google-form-link`, `/cancel` を列挙しており、`/v1/access-gate/verify` は**未列挙**。したがって仕様違反ではないが、防御層として追加した origin チェックが `null` を素通しにする点は defense-in-depth の穴。

**比較:** `handleSubscribe` (subscribe.ts:97) / `handleCancel` (cancel.ts:514) は `isSameOrigin(origin, ...)` を呼び、`origin` が falsy なら `false` を返すため**常に検証される**。

**修正案:** `if (!origin || !isSameOrigin(origin, ...))` に変更。SameSite=Lax Cookie + rate limit が既に存在するためリスクは限定的。

---

### V4-H3. failure-handling.test.ts:508 — テストタイトルが実装と矛盾

**ファイル:** `packages/billing-service/src/__tests__/integration/failure-handling.test.ts:508`

テストタイトル: `"link session retained"` (保持)
アサーション: `expect(deps.db.consumeLinkSession).toHaveBeenCalled()` (消費済み)

§8 item 3 の仕様変更（消費タイミング前倒し）に対してアサーションは正しく更新されたが、**タイトルが旧仕様のまま**。CI は通るが、レグレッション時にデバッグが混乱する。

**修正案:**
```typescript
it('Discord role revoke failure → 503, role_state=unknown, link session consumed (§8 item 3)', ...
```

---

### V4-H4. billing.routes.ts:252-255 — google-submit の email/token に minLength:1 なし

**ファイル:** `packages/server/src/routes/billing.routes.ts:252-255`

今回の変更で `/v1/subscriptions` の `planId`/`email`/`payjpToken` に `minLength:1` が追加されたが、`/v1/subscriptions/cancel/google-submit` の `email`, `token` フィールドには未適用。空文字が渡ると `handleGoogleCancelSubmit` 内の normalizeEmail が空文字を正規化し、signature 検証が意図しない状態で実行される。

**修正案:** `google-submit` の Fastify schema にも `minLength: 1` を追加。

---

## Medium

### V4-M1. api.ts — エラーメッセージ sanitization の不一致

**ファイル:** `frontend/src/api.ts`

`readSubscriptionStatusErrorMessage` は今回の修正でサーバーメッセージを無視する設計に変更（XSS/情報漏洩対策）。しかし同ファイル内の他関数はサーバーの `message` を Error オブジェクトに設定:

- L168: `AccessGateVerifyError` → `parsed.message`
- L216-220: `SubscribeError` → `parsedError.message`
- L262-265: `CancelError` → `parsedError.message`

これらの Error.message がフロントエンドで直接 DOM に挿入される場合、`readSubscriptionStatusErrorMessage` での対策と一貫しない。

**確認要:** UIコンポーネントでこれらの Error.message をどう表示しているか。textContent なら問題なし、innerHTML なら脆弱性。

---

### V4-M2. cli.ts:533-535 — best-effort catch ブロックが完全に空

**ファイル:** `packages/sync-service/src/shell/cli.ts:533-535`

```typescript
try {
  await insertImpactLog(deps.db, member.id as string, 'resync_individual_error', undefined);
} catch {
  /* best-effort */
}
```

外側の catch で既にエラー発生中（DB不安定の可能性大）。内側の `insertImpactLog` も同様に失敗しやすい状況で、失敗が完全にサイレント。`--all` モードで多数メンバーの impact log 保存が静かに失敗した場合に検知不能。

**修正案:**
```typescript
} catch (impactErr) {
  deps.log({
    timestamp: formatRfc3339Utc(deps.now()),
    service: 'sync-service', endpoint: 'cli/resync', result: 'error',
    error: 'impact_log_insert_failed_on_error_path',
    member_id: member.id as string,
    errorMessage: impactErr instanceof Error ? impactErr.message : String(impactErr),
  });
}
```

---

### V4-M3. cancel.ts:491-496 — INFLIGHT guard 後のセッション消費によるリトライ不能（設計レビュー）

**ファイル:** `packages/billing-service/src/shell/cancel.ts:487-496`

§8 item 3 は「認証前提検証通過後かつPAY.JP書き込み前に消費」と規定。現実装では `consumeLinkSession` → `applyImmediateCancelState` の順序。`applyImmediateCancelState` が `INFLIGHT_OPERATION` (既に処理中) を返した場合:

- セッションは消費済み → 同じトークンでリトライ不可
- PAY.JP書き込みは発生していない
- ユーザーは 503 を受け取り、次回アクセスで新規 link_session 取得から再開

**§8 item 3 の「成功/失敗に関わらず再利用不可」に準拠しており、仕様通りの動作。** ユーザーのリカバリパスは新規 link_session 取得（OAuth再実行）。ただし UX として INFLIGHT_OPERATION で消費される点は**仕様書に明示されていない暗黙の帰結**。

**修正不要（仕様準拠）。** ただし以下を推奨:
- コードコメントに「INFLIGHT case でもセッション消費は §8 item 3 に基づく意図的動作」と明記
- 503 レスポンスに「処理中のため再度ログインしてお試しください」等のガイダンスを含める

---

### V4-M4. api.ts:91 — `_res` 未使用引数残存

**ファイル:** `frontend/src/api.ts:91`

```typescript
async function readSubscriptionStatusErrorMessage(_res: Response, fallbackMessage: string): Promise<string> {
```

`_res` はもはや使用されないデッドパラメータ。将来的に誰かが `_res` を再利用してサーバーメッセージをクライアントに伝搬させるリグレッションリスク。

**修正案:** 関数シグネチャから `_res` を削除し、呼び出し側も修正。ただし呼び出し箇所が多い場合は低優先度。

---

### V4-M5. subscribe.ts:356-370 — reconciliation charge が現在の operationId に紐付く保証なし

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:356-370`

`member.payjp_initial_charge_id` が存在する場合に `fetchCharge` で reconciliation するが、その charge が**現在の operationId** に紐付いていることを検証していない。別の operationId で過去に作成された charge が `payjp_initial_charge_id` に残存していた場合、異なるコンテキストの charge で subscription 作成に進行する可能性。

**リスク:** `payjp_initial_charge_id` は subscribe 成功時にのみ設定され、inflight 解除時にクリアされるため、実際に異なる operationId の charge が残存するシナリオは極めて限定的。metadata での operationId 照合は過剰防御の可能性。

**修正不要（低リスク）。** 将来 charge metadata に operationId を含める場合は検証追加を検討。

---

## Low

### V4-L1. cli.ts:653 — endpoint フィールド値の不整合

`syncRoleIds` 内ログのみ `endpoint: 'cli/syncRoleIds'`。同ファイルの他ログは全て `endpoint: 'cli/resync'`。ログ検索で `endpoint:cli/resync` 絞り込み時に Discord 同期失敗が漏れる。

**修正案:** `endpoint: 'cli/resync'` に統一、または意図的なら ADR コメント追加。

---

### V4-L2. billing.routes.ts:311 — cancel body schema の意図不明

```typescript
schema: { body: { type: 'object', additionalProperties: false } }
```

`properties` / `required` なしで `additionalProperties: false` → 空オブジェクト `{}` のみ許容。cancel は header/cookie からパラメータ取得するため機能的に正しいが、将来 body パラメータ追加時に 400 エラーになる罠。意図がコメントで説明されていない。

**修正案:** コメント追加 `// cancel uses header/cookie only; reject unexpected body props`

---

### V4-L3. invalidate CLI — 環境変数 bypass

`INVALIDATE_CONFIRM=1` 環境変数のみで全セッション無効化の確認をスキップ可能。CI/CD で意図せず設定される可能性。運用ドキュメントで注意喚起推奨。

---

### V4-L4. webhook.ts — unmapped plan の impact log 欠損

`logUnmappedPlanWarning` 内の `deps.db.query` が失敗した場合の catch では `warning` ログのみ。`unmapped_plan_id` に対する impact log が残らないケースがある。

---

## Test Coverage Gaps

### V4-T1. [HIGH] existingCharge.paid=false パスのテストがゼロ

`subscribe.ts:359` に追加された `if (!existingCharge.paid)` チェック。テストファイル全体を検索したが、reconciliation ブランチ自体を通すテストが存在しない。`failure-handling.test.ts` のフィクスチャは `payjp_initial_charge_id: null` のままで reconciliation に到達しない。

必要なテスト:
1. `paid: false` → 422 + `PAYJP_ERROR` + inflight 解除
2. `paid: true` → 正常続行
3. `fetchCharge` throws → 503 + `PAYJP_UNCERTAIN`

---

### V4-T2. [HIGH] access-gate origin 検証のテストがゼロ

`access-gate-routes.test.ts` に origin 関連テストなし。`billing-routes.test.ts` には subscribe の origin テストあるが、access-gate は別ファイル。

必要なテスト:
1. `origin: 'https://evil.com'` → 403
2. `origin: FRONTEND_BASE_URL` → 200 (passcode 正しい場合)
3. origin ヘッダーなし → 現行は通過（設計判断次第）

---

### V4-T3. [MEDIUM] periodEnd の access_end_at fallback 未テスト

`cancel.ts:199` の `nextBillingAt ?? member.access_end_at ?? now` の中間分岐。デフォルトフィクスチャは `next_billing_at` が非null のため `access_end_at` fallback に到達しない。

必要なテスト:
- `next_billing_at: null, access_end_at: 有効日時` → `periodEnd = access_end_at`

---

## 修正優先度（推奨）

### Tier 1 — 即修正（テストギャップ + ロジック）
- **V4-T1**: paid=false テスト追加（C1修正の検証不足）
- **V4-H1**: reconciliation 成功時の元エラーログ追加
- **V4-H3**: テストタイトル修正（1行変更）
- **V4-H4**: google-submit minLength:1 追加

### Tier 2 — Go-Live 前修正望ましい
- **V4-T2**: access-gate origin テスト追加
- **V4-H2**: access-gate origin null チェック強化
- **V4-M2**: best-effort catch ログ追加
- **V4-T3**: periodEnd fallback テスト追加

### Tier 3 — Go-Live 後対応可
- **V4-M1**: エラーメッセージ sanitization 一貫性確認
- **V4-M3**: INFLIGHT消費のコードコメント
- **V4-M4**: _res パラメータ削除
- **V4-L1〜L4**: Low severity items
