# Periodic Review Findings — 2026-04-16 v4

v3 (15件 H1/M9/L5) convergence 後の新ラウンド。4 並列エージェント (security / silent-failure / logic / test) による多角精査。

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 11    |
| Medium   | 10    |
| Low      | 6     |

**Total: 27 findings (Iteration 1 — 4 agents complete)**

---

## 修正優先度

### Tier 1 — Go-Live 前修正必須
- **V4-H1** cli.ts insertImpactLog 空 catch → 無音全滅
- **V4-H2** cli.ts PAY.JP 成功後 DB 更新 try/catch なし → 課金重複リスク
- **V4-H6** subscribe.ts fetchToken isUncertainError 未適用 → 不確定障害を 422 で返却
- **V4-H7** cancel.ts finalizeImmediateCancel stale operationId 返却
- **V4-H9** cli.ts inflight_operation_started_at null unsafe キャスト → TypeError crash
- **V4-T1** existingCharge.paid テストゼロ
- **V4-T2** handleGoogleCancelSubmit §8 item 3 オーダリングテスト不在
- **V4-T3** access-gate Origin ガードテスト不在

### Tier 2 — Go-Live 前修正望ましい
- **V4-H3** access-gate insertAccessGateSession try/catch なし
- **V4-H4** subscribe.ts issueMemberSessionToken 失敗無通知
- **V4-H5** webhook unknown_status insertImpactLog なし
- **V4-H8** e2e-serve.ts 0.0.0.0 リッスン
- **V4-M4** billing.routes catch で operationId 欠落
- **V4-M5** access-gate Origin null スキップ
- **V4-M6** handleGoogleCancelSubmit consume TOCTOU

### Tier 3 — Go-Live 後対応可
- 残りの Medium / Low 全件

---

# Iteration 1: Agent A — Silent Failure Hunter

### [High] V4-H1. cli.ts:531-534 — `insertImpactLog` 空 catch でエラー完全消去

**ファイル:** `packages/sync-service/src/shell/cli.ts:531-534`

```typescript
try {
  await insertImpactLog(deps.db, member.id as string, 'resync_individual_error', undefined);
} catch {
  /* best-effort */
}
```

DB が完全ダウン（接続プール枯渇）時、outer catch の `reconcile_member_threw` ログも書けず `--all` 実行全体が無音失敗。

**修正案:** `catch (impactErr)` で束縛し `deps.log` で `impact_log_insert_failed_in_error_path` を出力。

---

### [High] V4-H2. cli.ts:274,288,318,333 — PAY.JP 書き込み成功後の DB 更新に try/catch なし

**ファイル:** `packages/sync-service/src/shell/cli.ts:274, 288, 318-320, 333-337`

`createPayjpCharge` / `createPayjpSubscription` 成功後の `db.query('UPDATE members SET ...')` に try/catch なし。DB 更新失敗時、PAY.JP には課金オブジェクト作成済みだが DB 反映なし。CLI 再実行で `createPayjpCharge` 重複実行リスク。

**修正案:** 各 DB 更新を try/catch、失敗時は `insertImpactLog` で「PAY.JP 成功・DB 失敗」コンテキスト付記録。

---

### [High] V4-H3. access-gate.routes.ts:90-93 — `insertAccessGateSession` に try/catch なし

**ファイル:** `packages/server/src/routes/access-gate.routes.ts:90-93`

DB 障害時 Fastify グローバル error handler に到達、応答形式 (`{ ok: false, errorCode }`) と不一致。フロントの `parseErrorBody` が `errorCode: 'UNKNOWN'` に化ける。

**修正案:** try/catch + `503 + DB_ERROR` 形式返却。

---

### [High] V4-H4. subscribe.ts:176-184 — 既存サブスクリプション短絡時 `issueMemberSessionToken` 失敗が無通知

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:176-184`

`issueMemberSessionToken` は内部 catch で `undefined` 返却。`ok: true` だが Cookie 未発行。後続 `/v1/members/me` で認証不可。Step 13 は "Non-fatal" コメントあり、Step 6 は言及なし。

**修正案:** Step 6 に "Non-fatal" コメント追加 + `slog('warn', 'session_token_issuance_failed_step6', ...)` 追加。

---

### [High] V4-H5. webhook.ts:338-339 — `unknown_status` パスで `insertImpactLog` なし

**ファイル:** `packages/sync-service/src/shell/webhook.ts:338-339`

`unknown_status` は異常イベント。DB には `process_status: 'failed'` 記録だが member 単位の impact log 未記録。リカバリ CLI 対象選定シグナル不在。

**修正案:** `insertImpactLog(deps.db, txResult.lockedMember.id, 'webhook_unknown_status', ...)` 追加。

---

### [Medium] V4-M1. frontend/api.ts — `linkDiscord` に timeout/catch なし

**ファイル:** `frontend/src/api.ts:327`

他関数 (`createSubscription`, `createCancelFormLink`) は `AbortSignal.timeout(30000)` 設定済みだが `linkDiscord` は未設定。`fetch` throw（ネットワーク断）も未 catch。

**修正案:** `AbortSignal.timeout(30000)` + try/catch 追加。

---

### [Medium] V4-M2. billing.routes.ts:153-186 — orphan session の無ログ

**ファイル:** `packages/server/src/routes/billing.routes.ts:153-186`

有効セッション Cookie → `findMemberById` null → `{ subscription: null }` 200 OK。DB 不整合で「未購読」誤表示。warning ログなし。

**修正案:** `member === null` 時に `slog('warn', 'orphaned_member_session', { memberId })` 追加。

---

### [Medium] V4-M3. invalidate-access-gate-sessions-cli.ts:39-42 — スタックトレース消失

**ファイル:** `packages/server/src/invalidate-access-gate-sessions-cli.ts:39-42`

`err.message` のみで `err.stack` 破棄。緊急 CLI でデバッグ情報が最重要。

**修正案:** `console.error(err)` でオブジェクト全体出力。

---

### [Low] V4-L1. e2e-serve.ts:101-109 — シャットダウン時の空 catch

**ファイル:** `packages/server/src/e2e-serve.ts:101-109`

E2E 専用だが接続残留デバッグ困難化。`console.warn` 推奨。

---

# Iteration 1: Agent B — Test Coverage Analyzer

### [High] V4-T1. subscribe.ts:359 — `existingCharge.paid === false` パスのテストゼロ

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:359`

課金調整パスのクリティカルブランチ。ガードが消えると unpaid チャージで購読続行。

**推奨テスト (failure-handling.test.ts PROP-BILL-053b):**
- `createCharge` 4xx + 既存 `payjp_initial_charge_id` + `fetchCharge` returns `paid: false` → 422 + `clearInflightOperation`
- 同ケース + `paid: true` → 購読継続

---

### [High] V4-T2. cancel.ts:490 — `handleGoogleCancelSubmit` §8 item 3 オーダリングテスト不在

**ファイル:** `packages/billing-service/src/shell/cancel.ts:490`

`handleCancel` には PROP-BILL-063 で検証あり。`handleGoogleCancelSubmit` は対応なし。

**推奨テスト:** `consumeCancelFormToken → setInflightOperation → cancelSubscription` 順序検証。

---

### [High] V4-T3. access-gate.routes.ts:56 — Origin ガードテスト不在

**ファイル:** `packages/server/src/routes/access-gate.routes.ts:56`

新規 `isSameOrigin` チェック。テスト不在。ガード削除してもグリーン。

**推奨テスト:**
- `origin: 'https://evil.com'` → 403
- `origin` 省略 → 正常処理

---

### [Medium] V4-T4. cancel.ts:199 — `periodEnd` フォールバック `access_end_at ?? now` テスト欠落

PAY.JP `current_period_end = 0` + `next_billing_at = null` + `access_end_at` ありのシナリオ未テスト。

---

### [Medium] V4-T5. cancel.ts:266-293 — `unmapped_plan_after_cancel` テスト欠落

`roleId` null → 503 + `DISCORD_ROLE_REVOKE_FAILED` パス。テスト不在。

---

### [Medium] V4-T6. billing.routes.ts:311 — `additionalProperties: false` バリデーション未テスト

キャンセルルートの新規スキーマ。余分プロパティ拒否の検証なし。

---

### [Low] V4-T7. failure-handling.test.ts:228 — `withTransactionLock` モック `fn({})` 残存

`billing-routes.test.ts` は `fn(db)` に修正済み。他テストは旧パターン残存。

---

# Iteration 1: Agent C — Security Reviewer

### [High] V4-H6. subscribe.ts:208-228 — `fetchToken` 失敗時の無条件 422（`isUncertainError` 未適用）

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:208-228`

`fetchToken()` の catch で `isUncertainError` 未判定。ネットワーク障害 (5xx/timeout) でも一律 `clearInflightOperation` + 422。クライアントが「トークン無効」と誤解して再試行誘発。`fetchToken` は READ-only で PAY.JP 書き込み不伴のため inflight clear は安全だが、ステータスコードが誤り。

**修正案:** catch 内で `isUncertainError(err)` 確認。true → `503 + PAYJP_UNCERTAIN + operationId`。false (404) → 現行 422 維持。

---

### [High] V4-H7. cancel.ts:258-264,286-292 — `finalizeImmediateCancel` 503 時に cleared 済み operationId 返却

**ファイル:** `packages/billing-service/src/shell/cancel.ts:258-264, 286-292`

PAY.JP cancel 成功 → `updateMemberAfterCancel` で `inflight_operation_id = NULL` 済み → Discord role revoke 失敗で 503 返却時に `operationId` 含む。CLI で `--operation-id` 指定しても DB にヒットなし。cancel 自体は完了、残件は Discord role のみ（resync 回収可）。

**修正案:** 503 から `operationId` 除去、または `role_sync_required` 別キーで返す。

---

### [High] V4-H8. e2e-serve.ts:96 — `host: '0.0.0.0'` リッスン

**ファイル:** `packages/server/src/e2e-serve.ts:96`

E2E 専用だが `DATABASE_URL` を環境変数から読む。本番環境で誤起動時に実 DB 接続状態で全インターフェース公開。

**修正案:** `NODE_ENV === 'production'` 拒否ガード、または `host: '127.0.0.1'` 固定。

---

### [Medium] V4-M4. billing.routes.ts:104-121,223-239,285-302,325-342 — 最外 catch で operationId 欠落 503

**ファイル:** `packages/server/src/routes/billing.routes.ts`

各ルートの最外 catch が `503 + INTERNAL_ERROR` を返すが `operationId` 不在。`setInflightOperation` 後の中間状態で throw した場合、手動 CLI 復旧に必要な情報喪失。

**修正案:** `handleSubscribe` / `handleCancel` が例外を throw しない設計の徹底（ほぼ達成済み）を単体テストで固める。

---

### [Medium] V4-M5. access-gate.routes.ts:55-57 — Origin null でチェックスキップ

**ファイル:** `packages/server/src/routes/access-gate.routes.ts:55-57`

`origin && !isSameOrigin(...)` で Origin ヘッダなし (curl 等) はスキップ。パスコード自体がシークレットで timingSafe 比較のため実リスク低いが、CORS バイパスを厚くするなら `origin === null` も 403 化。

**修正案:** `!origin || !isSameOrigin(origin, ...)` に変更。

---

### [Medium] V4-M6. cancel.ts:491-493 — `consumeCancelFormToken` と `applyImmediateCancelState` 間 TOCTOU

**ファイル:** `packages/billing-service/src/shell/cancel.ts:491-493`

advisory lock 取得後、`consumeCancelFormToken` → `applyImmediateCancelState`。consume 成功後に `setInflightOperation` 失敗 → トークン消費済み + inflight 未設定 + キャンセル未実行 = 再試行不能。

**修正案:** consume と setInflight を同一トランザクション化、または setInflight を consume 前に実行。

---

### [Low] V4-L2. webhook.ts:629-631 — `handleDbError` が DB エラーメッセージを直接ログ出力

内部スキーマ情報（テーブル名・制約名）漏洩源。`maskSensitiveLogFields` 未適用。

---

### [Low] V4-L3. cli.ts:331-336 — `handleSubscribeRecovery` 新規 subscription 作成時に advisory lock なし

CLI 二重実行で subscription 重複作成リスク。

---

### [Low] V4-L4. e2e-mocks.ts:37,43,47-48 — ハードコードされたテスト用シークレット

テスト専用で実害なし。E2E 環境が公開ネットワーク上なら環境変数化検討。

---

### [Low] V4-L5. billing.routes.ts:84,92 — `linkSessionToken` 未使用フィールド

`SubscribeRequest` に含まれるが `handleSubscribe` で不使用。混乱の元。

**修正案:** 除去、または `// reserved for future use` コメント。

---

# Iteration 1: Agent D — Logic / Dead Code Reviewer

### [High] V4-H9. cli.ts:245 — `inflight_operation_started_at` null unsafe キャスト

**ファイル:** `packages/sync-service/src/shell/cli.ts:245`

`member.inflight_operation_started_at as Date` で `.getTime()` 呼び出し。DB スキーマ上 NOT NULL 制約なし。null 時 `TypeError: Cannot read properties of null` で処理クラッシュ → inflight member が復旧不能。

**修正案:**
```typescript
const inflightStartedAt = member.inflight_operation_started_at as Date | null;
if (!inflightStartedAt) {
  await insertImpactLog(deps.db, memberId, 'subscribe_recovery_no_inflight_started_at', operationId);
  return { success: false };
}
```

---

### [Medium] V4-M7. frontend/api.ts:91-94,103 — `readSubscriptionStatusErrorMessage` dead parameter

**ファイル:** `frontend/src/api.ts:91-94, 103`

`_res: Response` を受け取るが本体で不使用。`async` も不要。`fallbackMessage` をそのまま返すのみ。

**修正案:** 関数削除、呼び出し箇所を直接 `const message = fallbackMessage;` に置換。

---

## v3 重複（スキップ）

以下は v3 で既出のためカウント外:
- V3-M3: consumeSession/Token 失敗サイレント伝播 → V4 では TOCTOU 観点 (V4-M6) で再報告
- V3-M9: cli.ts PAY.JP 呼び出し try/catch なし → V4 では DB 更新側 (V4-H2) を報告

---

# Iteration 1 補完: 追加 Parallel Agent Findings

以下は Agent A-D と同時に実行した追加 4 エージェント (Security-Deep / Silent-Failure-Deep / Logic-Consistency / Test-Coverage) から得られた、既存 findings と重複しない新規項目。

## Critical

### V4-C1. subscribe.ts:335-406 — 新規 createCharge 成功後の `charge.paid` 未検証

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:335-406`

`payjp.createCharge()` が例外なしでも `paid: false` を返す場合がある（残高不足等）。reconcile パスは v2 C1 修正で `existingCharge.paid` チェック済みだが、**新規作成パスでは未チェック**。

**影響:** 未払い charge で subscription 発行。Go-Live 前必須修正。

**修正案:**
```typescript
initialChargeId = charge.id;
if (!charge.paid) {
  await clearInflightOnDefinitePayjpFailure(db, member.id, normalizedEmail, operationId, 'createCharge');
  return { ok: false, statusCode: 422, errorCode: 'PAYJP_ERROR', message: 'Charge was not paid', operationId };
}
```

---

## High

### V4-H10. cancel.ts:548 — handleCancel でロック後の link_session 再チェック欠落

**ファイル:** `packages/billing-service/src/shell/cancel.ts:541-548`

`handleGoogleCancelSubmit` はロック後に `lockedToken.used_at !== null` を再チェック (L459-475)。`handleCancel` はロック後に `linkSession` 再検証なし。DB 側 `AND used_at IS NULL` で二重消費は防がれるが、例外が operationId なしの 503 として伝播。

---

### V4-H11. cancel.ts:491,548 — token 消費後の `applyImmediateCancelState` 失敗でトークン消耗 (V4-M6 の拡張)

**ファイル:** `packages/billing-service/src/shell/cancel.ts:490-496, 547-552`

V4-M6 (TOCTOU) の具体的影響: `consumeLinkSession` 後に `hasCancelableSubscription` / `hasInflightOperation` チェック失敗 → トークン消費済み + キャンセル未実行。**再試行不可**。

**修正案:** 状態チェックを token 消費前に先行実施。

---

### V4-H12. pool.ts — pg.Pool に `error` イベントハンドラ未登録でプロセスクラッシュ

**ファイル:** `packages/shared/src/db/pool.ts:3-17`

アイドル接続でサーバーサイド切断 → unhandled `error` イベント → **Node.js プロセスクラッシュ**。本番 DB 瞬断でサーバー全体ダウン。

**修正案:** `pool.on('error', (err) => console.error(JSON.stringify({ level: 'error', service: 'db-pool', ... })))` 追加。

---

### V4-H13. pg-db-client.ts:500-519 — acquireAdvisoryLock の rows[0] undefined ガードなし

**ファイル:** `packages/shared/src/db/pg-db-client.ts:500-519`

`result.rows[0].pg_try_advisory_lock` で `rows[0]` undefined なら TypeError。catch で捕まるが汎用 503 に化け、operationId 含まず。

---

## Medium

### V4-M8. subscribe.ts:395-407 — `!charge` ガード到達不能コード

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:395-407`

catch ブロック全分岐が `return` するため `if (!initialChargeId)` は常に false。到達不能。V4-C1 の `charge.paid` チェックで代替すべき。

---

### V4-M9. billing.routes.ts:247-259 — google-submit の email に minLength なし

**ファイル:** `packages/server/src/routes/billing.routes.ts:247-259`

cancel.ts の後段で弾かれるが多層防御欠如。`email: { type: 'string', minLength: 1, maxLength: 254 }`。

---

### V4-M10. subscribe.ts:122 — upsertProvisionalMemberByEmail に try/catch なし

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:122`

ロック前の例外が routes 層汎用 catch に流れ `email` も `planId` もログされない。

---

### V4-M11. pg-pool.ts:29-44 — ROLLBACK 失敗時のログが console.error のみ

**ファイル:** `packages/shared/src/db/pg-pool.ts:29-44`

構造化ログ基盤に乗らない。ROLLBACK 失敗は深刻な DB 状態シグナル。

---

### V4-M12. pg-db-client.ts:522-537 — releaseAdvisoryLock の戻り値未検査

**ファイル:** `packages/shared/src/db/pg-db-client.ts:522-537`

`pg_advisory_unlock` が `false`（ロック非保持）でもチェックなし。`lockClients` から先に削除済みのため次のロック取得で DB 側競合リスク。

---

### V4-M13. webhook.ts:308 — new Date() 直接使用（clock 非注入）

**ファイル:** `packages/sync-service/src/shell/webhook.ts:308, 375`

billing-service は `clock()` DI 経由だが webhook.ts のみ `new Date()` 直使用。テスト時刻制御不能。

---

### V4-M14. core/index.ts:164 — SENSITIVE_FIELD_PATTERN が PAY.JP ID 系を除外

**ファイル:** `packages/billing-service/src/core/index.ts:164`

`subscriptionId`/`customerId`/`chargeId` がマスクされず平文ログ。ログ流出時影響大。先頭4文字のみ表示検討。

---

### V4-M15. cli.ts:458 — canResolveInflightOperation 第2・3引数が同一

**ファイル:** `packages/sync-service/src/shell/cli.ts:458`

`canResolveInflightOperation('canceled', subscriptionId, subscriptionId, customerId)` — PAY.JP 実 ID と DB の ID の整合性チェックがバイパス。

---

### V4-M16. pg-db-client.ts:117 — toMember の null フィールド unsafe cast パターン

**ファイル:** `packages/shared/src/db/pg-db-client.ts:117-126`

`(row.discord_user_id as string) ?? null` — `as string` が先に評価され null でも型が `string` に。v3 M8 (discord_user_id unsafe cast) の根本原因。

---

## Low

### V4-L6. auth/index.ts:334 — link_session TTL ハードコード (900秒)

他 TTL は `AuthConfig` から設定可能だが link_session のみ固定。

---

### V4-L7. subscribe.ts:175,186 — Step 6 コメント重複

`// Step 6:` が2回出現。連番崩れ。

---

### V4-L8. subscribe.ts:133-136 — memberFresh 冗長変数

`memberFresh` を即座に `member` に再代入。中間変数不要。

---

# テスト網羅性ギャップ (追加 12 件)

### V4-TC01. subscribe — PLAN_ROLE_UNMAPPED エラーパス未検証
**実装:** `subscribe.ts:116-119` — planId 有効だが roleMapping 不在時の 422。

### V4-TC02. subscribe — createSubscription 失敗後の既存 subscription reconcile 未検証
**実装:** `subscribe.ts:454-487`

### V4-TC03. cancel — `cancel_requested_at` 設定済 + `access_end_at = null` 正規化パス未検証
**実装:** `cancel.ts:70-97`

### V4-TC04. subscribe — findMemberById null の TOCTOU ガード未検証
**実装:** `subscribe.ts:132-136` — `MEMBER_NOT_FOUND` 503。

### V4-TC05. subscribe — INVALID_EMAIL 検証未テスト
**実装:** `subscribe.ts:107-110`

### V4-TC06. cancel — handleCreateCancelFormLink の inflight ガード未テスト
**実装:** `cancel.ts:325-333`

### V4-TC07. subscribe — createSubscription uncertain failure 未テスト
**実装:** `subscribe.ts:440-452`

### V4-TC08. subscribe — setInflightOperation の planId 引数検証なし
**実装:** `subscribe.ts:189`

### V4-TC09. cancel — finalizeImmediateCancel の未マップ planId パス
**実装:** `cancel.ts:266-293`

### V4-TC10. webhook — livemode mismatch シェル統合テストなし
**実装:** `webhook.ts:93-108`

### V4-TC11. cancel — current_period_end = 0/null 境界値
**実装:** `cancel.ts:195-199`

### V4-TC12. subscribe — charge 既存 ID + paid:false reconcile 回帰テスト
**実装:** `subscribe.ts:356-368` — v2 C1 修正の回帰テストなし。

---

# 統合修正優先度 (全 findings)

## Tier 1 — Go-Live 前必須
- **V4-C1**: createCharge 後 paid 未検証 ⚠ 課金なしサブスク発行
- **V4-H12**: pg.Pool error handler なし ⚠ プロセスクラッシュ
- **V4-H11**: token 消費後の状態チェック失敗 ⚠ 再試行不可
- **V4-H2**: CLI PAY.JP 成功後 DB 更新 try/catch なし ⚠ 課金重複
- **V4-H6**: fetchToken isUncertainError 未適用 ⚠ 不確定→422 誤分類
- **V4-H9**: inflight_operation_started_at null crash ⚠ CLI クラッシュ
- **V4-T1/TC12**: charge.paid テストゼロ

## Tier 2 — Go-Live 前推奨
- **V4-H1,H3,H4,H5,H7,H8,H10,H13**: High 残り
- **V4-M1〜M6,M8〜M16**: Medium 全般
- **V4-T2,T3,TC01〜TC11**: テストギャップ

## Tier 3 — Go-Live 後
- **V4-L1〜L8**: Low 全件
- **V4-M7,T4〜T7**: Low-priority medium/test

---

## セキュリティ確認済み（問題なし）

- 3DS verified: `=== 'verified'` 厳格比較、`attempted` 拒否 ✓
- operationId BEFORE 書き込み: `setInflightOperation` → PAY.JP 呼び出し順序 ✓
- 不確定失敗: 全て `503 + operationId` 返却 ✓
- `__Host-` Cookie: Secure/Path=//HttpOnly/SameSite=Lax 固定 ✓
- OAuth state CSRF: SHA-256 + 原子的消費 ✓
- SQL injection: 動的カラムは静的 allowlist、値は全パラメタライズ ✓
- PAY.JP API キー: ログ・レスポンスに非露出、`maskSensitiveLogFields` 適用 ✓
- inflight 手動解除のみ: 自動解除コードなし ✓
