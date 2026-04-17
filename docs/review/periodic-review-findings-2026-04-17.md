# Periodic Review Findings — 2026-04-17

v4 (2026-04-16) 後の新ラウンド。`/loop` 5 分間隔の継続レビュー。
直近マージ済修正: #117 (Origin guard) / #121 #130 (path traversal) / #131 #133 (operationId on Discord failure) / #141 (payjp 3.1.1) + dep bumps。

## Summary (Iteration 1 — 4 並列 agent)

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 1     | NR-C1 |
| High     | 16    | A01-A03, NR-H1-H3, H1-H4, T1-T6 |
| Medium   | 20    | B01-B06, NR-M1-M4, M1-M6, T7-T11 |
| Low      | 11    | C01-C04, NR-L1, L1-L3, T12-T14 |

**Total: 48 findings (v4 既報告除外)**

---

## 修正優先度

### Tier 1 — Go-Live 前修正必須 (7 件)

- **NR-C1** subscribe.ts updateMemberAfterSubscribe と clearInflightOperation の非原子性 → 課金完了後の inflight 永続ブロック
- **A01** sync webhook livemode フィールド省略で本番/テスト分離バイパス
- **A03** webhook unknown_status impact_log 未記録 (V4-H5 未修正継続)
- **NR-H1** subscribeRecovery subscription ページング fail-close 欠落 → 重複 subscription 作成
- **NR-H2** buildSubscriptionResponse 未保護 throw → payjp_plan_id=null で 500 漏洩
- **NR-H3** subscription status mapSubscriptionStatus 未適用 → 未知ステータス DB 汚染
- **T2** updateMemberAfterSubscribe DB 失敗のリグレッションテスト不在

### Tier 2 — Go-Live 前修正望ましい (12 件)

- **A02** X-Cancel-Secret / X-Google-Cancel-Secret ヘッダ二重受け付け
- **A04** CF Pages Functions ヘッダスマグリング (Host / X-Forwarded-For 全転送)
- **NR-M1** reconcileMember access_end_at DB 非反映
- **NR-M2** saveOAuthState 失敗時の未処理例外
- **NR-M4** unmapped_plan 経路の operationId 欠落
- **B02** GET /v1/members/me Origin 空文字列許可
- **B03** access-gate POST verify Sec-Fetch-Site 非対称実装
- **B04** cancel.ts finalize 早期リターンでの link_session 未消費
- **H3** maskSensitiveLogFields の 3 パッケージ重複実装
- **H4** formatRfc3339Utc の billing/sync 重複
- **T1** createCharge paid=false 拒否パスのテスト不在
- **T6** V3-H1 正規化分岐の防護テスト不在

### Tier 3 — Go-Live 後対応可 (29 件)

残り Medium / Low 全件。dead-code / over-engineering 系は主に Tier 3。

---

# Iteration 1 (2026-04-17) — 4 並列 agent 出力

## Agent A — Security Review

### [High] A01. sync-service/src/core/index.ts:187 — livemode フィールド省略で本番/テスト分離バイパス

**ファイル:** `packages/sync-service/src/core/index.ts:187`

`determineIgnoreReason` は `event.livemode !== undefined` の場合のみ livemode 検証を行う。PAY.JP がフィールドを省略したイベントが本番で処理される。

```typescript
if (event.livemode !== undefined && isLivemodeMismatch(event.livemode, expectedLivemode)) {
    return 'livemode_mismatch';
}
```

**影響:** テスト環境イベントが本番 DB の `subscription_status` を書き換え、Discord ロールの誤付与/剥奪発生の可能性。
**修正案:** `event.livemode === undefined` も `'livemode_mismatch_field_absent'` で `ignored` 扱い、または PAY.JP 仕様明示確認の記録。

---

### [High] A02. packages/server/src/routes/billing.routes.ts:328-333 — X-Cancel-Secret / X-Google-Cancel-Secret ヘッダ二重受け付け

**ファイル:** `packages/server/src/routes/billing.routes.ts:328-333`

```typescript
const sharedSecret =
  typeof h['x-cancel-secret'] === 'string'
    ? h['x-cancel-secret']
    : typeof h['x-google-cancel-secret'] === 'string'
      ? h['x-google-cancel-secret']
      : '';
```

攻撃面が 2 倍、`verifySharedPasscode` で安全側 fail だが `x-google-cancel-secret` フォールバックの存在意義が不明。

**影響:** defense-in-depth 低下。設定ミスで空文字列 fallback ヒットの可能性あり。
**修正案:** `x-cancel-secret` のみ受け付け、`x-google-cancel-secret` フォールバック削除。

---

### [High] A03. packages/sync-service/src/shell/webhook.ts:338-339 — unknown_status 後の impact_log 未記録 (V4-H5 未修正継続)

**ファイル:** `packages/sync-service/src/shell/webhook.ts:338-339`

```typescript
if (txResult.type === 'unknown_status') {
  await attemptRoleSyncAllRoles(deps, txResult.lockedMember, 'revoke', 'role_sync_failed_unknown_status');
}
```

`payjp_events` には `process_status: 'failed'` 保存されるが、`member_impact_logs` にエントリなし。`--all` CLI の `APP_IMPACT_LOGS_OPEN` 自動検知対象外。

**影響:** PAY.JP が未知ステータス送信時の会員が監視からすり抜け、手動復旧遅延。
**修正案:** `attemptRoleSyncAllRoles` 前後に `insertImpactLog(deps.db, txResult.lockedMember.id, 'WEBHOOK_UNKNOWN_STATUS', ...)` 追加。

---

### [Medium] A04. frontend/functions/v1/[[route]].ts:40-43 — CF Pages Functions 全ヘッダ転送

**ファイル:** `frontend/functions/v1/[[route]].ts:40-43`

```typescript
const proxyRequest = new Request(targetUrl, {
  method: request.method,
  headers: request.headers,  // 全ヘッダ転送
  body: request.body,
  redirect: 'manual',
});
```

`Host` / `X-Forwarded-For` / `Cf-Connecting-Ip` が無検証で転送される。Fastify `trustProxy: true` 下で XFF 偽造によるレート制限バイパス可能性。最終防壁は nginx upstream IP チェック。

**影響:** Host ヘッダインジェクション (実装依存) / XFF 偽造によるレート制限バイパス。
**修正案:** `host` / `x-forwarded-for` / `x-real-ip` を除去してから転送。CF Workers 仕様を公式 doc で確認・コメント記録。

---

### [Medium] B01. packages/billing-service/src/core/index.ts:164 — maskSensitiveLogFields ネストサブフィールド未対応

**ファイル:** `packages/billing-service/src/core/index.ts:164`

`SENSITIVE_FIELD_PATTERN = /^(cookie|authorization|set-cookie|token|card|email)$/i` はトップレベルキーのみ。`{ member: { email: '...' } }` や `normalizedEmail` 変数名で渡すと素通り。

**影響:** 将来的な PII ログ露出リスク。
**修正案:** 再帰マスク、もしくは規約ドキュメント化 (「email キーは必ず `email` と命名」)。

---

### [Medium] B02. packages/server/src/routes/member.routes.ts:123 — GET /v1/members/me Origin 空文字列許可

**ファイル:** `packages/server/src/routes/member.routes.ts:60-63`

```typescript
if (origin && !isSameOrigin(origin, billingDeps.config.frontendBaseUrl)) {
  return reply.status(403).send({ error: 'Forbidden' });
}
```

Origin 空の場合 checkSkip。curl + `__Host-member_session` で会員情報取得可能。`__Host-` Cookie は HTTPS + 同一ホスト限定で発行されるため実害低だが、GET/POST 非対称。

**影響:** Cookie 盗難前提で会員情報 (memberId, subscriptionStatus, planId) 取得可能。
**修正案:** GET も Origin が存在するかに関わらず空 Origin は拒否。または設計意図を明示コメント。

---

### [Medium] B03. packages/server/src/routes/access-gate.routes.ts:64-75 — POST verify Sec-Fetch-Site 非対称

**ファイル:** `packages/server/src/routes/access-gate.routes.ts:63-75`

GET は `isForbiddenCrossSiteFetch` 共通ヘルパー、POST verify は独自ロジック。`Sec-Fetch-Site: ''` (空文字) を許容する非対称。

**影響:** パスコード自体は `timingSafeEqual` なので実害低、防御非対称。
**修正案:** POST verify も `isForbiddenCrossSiteFetch` に統一。

---

### [Medium] B04. packages/billing-service/src/shell/cancel.ts:662-664 — ブラウザ cancel finalize 早期リターンで link_session 未消費

**ファイル:** `packages/billing-service/src/shell/cancel.ts:662-664`

```typescript
if (pre.next === 'finalize') {
  return await finalizeImmediateCancel(pre.member, deps, { flow: 'browser', operationId: undefined });
}
```

`consumeLinkSession` は `pre.next === 'payjp'` パスのみ。`finalize` 側は TTL 15 分内に同一 link_session で複数回 Discord revoke リクエスト可能。初回成功後は `role_state === 'revoked'` で NOP だが、初回失敗 + unknown 状態で繰り返し発火。

**影響:** Discord Bot Token への重複 revoke リクエスト発生 (実害限定)。
**修正案:** `finalize` パスでも `consumeLinkSession` を soft ignore で呼ぶ。

---

### [Medium] B05. packages/sync-service/src/shell/webhook.ts:474 — updateMemberFromWebhook 動的カラム名構築

**ファイル:** `packages/sync-service/src/shell/webhook.ts:479-491`

`MEMBER_WEBHOOK_UPDATE_COLUMNS: ReadonlyArray<...>` の enum 値のみ使用、値は全パラメータ化。現状 SQL injection なし。将来の誤使用リスクのみ。

**影響:** なし (現状)。保守コスト懸念。
**修正案:** コメントで「カラム名は ReadonlyArray 由来」を明記、または型安全クエリビルダー検討。

---

### [Medium] B06. packages/auth-service/src/shell/index.ts:393-397 — link_session レスポンスに discordUserId 平文

**ファイル:** `packages/auth-service/src/shell/index.ts:393-397`

```typescript
return { statusCode: 200, body: { linked: true, discordUserId: record.discord_user_id } };
```

`isForbiddenCrossSiteFetch` が防御済みで同一オリジン以外取得不可。

**影響:** 実害ほぼなし。連携情報リーク扱いされる可能性。
**修正案:** フロント未使用なら除外、使用するなら HTTP-only 情報として運用明示。

---

### [Low] C01. packages/billing-service/src/core/index.ts:346 — verifyGoogleCancelSubmitSignature 長さ事前チェック

SHA-256 HMAC hex 常に 64 文字、情報理論的に安全。空文字列早期リターンは安全側 fail。現行で問題なし。

---

### [Low] C02. packages/server/src/app.ts:50 — trustProxy: true 全信頼

Cloudflare → nginx → Fastify チェーン。nginx の `proxy_set_header X-Forwarded-For` が適切であれば問題なし。
**修正案:** nginx `set_real_ip_from` + `real_ip_header CF-Connecting-IP` で CF IP のみ信頼、Fastify `trustProxy` を CF IP 範囲に限定。

---

### [Low] C03. packages/billing-service/src/shell/subscribe.ts:597-600 — subscription_id 平文ログ

`email` はマスクされるが `subscriptionId` (例: `sub_xxxxx`) は PAY.JP 内部 ID として内部者が照合可能。外部漏洩なし。

---

### [Low] C04. 二重のパストラバーサル防御実装

`assertSafeProxyRouteSegments` (実使用) と `isSafeCfPagesV1ProxyPathSuffix` (未使用) で実装が微妙に異なる。後者は `frontend/src/cf-pages-proxy-route.ts` にデッドコードとして存在。

**修正案:** 未使用側を削除、またはコメントで用途明記。Agent C の M6 と重複。

---

## Agent B — Logic Consistency Review

既修正確認済: V4-C1 (charge.paid 未検証) / V4-H1 (insertImpactLog 空 catch) / V4-H2 (PAY.JP 成功後 DB 更新 try/catch) / V4-H9 (inflight_operation_started_at null) / V4-H12 (pg.Pool error handler)。V4-H7 (stale operationId) は未修正継続。

---

### [Critical] NR-C1. packages/billing-service/src/shell/subscribe.ts:538-582 — updateMemberAfterSubscribe と clearInflightOperation の非原子性

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:538-582`
**仕様根拠:** `implementation-design-mvp.md §5.1 Step12`「成功時のみ inflight_operation_* クリア」、`§7`「inflight 残留中は 503」

```typescript
// Step 11: inflight クリアしない
updatedMember = await db.updateMemberAfterSubscribe(member.id, { ... });
// Step 12: 別クエリでクリア (失敗時に矛盾状態)
await db.clearInflightOperation(updatedMember.id);
```

Step 11 成功 → Step 12 失敗の窓で、課金完了済み + inflight 残留の矛盾状態。以降の再試行は Step 4 で `INFLIGHT_OPERATION 503` 永続化。

比較対照: `queryUpdateMemberAfterCancel` (pg-db-client.ts:419-422) は同一 SQL に `inflight_operation_id = NULL` 含む。

**影響:** Go-Live 後に DB 瞬断 1 回で課金完了済み会員が CLI なしでアクセス不能に。
**修正案:** `queryUpdateMemberAfterSubscribe` SQL に `inflight_operation_id = NULL, inflight_operation_type = NULL, inflight_operation_started_at = NULL, inflight_subscribe_plan_id = NULL` を統合、Step 12 の `clearInflightOperation` 呼び出し削除。

---

### [High] NR-H1. packages/sync-service/src/shell/cli.ts:388-412 — subscribeRecovery subscription ページング fail-close 欠落

**ファイル:** `packages/sync-service/src/shell/cli.ts:388-412`
**仕様根拠:** `implementation-design-mvp.md §5.6.3`「offset<=900 (最大1000) 上限到達+has_more=true→確定不能 fail-close」

```typescript
if (subOffset > 900 && result.has_more) break;  // ← fail-close なし
if (found) { subscriptionId = found.id; ... }
else {
  const sub = await deps.createPayjpSubscription(subParams);  // ← 重複作成リスク
```

charge 検索側 (行 325-327) は `hasMoreAtLimit` で正しく fail-close。subscription 側のみ欠落。

**影響:** 1000 件以上 subscription 履歴の顧客で重複作成、charge=1/subscription=1 保証崩壊。
**修正案:** `subHasMoreAtLimit` フラグ追加、break 前に立てる。ループ後 `if (subHasMoreAtLimit) { insertImpactLog + fail-close }`.

---

### [High] NR-H2. packages/billing-service/src/shell/subscribe.ts:176-177 — buildSubscriptionResponse 未保護 throw

**ファイル:** `packages/billing-service/src/shell/subscribe.ts:176-177`

Step 6 既存サブスクリプション短絡で `buildSubscriptionResponse(member)` を呼ぶが、`payjp_plan_id` / `access_end_at` が null のとき throw。`hasActiveSubscription` が true でも `payjp_plan_id` が null の可能性 (webhook 更新前 / 旧データ移行)。

```typescript
// core/index.ts:124
export function buildSubscriptionResponse(member: Member): SubscriptionResponse {
  if (!member.subscription_status || !member.payjp_plan_id || !member.access_end_at) {
    throw new Error('buildSubscriptionResponse: required fields are null');
  }
```

throw は advisory lock catch に届かず、`billing.routes.ts` 汎用 catch で `500/503 + operationId なし`。

**影響:** 一部会員の短絡パスで 500/503、operationId なしで調査困難。
**修正案:** Step 6 を try-catch で囲み、throw 時は `{ ok: false, statusCode: 503, errorCode: 'MEMBER_DATA_INCOMPLETE' }`。または `member.payjp_plan_id === null` の場合のみ短絡スキップ。

---

### [High] NR-H3. packages/sync-service/src/shell/cli.ts:409-412 — subscribeRecovery 発見 subscription の status が mapSubscriptionStatus 未経由

**ファイル:** `packages/sync-service/src/shell/cli.ts:409-412`
**仕様根拠:** `implementation-design-mvp.md §5.6.3`

```typescript
await deps.db.query(
  'UPDATE members SET payjp_subscription_id = $1, subscription_status = $2, updated_at = now() WHERE id = $3',
  [subscriptionId, found.status, memberId],  // ← 直接書込
);
```

`found.status` を直書き。webhook.ts では `mapSubscriptionStatus` + `isStatusUnknown` 二段検証。`createSubscription` 結果 (行 428-429) も同様。

**影響:** DB 制約次第で insert 失敗、制約なければ `hasActiveSubscription` 判定が狂う。
**修正案:** `mapSubscriptionStatus` 経由、null 時は `insertImpactLog` + fail-close。

---

### [Medium] NR-M1. packages/sync-service/src/shell/cli.ts:743-749 — reconcileMember access_end_at DB 非反映

**ファイル:** `packages/sync-service/src/shell/cli.ts:743-749`
**仕様根拠:** `implementation-design-mvp.md §5.6.1` 日次リシンク `access_end_at` 超過補正

```typescript
const newStatus = payjpSub.status as string;
await deps.db.query('UPDATE members SET subscription_status = $1, updated_at = now() WHERE id = $2', [newStatus, memberId]);
const cpe = (payjpSub as { current_period_end?: number }).current_period_end;
const mergedAccessEnd = cpe != null && cpe !== 0 ? new Date(cpe * 1000) : (member.access_end_at as Date | null);
// ← DB に書かない
```

`mergedAccessEnd` は判定のみ。翌日もズレが残る。

**影響:** `accessExpired` 誤 true → 課金継続中の会員が Discord アクセス喪失。
**修正案:** `cpe != null && cpe !== 0` 時に `access_end_at = $3, next_billing_at = $3` を UPDATE に含める。

---

### [Medium] NR-M2. packages/auth-service/src/shell/index.ts:406-410 — saveOAuthState 未処理例外

**ファイル:** `packages/auth-service/src/shell/index.ts:406-410`
**仕様根拠:** `implementation-design-mvp.md §3.2` DB 障害 = 503 期待

`/v1/auth/discord/start` の `saveOAuthState(db, ...)` に try-catch なし。DB 障害時 Fastify 汎用ハンドラで 500、CORS / Cache-Control 欠落。callback 側の `saveDiscordLinkSession` は try-catch で 302 リダイレクト。

**修正案:** try-catch + `{ statusCode: 503, headers: secHeaders }` 返却。

---

### [Medium] NR-M3. packages/sync-service/src/shell/cli.ts:563-574 — evaluateSubscriptionSearchResult の candidates[0] 依存

**ファイル:** `packages/sync-service/src/shell/cli.ts:563-574`

戻り値 `'single-match' | 'fail-close'` の 2 値で現状は問題なし。`evaluation !== 'fail-close'` の否定形で分岐しているため、将来の戻り値追加でサイレントバグリスク。

**修正案:** `if (evaluation !== 'single-match') { fail-close }` に変更して意図明示。

---

### [Medium] NR-M4. packages/billing-service/src/shell/cancel.ts:330-357 — unmapped_plan 時の operationId 欠落

**ファイル:** `packages/billing-service/src/shell/cancel.ts:330-357`
**仕様根拠:** `§3.2` 503 = 不確定失敗 + `operationId` 返却

`finalizeImmediateCancel` で `discord_user_id` あり + roleId なし (unmapped plan) 経路。PAY.JP cancel + DB update (inflight clear) 成功後、ここで 503 返却だが `ctx.operationId` は既にクリア済み。

**影響:** 運用者が CLI 復旧 operationId を得られない (日次再同期で自動補正可能なため致命ではない)。
**修正案:** 503 `message` に `Discord role unmapped, daily resync will recover` を含めて再同期で解決を明示。

---

### [Low] NR-L1. packages/sync-service/src/shell/webhook.ts:369-388 — plan 変更時 role swap 判定に古い member snapshot

`shouldSyncRole(oldStatus, newStatus) === false` で `oldStatus === newStatus` 保証のため機能的問題なし。コードの意図が不明瞭。

**修正案:** `txResult.newStatus` または ローカル `newStatus` を直接渡す。

---

## Agent C — Dead Code / Over-Engineering Review

### [High] H1. auth-service/src/core/index.ts:91-95 — buildCallbackRedirectUrl は identity 関数

```typescript
export function buildCallbackRedirectUrl(frontendBaseUrl: string): string {
  return frontendBaseUrl;
}
```

**削減:** 15 行。呼び出し 4 箇所で直接使用、テスト 2 件削除。

---

### [High] H2. auth-service/src/shell/index.ts:193-253 — レガシー 3 引数オーバーロードは production 未使用

production は全て新形式 (`AuthRequest` オブジェクト)。テスト `auth-flow.test.ts` のみ旧形式使用。

**削減:** 60 行。テスト書き換え後に overload + `handleLegacyAuthRequest` 削除。

---

### [High] H3. maskSensitiveLogFields が 3 パッケージで重複

- `packages/auth-service/src/core/index.ts:78-84`
- `packages/billing-service/src/core/index.ts:166-172`
- `packages/sync-service/src/core/index.ts:260-266`

パターン定数のみ微差 (auth: `code|token`、billing: `card|email` 追加、sync: `card`)。本体完全同形。`isSameOrigin` / `buildCookieAttributes` と同パターンで shared に統合可能。

**削減:** 30 行。

---

### [High] H4. formatRfc3339Utc が billing/sync 重複

- `billing/core/index.ts:152-157` (NaN チェックあり)
- `sync/core/index.ts:279-281` (NaN チェックなし、20+ 箇所で呼び出し)

**削減:** 12 行。`@hayane/shared` に NaN チェック版を統合、両パッケージから re-export。

---

### [Medium] M1. auth-service/shell/index.ts:46-48 — generateSecureRandomToken 不要 async

```typescript
export async function generateSecureRandomToken(): Promise<string> {
  return randomBytes(32).toString('hex');
}
```

`randomBytes` は同期。呼び出し側 3 箇所の `await` も除去可。

**修正:** `async` 削除、戻り型 `string` に。

---

### [Medium] M2. auth-service/shell/index.ts:51-84 — saveOAuthState / saveDiscordLinkSession / consumeOAuthState は薄すぎるラッパー

各関数が `db.method()` を 1 行呼ぶだけ。呼び出しはそれぞれ 1 箇所のみ。

**削減:** 25 行。`handleStructuredAuthRequest` 内で `db.*` を直接呼ぶ。

---

### [Medium] M3. billing-service/core/index.ts:244-247 — shouldGrantRole は billing では未使用

billing shell / server / production は import なし。テストのみで参照。実際のロール判定は sync-service 側。

**削減:** 10 行。関数とテスト `PROP-BILL-018` 削除。

---

### [Medium] M4. billing-service/core/index.ts:104-106 — accessGateSessionTokenHash は memberSessionTokenHash の別名

コメントで「同一ダイジェスト」と明記。同じハッシュを 2 名前で返すのは誤解を招く。

**削減:** 8 行。呼び出し 8 箇所を `memberSessionTokenHash` に置換。

---

### [Medium] M5. frontend/src/api.ts:91-94 — readSubscriptionStatusErrorMessage は identity wrapper

```typescript
async function readSubscriptionStatusErrorMessage(_res: Response, fallbackMessage: string): Promise<string> {
  return fallbackMessage;
}
```

**削減:** 6 行。インライン化。

---

### [Medium] M6. frontend/src/cf-pages-proxy-route.ts — path 検証ロジック重複デッドコード

`functions/v1/[[route]].ts` は `api-proxy-validation.ts` のみ使用、`cf-pages-proxy-route.ts` は未使用。テスト `__tests__/cf-pages-proxy-route.test.ts` のみ残存。

**削減:** 30 行 (+ テスト)。Agent A の C04 と重複。

---

### [Low] L1. validateRequiredEnvVars が 3 パッケージで同パターン

各パッケージの required 変数リストが異なる (DATABASE_URL のみ共通) ため一本化困難。パターン関数化のみ現実的。

---

### [Low] L2. validateFrontendBaseUrl が auth/billing 重複

同一正規表現 `/^https?:\/\/[^/]+$/`。エラーメッセージ文字列のみ微差。

**削減:** 12 行。`@hayane/shared` 移動。

---

### [Low] L3. sync-service/core/index.ts:219-227 — shouldGrantPaidDiscordAccess の _accessEndAt / _now 未使用パラメータ

意図的未使用 (コメント明記)。呼び出し 4 箇所がコスト払って渡し続けている。仕様コメント豊富のため許容可。

---

## Agent D — Test Coverage Review

### [High] T1. subscribe.ts:421-429 — createCharge paid=false 拒否パス未テスト

`failure-handling.test.ts` は「定常失敗 + 既存 charge」はテスト済みだが、`createCharge` が HTTP 200 + `paid: false` を返す PAY.JP 仕様パスは未カバー。`clearInflightOperation` 呼び出し検証なし。

**追加案:**
- `it('createCharge returns paid=false → 422 PAYJP_ERROR, clearInflightOperation called once')`
- `it('createCharge paid=false → inflight cleared, operationId returned')`

---

### [High] T2. subscribe.ts:538-570 — updateMemberAfterSubscribe DB 失敗パス未テスト

`subscribe-flow.test.ts` Step 7-10 失敗は全カバーだが Step 11 失敗未テスト。**NR-C1 Critical の回帰テスト欠落**。

**追加案:**
- `it('updateMemberAfterSubscribe DB failure → 503 + operationId, PAY.JP charges exist')`
- `it('updateMemberAfterSubscribe failure → clearInflightOperation NOT called (inflight retained for CLI)')`

---

### [High] T3. subscribe.ts:132-135 — findMemberById returns null after lock (MEMBER_NOT_FOUND)

webhook 側は `INT-SYNC-037` で対応だが subscribe 側テスト不在。

**追加案:**
- `it('findMemberById returns null after lock acquisition → 503 MEMBER_NOT_FOUND')`

---

### [High] T4. subscribe.ts:108-110 — INVALID_EMAIL 422 パス未テスト

`INVALID_EMAIL` errorCode の実装あり、統合テスト / ルートテスト共に未カバー。

**追加案:**
- `it('returns 422 INVALID_EMAIL when email is empty string')`
- `it('returns 422 INVALID_EMAIL when email lacks domain part')`
- `it('returns 422 INVALID_EMAIL when email is missing @ symbol')`

---

### [High] T5. subscribe.ts:116-119 — PLAN_ROLE_UNMAPPED 未テスト

planId が allowedPlanIds にあるが planRoleMapping に未登録の設定ミスが運用まで検知されない。

**追加案:**
- `it('returns 422 PLAN_ROLE_UNMAPPED when plan exists in allowlist but has no role mapping')`

---

### [High] T6. cancel.ts:68-93 — V3-H1 正規化分岐の防護テスト不在

`cancel_requested_at === null && subscription_status === 'canceled'` 正規化は実装済みだが `cancel-flow.test.ts` に対応なし。リグレッション検知されない。

**追加案:**
- `it('canceled status with null cancel_requested_at → normalizes and routes to finalize path')`
- `it('canceled+null normalization DB fail → 503 DB_UPDATE_FAILED')`

---

### [Medium] T7. subscribe.ts:479-529 — createSubscription 失敗 + 既存 payjp_subscription_id reconcile (V3-M4)

PROP-BILL-053c は `payjp_subscription_id: null` のみ。既存 reconcile ロジック未カバー。

**追加案:**
- `it('createSubscription definite failure + existing active sub → continues to Step 11')`
- `it('createSubscription definite failure + existing non-active sub → 422 PAYJP_ERROR')`

---

### [Medium] T8. cancel.ts:133-141 — NO_ACCESS_END 未テスト

`subscription_status === 'active'` + `access_end_at === null` のキャンセル。

**追加案:**
- `it('returns 409 NO_ACCESS_END when subscription is active but access_end_at is null')`

---

### [Medium] T9. auth-flow.test.ts — Discord token exchange / fetchDiscordUserId 失敗パス

正常系のみ。ネットワークエラー / 5xx 時の callback 挙動未カバー。

**追加案:**
- `it('callback 500 when Discord token exchange fails with network error')`
- `it('callback 500 when Discord user ID fetch fails')`

---

### [Medium] T10. cross-cutting.test.ts:145-167 — PROP-BILL-057 ヘルスチェックは実装無関係

テスト内でインライン定義した `buildHealthResponse` を呼ぶだけ。`/health` 実装をテストしていないデッドテスト。

**追加案:**
- `it('GET /health returns 200 when DB query succeeds')` — `buildApp` 経由
- `it('GET /health returns 503 when DB throws')`

---

### [Medium] T11. daily-resync.test.ts — 成功時のメンバー単位状態確認不足

ログは検証済みだが `syncRole` が正しく呼ばれるか / `UPDATE members` 発行の確認なし。

**追加案:**
- `it('runDailyResync with active member → syncRole called with grant')`

---

### [Low] T12. webhook-flow.test.ts:536-551 — 429 retry mock が単一成功 resolve

`mockResolvedValue(undefined)` で initial 429 → retry success パターン未検証。

**修正案:** `mockRejectedValueOnce` → `mockResolvedValueOnce` パターン採用。

---

### [Low] T13. subscribe-flow.test.ts:354-358 — 大文字 email 正規化未検証

PROP-BILL-024 は `EMAIL` 定数 (小文字) 使用のみ。大文字→正規化→同引数の検証欠如。

---

### [Low] T14. その他

positive observations として operationId 永続化順序 (PROP-BILL-030/048)、3DS 4 ステータス拒否、webhook fast-check、link session 消費確認は strong。継続改善で十分。

---

# 次イテレーション候補

Iteration 2 (次 5 分後の cron fire) で深掘りする範囲:

1. **admin-server** (今回未レビュー) — 認証境界、API 公開範囲、SSRF
2. **frontend/src** 深掘り — XSS、Suspense境界、エラー UI パターン
3. **Docker / infra** — compose.yml セキュリティ、dockerfile 多段最適化、image CVE
4. **E2E テスト品質** — `tests/e2e/` フレーキ検出、セレクタ品質
5. **CI/CD workflow** — secret 漏洩、action pinning、permission
6. **DB schema + migration** — 可逆性、ロック時間、データロス
7. **Dependency audit** — transitive CVE、supply chain、license

---

## 方針メモ

- CLAUDE.md `§2 Simplicity First` 違反 (H1-H4, M1-M6) は Tier 3 だが合計 200 行削減可能、PR 化容易
- `NR-C1` は Go-Live ブロッカー候補、最優先で修正 PR 作成推奨
- `A01` livemode bypass は PAY.JP 仕様確認 → 修正判断
- 既に v4 で報告された `V4-H5` (unknown_status impact_log) は未修正継続 → A03 と同一、再優先付け

---

# Iteration 2 (2026-04-17) — admin-server / infra / E2E / CI-CD

4 並列 agent: admin-security / docker-infra / e2e-review / ci-cd-audit

## Summary (Iteration 2)

| Severity | Count |
|----------|-------|
| High     | 11    |
| Medium   | 18    |
| Low      | 13    |
| Info     | 1     |

**Iter 2 total: 43 件 / 累計 Iter1+2: 91 件 (Critical 1 / High 27 / Medium 38 / Low 24 / Info 1)**

## Iter2 Tier 1 — Go-Live 前修正必須 (5 件)

- **IT2-ADM-F01** admin-server CF Access 未設定時の x-admin-api-key フォールバック + nginx ヘッダ strip 欠落
- **IT2-ADM-F09** nginx で `cf-access-jwt-assertion` 未 strip (CF Tunnel 未導入時に顕在)
- **IT2-DOCKER-F01-F03** Dockerfile マルチステージ未使用 / useradd 順序 / image digest 未ピン
- **IT2-E2E-T4** T-P0-05 退会完了フローが E2E 層でゼロカバー (Go-Live 判定直結)
- **IT2-CI-H1** 全 GH Actions が SHA 未ピン (adRise/update-pr-branch が contents:write 保有)

## Iter2 Tier 2 — Go-Live 前推奨 (14 件)

- IT2-ADM-F02 JWT `algorithms` 未指定 / F03 TCP-only healthcheck / F04 jose エラー文字列ログ / F05 status allowlist 不在
- IT2-DOCKER-F04-F08 dev Dockerfile 残存 / nginx 0.0.0.0 listen / .dockerignore / CF 実IP 復元 / DB env 平文
- IT2-E2E-T1-T3 退会 URL 未検証 / CSS セレクタ依存 / serial Cookie 汚染
- IT2-CI-H2 ci.yml permissions: 欠落 / M1 concurrency 未設定 / M3 postgres:16 digest 未ピン / M4 vitest バージョン不整合

## Iter2 Tier 3 — Go-Live 後対応可 (残 24 件)

---

## Iter2 Agent A — admin-server Security + Logic

### [High] IT2-ADM-F01. packages/admin-server/src/routes.ts:59-106 — CF Access 未設定時フォールバック + nginx x-admin-api-key 非 strip

```ts
if (cfTeamDomain && cfAudience) { /* JWT検証 */ }
// fallback: x-admin-api-key のみ認証
const localApiKey = parseHeaderValue(request.headers['x-admin-api-key']);
if (localActor && hasValidAdminApiKey(localApiKey, process.env.ADMIN_API_KEY)) { ... }
```

docker-compose L122-123 で両 CF 環境変数のデフォルトは空文字。CF Tunnel 未導入 + `.env` 設定漏れ時にベアヘッダー認証が silent activate。

**修正案:** 起動時「CF 変数両空時は `ADMIN_API_KEY` 必須」チェック + `process.exit(1)`。nginx で `proxy_set_header x-admin-api-key ""` 追加。

---

### [High] IT2-ADM-F09. nginx/nginx.conf:296-326 — `cf-access-jwt-assertion` を strip しない

admin location に `proxy_set_header cf-access-authenticated-user-email ""` はあるが JWT assertion の strip 欠落。CF Tunnel 未導入時はクライアントが任意トークン送信可能 (JWKS 検証は唯一の壁)。

**修正案 (Tunnel 導入後):** `proxy_set_header cf-access-jwt-assertion ""`。

---

### [Medium] IT2-ADM-F02. cf-access-jwt.ts:39 — `algorithms` ピン留め未指定

```ts
await jwtVerify(params.token, JWKS, { issuer, audience: params.audience }); // algorithms 未指定
```

jose v5 は `none` を自動拒否だが RS256/ES256 明示ピンで alg confusion 耐性を強化。テストも HS256/none 拒否ケース追加を。

---

### [Medium] IT2-ADM-F03. docker-compose.yml:136-144 — admin healthcheck が TCP のみ

認証ミドルウェア破損 (全リク 401) でも `healthy` 判定。`/healthz` 追加 + healthcheck HTTP 化推奨。

---

### [Medium] IT2-ADM-F04. routes.ts:53 + cf-access-jwt.ts:49 — JWT エラー文字列をそのまま warn ログ

jose の `e.message` をログ `reason` として出力。将来 payload (email) がエラーに混入する実装が入ると PII 漏洩。カテゴリ化 (`jwt_expired` / `jwt_invalid` / `jwt_verify_error`) を推奨。

---

### [Medium] IT2-ADM-F05. queries.ts:109-116 — subscription_status / role_state allowlist 不在

パラメータ化済で SQLi なし。ただし任意文字列を受け入れる。allowlist バリデーションで入力規約を明示すべき。

---

### [Low] IT2-ADM-F06 / F07 / F08 / F10 / F11

- F06 ADMIN_FRONTEND_ORIGIN URL 形式バリデーション不在
- F07 監査ログが pathname のみ、クエリパラメータ欠落
- F08 payjp_customer_id / payjp_subscription_id 平文レスポンス (CF Access allowlist 下)
- F10 impact-logs LIMIT 500 固定ページネーション不在
- F11 nginx で x-admin-api-key 非 strip (実害なし、ヘッダ整理)

**確認済み良好点:** SQL 全パラメータ化、UUID バリデーション、LIKE エスケープ、POST/PATCH/DELETE 405 返却 (readonly 完全)、timingSafeEqual、CSP/HSTS/X-Frame-Options 全設定、docker network 分離、`read_only: true`。

---

## Iter2 Agent B — Docker / nginx

### [High] IT2-DOCKER-F01. Dockerfile / Dockerfile.admin — マルチステージビルド未採用

`npm ci` で devDeps (biome, vitest, @types/*) が本番イメージ混入。`builder` stage で `npm ci` + `npm run build`、`runtime` stage で `npm ci --omit=dev` + `COPY --from=builder dist` に分離。

---

### [High] IT2-DOCKER-F02. Dockerfile L25, Dockerfile.admin L22 — useradd が npm ci 後

ユーザー作成を `npm ci` 前に移動し、root 実行区間を短縮 + キャッシュ効率化。

---

### [High] IT2-DOCKER-F03. Dockerfile L2 + docker-compose L9, L43 — image 固定不足

`node:22-bookworm-slim` / `postgres:17-alpine` / `nginx:alpine` タグ参照。特に `nginx:alpine` は Alpine メジャー追従で内容が変わる。`nginx:1.27.5-alpine` / `@sha256:...` digest ピン。

---

### [Medium] IT2-DOCKER-F04. Dockerfile.frontend L22 — dev サーバー起動の本番 Dockerfile

`CMD ["npm", "-w", "frontend", "run", "dev", "--", "--host"]`。compose 参照なしだが誤使用リスク。削除 or dev/prod 分離。

---

### [Medium] IT2-DOCKER-F05. nginx.conf L280 — admin vhost `listen 0.0.0.0:8443`

compose 側 `127.0.0.1:8443:8443` で mitigate 済み。ports 変更時に即 public 露出。コメントで意図明記済だが listen を `127.0.0.1:8443` / `admin-api:8443` に絞る方が堅牢。

---

### [Medium] IT2-DOCKER-F06. .dockerignore — テスト・ドキュメント・スクリプト未除外

`**/*.test.ts`, `**/*.spec.ts`, `vitest.config.*`, `scripts/`, `docs/`, `*.sh` を追記。

---

### [Medium] IT2-DOCKER-F07. nginx CF 実 IP 復元 (`set_real_ip_from`) 未設定

`$remote_addr` が CF エッジ IP になり rate limit が事実上機能しない。CF IPv4 範囲 + `real_ip_header CF-Connecting-IP` を追加。

---

### [Medium] IT2-DOCKER-F08. docker-compose L13-15 — DB パスワードが env 平文

op run 経由注入で mitigate 済み。`docker inspect` で平文表示。Swarm なしの compose v2 では secrets 選択肢限定、記録のみ。

---

### [Low] IT2-DOCKER-F09-F11, Info F12

- F09 Dockerfile に HEALTHCHECK 命令なし (compose のみ)
- F10 admin vhost の `/assets/` と `/` に `limit_req` なし (内部 8443 のみ)
- F11 api Dockerfile が `packages/` 全コピー (admin-server 含)
- F12 db ports コメントに「本番禁止」注記なし

---

## Iter2 Agent C — E2E Tests

### [High] IT2-E2E-T1. e2e/tests/member-journey.spec.ts:34-38 — 退会フロー Google Form URL 未検証

`waitForURL(docs.google.com)` で終了。トークン付き URL か否かの検証なし。T-P0-05 Green「署名付きワンタイムトークン入り URL」要件が未カバー。

**修正案:** `page.waitForResponse('**/google-form-link')` で body 取得、`expect(body.googleFormUrl).toMatch(/docs\.google\.com.*token=/)` 検証。

---

### [High] IT2-E2E-T2. e2e/tests/subscribe-negative.spec.ts:67-73 — `.submit-button` CSS セレクタで DOM 強制クリック

```ts
document.querySelector('.submit-button')  // e2e.md 禁止の CSS クラス依存
```

クラス名変更 (Tailwind 移行等) で即壊れる。`aria-disabled` 切り替えで逆に通過する偽陽性。

**修正案:** `data-testid="subscribe-button"` 付与 + `locator().evaluate()`。サーバー側 POST 弾きは別テストへ分離。

---

### [High] IT2-E2E-T3. member-journey.spec.ts:5 — `serial` mode での Cookie 汚染リスク

`beforeEach` に `context.clearCookies()` なし。`__Host-link_session` の持ち越しで非決定的挙動。serial 除去 or `newContext()` 明示。

---

### [High] IT2-E2E-T4. e2e/tests/ 全体 — T-P0-05 退会完了フロー E2E 未カバー

`google-submit` エンドポイントへのスタブ呼び出しなし。Go-Live 判定 T-P0-05「subscription_status=canceled + role_state=revoked」の E2E 層がゼロ適合。

**修正案:** `page.route('**/cancel/google-submit', ...)` スタブ、退会完了画面 + `cancelEffectiveAt` 表示検証テスト追加。

---

### [Medium] IT2-E2E-T5-T8

- T5 422 `INVALID_PLAN` エラー UI 表示検証欠如
- T6 `payjp-mock.ts` の `tokenBehavior: 'error'` 定義ありテスト無し
- T7 oauth-session.spec.ts `page.evaluate` の CORS Origin 送信不確定
- T8 playwright.config.ts `VITE_PAYJP_PUBLIC_KEY` ハードコードフォールバック (CI で throw 推奨)

---

### [Low] IT2-E2E-T9. smoke.spec.ts:9-16 — 1 テストに 3 シナリオ詰め込み

`legal static pages are served` が `/tokushou.html` + `/terms.html` + top リンクを直列検証。失敗時の分離コスト高。

---

### [Low] IT2-E2E-T10. subscribe-negative.spec.ts:41-49 — `__E2E_PAYJP_LAST_CREATE_TOKEN_ARGS` 実装詳細依存

`card.name` 引数構造アサートはリファクタで偽陽性失敗リスク。`three_d_secure: true` アサートは仕様保護として残置、引数検証はユニット層へ。

---

**E2E 総合評価: 5/10**。強み: payjp-mock 決定的化・503/401 `postCount===1` アサート・getByRole 中心。弱み: T-P0-05 未カバー / serial 依存 / 仕様トレーサビリティ不足。

---

## Iter2 Agent D — CI/CD + Supply Chain

### [High] IT2-CI-H1. 全ワークフロー Actions が SHA 未ピン

- `auto-update-pr.yml:15,17` — `checkout@v4`, `adRise/update-pr-branch@v0.10.2`
- `biome-autofix.yml:22,26` — `checkout@v6`, `setup-node@v6`
- `ci.yml:25,26` — 同上

`adRise/update-pr-branch` は `contents: write` + `pull-requests: write` を持つため最大被害。SHA ピン後 Dependabot が自動更新継続。

---

### [High] IT2-CI-H2. ci.yml — ワークフローレベル `permissions:` 未宣言

`auto-update-pr.yml` と `biome-autofix.yml` は宣言済、`ci.yml` のみ欠落。組織デフォルト継承。

```yaml
permissions:
  contents: read
  pull-requests: read
```

---

### [Medium] IT2-CI-M1. auto-update-pr.yml — `concurrency:` 未設定

Dependabot 連続マージで並列 update-pr 発火、同一 PR ブランチ push 競合。`concurrency: { group: auto-update-pr, cancel-in-progress: true }` 追加。

---

### [Medium] IT2-CI-M2. auto-update-pr.yml — `checkout@v4` vs 他 `@v6` 不整合

H1 対応時に統一。

---

### [Medium] IT2-CI-M3. ci.yml:12 — `postgres:16` タグ未ピン

digest ピン or パッチバージョン固定。Dependabot docker ecosystem 追加 (M-5 と連動)。

---

### [Medium] IT2-CI-M4. package.json:42 と各 packages/*/package.json — vitest バージョン不整合

root `^3.2.4` vs packages `^3.1.1`。npm workspace hoisting で CI は root 版だが宣言と乖離。`overrides` or 全パッケージ `^3.2.4` 統一。

---

### [Medium] IT2-CI-M5. dependabot.yml — Docker イメージ未カバー

npm + github-actions のみ。`postgres:16` セキュリティパッチ自動検知外。

---

### [Low] IT2-CI-L1. .nvmrc / package.json engines 未設定

Node 22 は CI のみ強制。ローカル 18/20 で tsx 挙動差異のデバッグ難化。

---

### [Low] IT2-CI-L2. biome-autofix.yml — 自動 commit の無限ループ未防止

`[skip ci]` or head_commit message 条件で防御。現ガード (空変更 quiet) は実害限定。

---

### [Low] IT2-CI-L3. ci.yml:36 — `npx tsc` で root typescript 未宣言

workspace hoisting 依存。ルート devDeps に明示追加。

---

**CI/CD 総合評価: 6.5/10**。強み: `npm ci` + `npm audit` + fork 除外ガード + `pull_request_target` 未使用。ギャップ: H-1 SHA ピン + H-2 permissions が最優先、M 系は一括対応可。

---

# 次イテレーション候補 (Iteration 3 以降)

1. **DB schema + migration** (`packages/shared/src/db/migrate.ts` + `schema.sql`) — 可逆性・ロック時間・DEFAULT NULL → NOT NULL 変更のデータロス
2. **frontend/src 深掘り** — XSS / Suspense / Error Boundary / CSP nonce / API error UI 網羅
3. **shared パッケージ** — Cookie / Origin / Crypto util の再テスト / edge case
4. **i18n / 日本語 / a11y** — 退会・購読 UI が getByRole で取れるか、コントラスト、キーボード操作
5. **DB backup restore drill** — age + B2 の実 restore 検証 (project_b2_offsite_backup_design.md 関連)
6. **ログ / メトリクス設計** — 既存 `docs/ops/external-monitoring.md` との整合性、アラート抜け

---

# Iteration 3 (2026-04-17) — DB / frontend / shared / a11y

4 並列 agent: postgres-pro / frontend-security / typescript-pro / accessibility-tester

## Summary (Iteration 3)

| Severity | Count |
|----------|-------|
| High     | 9     |
| Medium   | 19    |
| Low      | 17    |

**Iter 3 total: 45 件 / 累計 Iter1+2+3: 136 件 (Critical 1 / High 36 / Medium 57 / Low 41 / Info 1)**

## Iter3 Tier 1 — Go-Live 前修正必須 (新規 3 件)

- **IT3-SHARED-M01** (実質 Critical) `packages/server/src/cross-site-fetch.ts:36` — `Sec-Fetch-Site: none` が通過。ブラウザ top-level navigation から state-mutating POST が CSRF ガードをすり抜ける
- **IT3-DB-H3** `packages/shared/src/db/pg-db-client.ts:500-537` — advisory lock セッションスコープで `release` 漏れ時にコネクションリーク。プール枯渇で全 API 503
- **IT3-DB-H4** schema.sql — `first_trial_granted_at` 二重付与防止の DB 制約なし、二重トライアル = 課金損失

## Iter3 Tier 2 — 推奨 (14 件主要)

- IT3-DB-H1 schema.sql 全体を単一トランザクションで実行 (DDL エラーで全作成失敗)
- IT3-DB-H2 `subscription_status` CHECK が NULL 通過
- IT3-DB-M1-M7 migration・index・hashtext 衝突・pg_stat_statements 未設定・TTL retention 欠如
- IT3-FE-M01 formUrl ホスト未検証 (docs.google.com チェック欠落)
- IT3-FE-M03 formatDate 無効 ISO で生値フォールバック
- IT3-SHARED-M03 maskSensitiveLogFields が sync-service 側で email 未マスク
- IT3-A11Y-A01-A05 モーダルフォーカストラップ/復帰 / iframe ラベル紐付け / `outline: none` / disabled SR 通知

---

## Iter3 Agent A — DB Schema + Migration

### [High] IT3-DB-H1. migrate.ts:17-25 — schema.sql 全体を単一トランザクションで実行

`CREATE TABLE × 10 + INDEX × 15` を 1 BEGIN/COMMIT。`pgcrypto` EXTENSION 権限エラーで全ロールバック。pgcrypto 分離 + 個別 migration 化。

---

### [High] IT3-DB-H2. schema.sql:11 — subscription_status CHECK が NULL 通過

`CHECK (subscription_status IN (...))` は NULL を拒否しない。provisional 行は NULL を許容する仕様だが、整合性の明示が欠如。部分 CHECK (`subscription_status IS NOT NULL OR payjp_customer_id IS NULL`) で整合化。

---

### [High] IT3-DB-H3. pg-db-client.ts:500-537 — advisory lock セッションスコープでコネクションリーク

```ts
const client = await pool.connect();
// pg_try_advisory_lock → this.lockClients.set(lockKey, client)
// release されなければ永続リーク
```

`subscribe.ts:611-613` / `cancel.ts:597-599` は `finally` 実装済だが、ネットワーク断等の経路で release 漏れ可能。`pg_advisory_xact_lock` (TX スコープ) に統一、webhook は既に TX lock で一貫性あり。

**影響:** プロセス再起動なしにコネクション枯渇 → 全 API 503。本番最大リスク。

---

### [High] IT3-DB-H4. schema.sql — first_trial_granted_at に email スコープ UNIQUE 不在

```sql
-- 欠落
CREATE UNIQUE INDEX members_email_trial_once
  ON members (email) WHERE first_trial_granted_at IS NOT NULL;
```

advisory lock 外での並列リクエスト / 会員削除→再登録で二重トライアル付与リスク。課金損失直結。

---

### [Medium] IT3-DB-M1-M7

- M1 `schema_migrations` CREATE TABLE が BEGIN 外
- M2 `lower(email)` 関数インデックス欠如
- M3 `inflight_operation_id IS NOT NULL` 部分インデックス欠如
- M4 `members.created_at` インデックス欠如 (admin ORDER BY 対象)
- M5 TTL テーブル (oauth_states / link_sessions / cancel_form_tokens / payjp_events / impact_logs) クリーンアップポリシー不在
- M6 hashtext 衝突リスク (int32 空間、低確率で false serialization)
- M7 `pg_stat_statements` 未設定 → 障害時調査不能

---

### [Low] IT3-DB-L1-L3

- L1 `schema_migrations` INSERT `ON CONFLICT DO NOTHING` 失敗サイレント化
- L2 `cancel_form_tokens.email` が `members.email` と非同期 (将来のメール変更対応リスク)
- L3 `payjp_events.member_id` FK `ON DELETE NO ACTION` (GDPR 対応時の削除ブロック)

**DB 総合: 6/10**。強み: TIMESTAMPTZ 徹底、partial index 活用、schema_migrations。弱み: H3 コネクションリーク最優先対応、TTL retention 未実装、pg_stat_statements。

---

## Iter3 Agent B — Frontend XSS + Error UI

XSS ゼロ確認: 全 DOM 書込が `createTextNode` 経由、`innerHTML` / `eval` 使用なし。`target=_blank` は全 `rel="noopener noreferrer"` 付与。

### [Medium] IT3-FE-M01. main.ts:353-357 — formUrl ホスト未検証

```ts
if (parsed.protocol !== 'https:') throw ...
window.location.href = result.formUrl; // hostname 未検証
```

バックエンド侵害 or MITM 時に `https://attacker.com/phishing` へリダイレクト可能。`parsed.hostname !== 'docs.google.com'` チェック追加必須。

---

### [Medium] IT3-FE-M02. billing-ui.ts:102 — subscription.status フォールバックが生値

`STATUS_LABELS[subscription.status] ?? subscription.status`。未知ステータスで英語文字列が日本語 UI に漏洩。`?? '不明'` 固定に。

---

### [Medium] IT3-FE-M03. format.ts:10 — formatDate 無効 ISO 生値フォールバック

`new Date(isoString).getTime()` が NaN の場合に `return isoString`。サーバー由来文字列 (e.g. "Invalid date") が露出。`return '—'` 固定に。

---

### [Medium] IT3-FE-M04. billing-ui.ts:319-326 — エラーバナー SR アナウンス不発火

`role="alert"` は動的挿入時発火だが、`replaceChildren()` 一括差し替えで埋もれる。`#app` 直下に常設 `aria-live="assertive"` コンテナ、差分のみ更新パターンへ。

---

### [Medium] IT3-FE-M05. ui.ts:54-70 — パスコード空文字送信防止なし

`renderGateLocked` に disabled 制御なし。空文字送信でレート制限消費。`if (!input.value.trim()) return` 追加。

---

### [Low] IT3-FE-L01-L05

- L01 `map-cancel-error.ts` TypeError を `server_error` (retry 表示)、`map-subscribe-error.ts` は `inflight` (retry 禁止) で不整合。統一必要
- L02 `cancel_complete` state・`renderCancelComplete` デッドコード (Google Form 方式で未到達)
- L03 `three_ds_failed + operationId` 画面に back-to-top ボタンなし、リロード必要
- L04 widgets.ts:29 コピー fallback が `previousElementSibling` 依存で DOM 構造変更で崩壊
- L05 `AccessGateVerifyError.message` にサーバー生値保持 (UI 非露出だが DevTools で可視)

**Frontend security 評価: 8.0/10**。XSS/CSRF/二重課金/503 auto-retry 禁止は堅固。減点は M01 formUrl ホスト未検証、M04 SR アクセシビリティ、L01 マッピング不整合。

---

## Iter3 Agent C — shared package

### [Medium/Critical] IT3-SHARED-M01. packages/server/src/cross-site-fetch.ts:36 — `Sec-Fetch-Site: none` が通過

```ts
return site === 'cross-site';  // 'none' は false 返却 = 通過
```

`Sec-Fetch-Site: none` はブラウザのトップレベルナビゲーション (アドレスバー直打ち、フォーム送信) で送られる。state-mutating POST (subscribe / cancel / member) に CSRF ガード抜け。

**修正案:**
```ts
const ALLOWED = new Set(['same-origin', 'same-site']);
return !ALLOWED.has(site);
```
テスト `cross-site-fetch.test.ts` に `none` ケース追加。

**Severity 再評価: Critical 相当** (Origin 検証が残る billing/cancel は多層防御あり、single-layer 依存箇所を全洗い出し必要)。

---

### [Medium] IT3-SHARED-M02. crypto.ts:22-26 — `parts[0..2]` 型安全性欠如

```ts
const parts = encrypted.split(':');
if (parts.length !== 3) throw ...;
const iv = Buffer.from(parts[0], 'hex');  // string | undefined (noUncheckedIndexedAccess 有効時)
```

現行 AES-256-GCM の ciphertext は hex のみで `:` 含まず問題ないが、destructure + 個別 null check で型強化推奨。

---

### [Medium] IT3-SHARED-M03. maskSensitiveLogFields — フィールド集合が不一致

- billing-service: `/^(cookie|authorization|set-cookie|token|card|email)$/i` (email 含む)
- sync-service: `/^(cookie|authorization|set-cookie|token|card)$/i` (email **非含む**)

sync-service のログに email 平文出力リスク。GDPR / 個人情報観点で問題。`@hayane/shared` に billing 版で統一移動 + 全サービス re-export。

---

### [Low] IT3-SHARED-L01-L05

- L01 `isSameOrigin(allowedOrigin)` 空/不正入力で catch → false、設定ミスの silent 403
- L02 `allowedOrigin` trailing slash バリデーションは `validateFrontendBaseUrl` 側のみ、`isSameOrigin` JSDoc 明記推奨
- L03 `linkSessionTokenHash` が auth-service と billing-service で重複 (shared に統合)
- L04 `isForbiddenCrossSiteFetch` が server 内実装で shared 未移動、admin-server の将来公開時に再実装懸念
- L05 `packages/shared/src/__tests__/` 不在。`cookie.ts` / `crypto.ts` / `origin.ts` 直接テストゼロ

**shared 評価: 6/10**。強み: `CookieAttributes` リテラル型で `__Host-` 固定属性を型レベル強制、AES-256-GCM + authTag 検証、pool error handler 実装済。弱み: M01 が最重大、shared 本体テスト皆無。

---

## Iter3 Agent D — a11y + i18n

### [High] IT3-A11Y-A01. cancel-ui.ts:56-65 — モーダルフォーカストラップ未実装

Tab キーで背景ノードに抜ける。WCAG 2.1 2.1.2 No Keyboard Trap / 2.4.3。
**修正案:** Tab/Shift+Tab keydown で `confirmBtn` / `dismissBtn` 間ループ。

---

### [High] IT3-A11Y-A02. cancel-ui.ts:47-53 — モーダルクローズ後フォーカス復帰なし

`document.body` に落下、トリガー要素 (退会ボタン) に戻らない。WCAG 2.1 2.4.3。
**修正案:** トリガー要素参照を `dismiss` で `.focus()`。

---

### [High] IT3-A11Y-A03. billing-ui.ts:343-358 — PAY.JP iframe 入力欄ラベル未紐付け

カード番号・有効期限・CVC のマウント `<div>` に `id` のみ、`<label>` の `for` 未設定。`aria-label` / `aria-labelledby` 代替なし。WCAG 1.3.1 / 1.3.5。

---

### [High] IT3-A11Y-A04. payment-page.css:439-443 — `form-input:focus` で `outline: none` 代替不十分

ハイコントラスト (Windows forced-colors) で `box-shadow` 消滅、フォーカス完全不可視。WCAG 2.4.7 / 2.4.11。
**修正案:** `:focus-visible` + `@media (forced-colors: active)` で `outline` 復活。

---

### [High] IT3-A11Y-A05. billing-ui.ts:283-302 — 送信ボタン disabled 時の理由が SR 未通知

`disabled='true'` 文字列設定 + 不足原因 (同意 / カード / email) が `aria-describedby` 経由で伝わらない。WCAG 3.3.1 / 4.1.2。

---

### [Medium] IT3-A11Y-A06-A10

- A06 プラン選択時の金額変更が `aria-live` 非通知 (WCAG 4.1.3)
- A07 `.copy-button` の `:focus-visible` 未定義
- A08 エラーバナー表示後フォーカス移動なし (WCAG 3.3.1 / 4.1.3)
- A09 `.warning-banner` コントラスト比 約 3.6:1 (AA 4.5:1 未達、WCAG 1.4.3)
- A10 PAY.JP カードエラー要素 `role="alert"` の更新時 re-announce 不発火

---

### [Low] IT3-A11Y-A11-A14

- A11 3DS 処理中スピナー `aria-label` が "処理中" のみ、iframe 出現予告なし
- A12 日付フォーマット `YYYY/MM/DD` のみ、契約文書は `YYYY年MM月DD日` 推奨
- A13 `discord-linked-badge` の ✓ に `aria-hidden` なし (SR が「チェック」読み上げ)
- A14 `.secondary-button` の `:focus-visible` 未定義

**a11y 評価: 5.5/10**。基本 ARIA / landmark / `lang="ja"` / prefers-reduced-motion OK。弱点: モーダルフォーカス管理 / iframe ラベル / `outline:none` の 3 点で決済完了不能リスク。
**i18n 評価: 7.5/10**。UI 全日本語・JST・¥ 記号 OK。減点: 日付形式・記号読み上げ制御。

---

# 累計 Summary (Iter 1+2+3)

| Severity | Iter1 | Iter2 | Iter3 | **累計** |
|----------|-------|-------|-------|----------|
| Critical | 1     | 0     | 0 (M01 実質Critical格上候補) | **1+α** |
| High     | 16    | 11    | 9     | **36** |
| Medium   | 20    | 18    | 19    | **57** |
| Low      | 11    | 13    | 17    | **41** |
| Info     | 0     | 1     | 0     | **1** |
| **計**   | **48**| **43**| **45**| **136** |

## Tier 1 Go-Live ブロッカー 累計 (15 件)

**業務ロジック**: NR-C1 (subscribe inflight 非原子性) / A01 (webhook livemode) / A03=V4-H5 (unknown_status impact_log) / NR-H1 (subscribeRecovery pagination) / NR-H2 (buildSubscriptionResponse throw) / NR-H3 (status mapSubscriptionStatus)

**セキュリティ**: IT3-SHARED-M01 (Sec-Fetch-Site: none CSRF bypass) / IT2-ADM-F01 (admin CF fallback) / IT2-ADM-F09 (nginx JWT assertion strip)

**インフラ**: IT2-DOCKER-F01-F03 (multi-stage / useradd / image pin) / IT3-DB-H3 (advisory lock connection leak) / IT3-DB-H4 (first_trial UNIQUE)

**テスト/CI**: T2 (subscribe regression) / IT2-E2E-T4 (T-P0-05) / IT2-CI-H1 (Actions SHA pin)

---

# 次イテレーション候補 (Iteration 4 以降)

1. `docs/ops/` ops 文書の最新性・相互整合性レビュー
2. scripts/ (shell) セキュリティ + error handling (MEMORY note `reference_bash_state_file_patterns.md` 準拠)
3. 実 DB クエリ EXPLAIN ベースのインデックス必要性検証
4. PAY.JP webhook event タイプ全カバレッジ監査 (payment.failed / charge.refunded / customer.updated 等 15+)
5. 既存統合テストのアサーション強度精査 (toBeTruthy only の洗い出し)
6. Docker image CVE scan (trivy) + nginx/postgres の既知 CVE チェック
7. B2 offsite backup 実 restore drill の実効性確認

---

# Iteration 4 (2026-04-17) — scripts / webhook events / test strength / ops docs

4 並列 agent: security-auditor(scripts) / payment-integration(webhook) / qa-expert(tests) / api-documenter(ops)

## Summary (Iteration 4)

| Severity | Count |
|----------|-------|
| High     | 14    |
| Medium   | 17    |
| Low      | 10    |

**Iter 4 total: 41 件 / 累計 Iter1-4: 177 件 (Critical 1 / High 50 / Medium 74 / Low 51 / Info 1)**

## Iter4 Tier 1 — Go-Live 前修正必須 (新規 5 件、累計 20 件)

- **IT4-SCRIPTS-H1** `scripts/prod/deploy.sh:368,374` — `exec > >(tee ...)` 後に `eval "$(op signin)"` で **1Password session token がデプロイログに平文記録**。op signin を tee 開始前に移動必須
- **IT4-WEBHOOK-H1** `cli-deps-factory.ts:97-103` — Discord `syncRole` にリトライ無し (仕様 `implementation-design-mvp.md §5.5 item12` 「0秒/1秒/2秒, 最大3回」違反)。429/5xx で即 unknown ロール剥奪 = 仕様逸脱
- **IT4-TESTS-H3** webhook-flow.test.ts:549,655,672 — `syncRole` の **方向 grant/revoke / discord_user_id / role_id が未検証**。誤方向でも通過 (決済ロール付与ミスが production 漏洩)
- **IT4-OPS-H2** `docs/ops/backup-restore.md` — `compose.yaml` 参照のコマンドが即座失敗 (ファイル名は `docker-compose.yml`)
- **IT4-OPS-H3** `docs/ops/production-readiness-checklist.md` — `DAILY_RESYNC_CRON` 確認コマンドが的外れ (実存 systemd timer と合致しない)

## Iter4 Tier 2 主要 (9 件)

- IT4-SCRIPTS-H2 build.sh の op signin もスクロールバック / `script(1)` ログで token 露出リスク
- IT4-WEBHOOK-H2 subscription.paused で access_end_at 未更新 (paused→resumed→canceled で stale)
- IT4-TESTS-H1/H2/H4/H5 `createPayjpCharge` 引数未検証 / 401 ログ内容未検証 / trial ガード詳細未検証 / CLI result 型のみ
- IT4-OPS-H1/H4/H5 `$POSTGRES_USER` 展開バグ / HTTP_5XX_SPIKE アラートコード誤記 / JST/UTC 混同

---

## Iter4 Agent A — Shell Scripts Security

### [High] IT4-SCRIPTS-H1. scripts/prod/deploy.sh:368,374 — op signin token がデプロイログに漏洩

```bash
exec > >(tee -a "$DEPLOY_LOG") 2>&1   # 全 stdout → log
if ! eval "$(op signin)"; then          # "export OP_SESSION_xxxx=TOKEN" が log 記録
```

`op signin` は `export OP_SESSION_<account>=<token>` を stdout 出力。`tee` でログに平文記録。同一ユーザー / バックアップ取得者がセッショントークン取得可能、有効期間内 1Password vault アクセス可能。

**修正案:** op signin 完了後に `exec > >(tee ...)` を実行。

---

### [High] IT4-SCRIPTS-H2. scripts/local/build.sh:34 — build.sh op signin もスクロールバック露出リスク

stdout リダイレクト無しで deploy.sh より低リスクだが、ターミナルスクロールバック + `script(1)` ログで token 記録。失敗時 `exit 1` 明示化推奨。

---

### [Medium] IT4-SCRIPTS-M1-M5

- M1 `check-host.sh:44-48` tickstreak ファイル整数検証なし (破損で `(( "abc" + 1 ))` abort)
- M2 `restore-drill.sh:80-86` B2 ファイル名パストラバーサル (通常は自社制御バケット)
- M3 `backup-db.sh:36-46` pipeline 部分失敗で空 `.sql.gz` 残存、check_backup_stale 誤判定
- M4 `dedup.sh:97` `global_rate_mark` non-atomic (truncate→write の窓で partial read → `last=0`、Discord スパム)
- M5 `check-host.sh:132 / daily-digest.sh:106` unquoted word splitting (`$CERT_PATHS` / `$DOMAINS_TO_MONITOR`)

### [Low] IT4-SCRIPTS-L1-L4

- L1 dedup.sh streak 書込 non-atomic
- L2 restore-drill.sh `(( i == 30 ))` の `&&` 短絡依存
- L3 docker-compose-op.sh が `.env` を `grep -q` (ポリシー違反、内容非露出)
- L4 notify.sh curl レスポンスボディ破棄、429 / 400 デバッグ困難

**Scripts 評価強み:** 全 ops script で `set -euo pipefail` + `op run --env-file=.env`、`age + 2-phase staging`、`mktemp + trap`。
**最優先:** H-1 (log 漏洩) → M-1 (tickstreak) → M-3 (stale backup)。

---

## Iter4 Agent B — PAY.JP Webhook Event Coverage

### [High] IT4-WEBHOOK-H1. cli-deps-factory.ts:97-103 — Discord syncRole リトライ未実装

```ts
async function syncRole(userId, action, roleId) {
  if (action === 'grant') await discordRest.put(endpoint);
  else await discordRest.delete(endpoint);
}
```

**仕様違反:** `implementation-design-mvp.md §5.5 item12` 「0秒/1秒/2秒待機、最大3回、各回タイムアウト1秒、総6秒以内」。Discord 429 で即 unknown 状態、subscription.canceled 時のロール剥奪漏れ。

**修正案:** `for (const delay of [0, 1000, 2000])` + `AbortSignal.timeout(1000)` ラッパー。

---

### [High] IT4-WEBHOOK-H2. webhook.ts:301 — subscription.paused 時 access_end_at 未更新

```ts
if (newStatus === 'active' || newStatus === 'trial' || newStatus === 'canceled') {
  updates.access_end_at = periodEnd;
}
```

`paused` 除外。PAY.JP は paused でも `current_period_end` 返却。paused → resumed → canceled で stale access_end_at、日次補正までロール判定誤り可能性。
**修正案:** `paused` 条件追加 or 仕様明示。

---

### [Medium] IT4-WEBHOOK-M1-M4

- M1 Dunning: `charge.failed` は `disallowed_event_type` で ignored、`subscription.updated` 到達まで数時間遅延 (仕様許容、audit log 確認済)
- M2 `subscription.deleted` 後 `payjp_subscription_id` NULL リセットなし (再サブスクリプション時の逆引き競合)
- M3 `unknown_status` 時 `attemptRoleSyncAllRoles` で partial revoke リスク (現状 1 ロールのみで問題なし)
- M4 token 検証失敗イベントは `payjp_events` に未記録、監視 401 件数アラート化推奨

### [Low] IT4-WEBHOOK-L1-L3

- L1 `event.data` falsy 時 `invalid_data_object` スキップ → `failed` 扱い
- L2 `KNOWN_STATUSES` に PAY.JP 未来追加 (`incomplete` / `past_due`) の意図的除外コメント欠如
- L3 token mismatch ログの `event.type` が `'unknown'` 固定になり得る (観測容易性)

**イベントカバレッジ:** subscription.* 7 種全 handled。charge / customer / transfer / dispute は `disallowed_event_type` で ignored (audit log 記録)。`payjp_events.process_status` = `succeeded` / `failed` / `ignored` の 3 値。PAY.JP 5 ステータスは `mapSubscriptionStatus` 網羅。

---

## Iter4 Agent C — Test Assertion Strength

### [High] IT4-TESTS-H1. resync-flow.test.ts:121 — createPayjpCharge 引数未検証

```ts
expect(deps.createPayjpCharge).toHaveBeenCalled();
```

引数不問で通過。`metadata.operation_id` が含まれていなくても合格。冪等性キードリフト検知不能。

**強化:** `toHaveBeenCalledWith(expect.objectContaining({ customer, currency: 'jpy', metadata: expect.objectContaining({ operation_id }) }))` + `toHaveBeenCalledTimes(1)`

---

### [High] IT4-TESTS-H2. webhook-flow.test.ts:262 — 401 ログ呼び出し回数 / reason 値未検証

```ts
expect(logFn).toHaveBeenCalled();
const logEntry = logFn.mock.calls[0][0];
expect(logEntry).toHaveProperty('received_at');
```

2 重ログ実装変更でも通過、`reason: 'token_mismatch'` 値未検証。

---

### [High] IT4-TESTS-H3. webhook-flow.test.ts:549,655,672 — syncRole 方向 / user / role_id 未検証

```ts
expect(syncRole).toHaveBeenCalled();
```

`syncRole('wrong_user', 'revoke', 'wrong_role')` でも通過。**決済ロール付与ミスが production 漏洩する直接リスク**。

---

### [High] IT4-TESTS-H4. subscribe-flow.test.ts:407-420 — trial 既存ガードの結果詳細未検証

`result.ok === true` のみ。`subscriptionStatus` が誤って `'active'` でも通過。active ケース (L398-404) と非対称。`clearInflightOperation` not.toHaveBeenCalled 追加推奨。

---

### [High] IT4-TESTS-H5. failure-recovery.test.ts:514-520 — CLI result 型のみチェック

```ts
expect(result.target).toBeDefined();
expect(result.started_at).toBeDefined();
```

`null` / `0` (Unix epoch) でも通過。`finished_at >= started_at` 等の論理関係未検証。

---

### [Medium] IT4-TESTS-M1-M5

- M1 daily-resync.test.ts:57 timestamp 型未チェック
- M2 cross-cutting.test.ts:146-166 **ヘルスチェックがインライン関数をテスト、実装未呼出** = 完全なトートロジー
- M3 billing-routes.test.ts:351-353 `__Host-` Cookie 属性 (Secure/HttpOnly/SameSite=Lax/Path=/) 未検証 (CLAUDE.md 固定ルール)
- M4 security.test.ts:614 regex match `toBeTruthy()` でトークン長未検証
- M5 resync-flow.test.ts:673 log 引数未検証 (INT-SYNC-034 は検証済、非対称)

### [Low] IT4-TESTS-L1-L2

- L1 pg-db-client.test.ts:48 UUID フォーマット未チェック
- L2 billing-routes.test.ts:1107,1184 Google Form token 長未検証

**推定スイート強度:** 強い 78% / 要強化 12% / 実質無効 3% / 低優先 残り。最優先: H3 (syncRole 引数) / M2 (ヘルス trotology) / H1 (createCharge metadata)。

---

## Iter4 Agent D — ops docs consistency

### [High] IT4-OPS-H1. backup-restore.md $POSTGRES_USER 展開バグ

復元シナリオ A の psql コマンドで `${POSTGRES_USER}` が op run 外で展開されず失敗可能性。コマンド構造要修正。

---

### [High] IT4-OPS-H2. docs/ops/backup-restore.md — compose.yaml 参照 (ファイル名 docker-compose.yml)

復元コマンドが即座に「No such file」で失敗。1 行修正。

---

### [High] IT4-OPS-H3. production-readiness-checklist.md DAILY_RESYNC_CRON 確認

実存 systemd timer と合致しない確認手順。Go-Live チェックが的外れ。

---

### [High] IT4-OPS-H4. alerts.md HTTP_5XX_SPIKE アラートコード誤記

インシデント対応手順中のアラートコード不一致、対応フロー開始失敗。1 語修正。

---

### [High] IT4-OPS-H5. JST/UTC 混同 (複数 doc)

運用設定ミスの温床。コード側 or 文書側の修正要議論。

---

### [Medium] IT4-OPS-M1-M4

- M1 Day10 スモーク T-P0-03 / T-P0-04 項目欠落 (Go-Live 証跡穴)
- M2-M4 相互参照崩れ / 記述不完全 (詳細割愛)

### [Low] IT4-OPS-L1. admin-console.md:44 admin-frontend/dist ビルド後 nginx 再起動手順記載なし

**Ops docs 評価:** 構造は整理済、`op run` 一貫性あり。致命的設計ミスなし。H 件は「コピー漏れ」「ファイル名ミス」「アラートコード不一致」に集中。**Go-Live ブロッカー: H-2 / H-3 / H-4 の 3 件**。

---

# 累計 Summary (Iter 1+2+3+4)

| Severity | Iter1 | Iter2 | Iter3 | Iter4 | **累計** |
|----------|-------|-------|-------|-------|----------|
| Critical | 1     | 0     | 0     | 0     | **1+α** |
| High     | 16    | 11    | 9     | 14    | **50** |
| Medium   | 20    | 18    | 19    | 17    | **74** |
| Low      | 11    | 13    | 17    | 10    | **51** |
| Info     | 0     | 1     | 0     | 0     | **1** |
| **計**   | **48**| **43**| **45**| **41**| **177** |

## Tier 1 Go-Live ブロッカー 累計 (20 件)

**業務ロジック (7)**: NR-C1 / A01 / A03=V4-H5 / NR-H1 / NR-H2 / NR-H3 / IT4-WEBHOOK-H1 (Discord retry)

**セキュリティ (5)**: IT3-SHARED-M01 (Sec-Fetch-Site none) / IT2-ADM-F01 / IT2-ADM-F09 / IT4-SCRIPTS-H1 (deploy op signin log) / IT4-TESTS-H3 (syncRole 未検証 → 決済影響)

**インフラ (3)**: IT2-DOCKER-F01-F03 / IT3-DB-H3 / IT3-DB-H4

**テスト・CI (2)**: T2 / IT2-E2E-T4 / IT2-CI-H1

**Ops 文書 (3)**: IT4-OPS-H2 / IT4-OPS-H3 / IT4-OPS-H4

---

# Iteration 5 (2026-04-17) — auth-service / Apps Script / errorCode / image CVE

4 並列 agent: security-auditor(auth) / security-auditor(GAS) / qa-expert(errorCode) / security-engineer(CVE)

## Summary (Iter 5)

High 5 / Medium 13 / Low 13 / Info 1 = **32 件**

## Iter5 Tier 1 — Go-Live 前修正必須 (新規 5 件、累計 25 件)

- **IT5-ERR-F01** `cancel.ts:138` 出力 `'NO_ACCESS_END'` ↔ フロント `map-cancel-error.ts:32` 期待 `'ACCESS_END_AT_NULL'` = 名前不一致。default fallthrough → `kind: 'server_error'` 誤表示、「退会対象購読が見つからない」UI 非表示
- **IT5-ERR-F02** `cancel.ts:326,354` 出力 `'DISCORD_ROLE_REVOKE_FAILED'` ↔ フロント `'ROLE_REVOKE_FAILED'` 期待 = 不一致。operationId は default で拾えるが「サポート誘導」専用メッセージが出ない。テスト `map-cancel-error.test.ts:57` もモック側不一致で検出漏れ
- **IT5-ERR-F03** `subscribe.ts:203-208` `DB_UPDATE_FAILED` 503 の return object に `operationId` 欠落 (行 193 で生成済) = **security.md 仕様「503 MUST include operationId」違反**、CLI recovery 不可
- **IT5-GAS-F01** `docs/ops/apps-script-cancel.md:40` GAS sample が `X-Cancel-Secret` を平文ヘッダ。GAS `Logger.log` / UrlFetchApp debug output に secret 残存可能性
- **IT5-GAS-F02** `billing.routes.ts:329-332` `X-Google-Cancel-Secret` フォールバック廃止期限未定義 (CR-011 移行期間が無期限化、攻撃面 2 倍)

## Iter5 Tier 2 主要 (10 件)

- IT5-AUTH-A4-01 Discord `error=access_denied` クエリ未処理 (401 でフロント「セッション切れ」誤認)
- IT5-AUTH-A4-02 `FRONTEND_BASE_URL_PATTERN = /^https?:/` で `http://` 許容 (Secure Cookie 矛盾)
- IT5-AUTH-A4-03 `/session` に `allowConsumed: true` (意図コメント欠如)
- IT5-AUTH-A4-04 `exchangeDiscordCode` が 429/5xx と 400/401 を無分類 throw (state 消費済 → 再認証不可)
- IT5-GAS-F03 シークレットローテーション手順 doc 欠如
- IT5-GAS-F04 HMAC secret と bearer secret 同一 (defense-in-depth 実質 1 層)
- IT5-GAS-F06 google-submit レートリミット IP 単位のみ (GAS 固定 IP で実質無効)
- IT5-ERR-F04/F05 PAYJP_UNCERTAIN フロント未マップ、自動再試行禁止文脈が伝わらない
- IT5-ERR-F06 PLAN_ROLE_UNMAPPED → 422 default で `kind: 'card_invalid'` 誤表示
- IT5-ERR-F08 TOKEN_ALREADY_USED に operationId 付与 → three_ds_failed 誤サポート誘導

## Iter5 Agent A — auth-service

0 High / 3 Medium / 4 Low = 7 件。コア (CSRF/Cookie/token/AES-256-GCM) 堅牢。詳細上記 Tier 2。

## Iter5 Agent B — Apps Script cancel flow

2 High / 4 Medium / 2 Low / 1 Info = 9 件。Info: `.gs` ファイルがリポ外で差分追跡不能、`clasp` 同期推奨。

## Iter5 Agent C — errorCode 整合性

3 High / 5 Medium / 3 Low = 11 件。

**errorCode インベントリ 40+ コード中:**
- 正常マップ 28
- 名前ミスマッチ 2 (F-01/F-02)
- フロント未マップ UX 劣化 5 (F-04-F-08)
- デッドコード 3 (DISCORD_NOT_MEMBER / DISCORD_ROLE_CAPABILITY / DISCORD_ROLE_SYNC_FAILED フロント case あるがバックエンド発行ゼロ)

## Iter5 Agent D — Docker image CVE (trivy)

**node:22-bookworm-slim:** Critical 1 (CVE-2023-45853 zlib MiniZip, Node.js 未使用) / High 8 (主に glibc / systemd / ncurses, Debian 12 修正版なし)
**postgres:17-alpine:** Critical 1 (CVE-2025-68121 gosu 1.19 の Go stdlib TLS, gosu は TLS 未使用) / High 7
**nginx:alpine:** クリーン

`read_only: true` + `cap_drop: ALL` + `no-new-privileges:true` で大幅軽減。digest pin + `.github/workflows/trivy-scan.yml` (weekly cron + `ignore-unfixed: true`) 推奨。

**コンテナ posture: B+**

---

# 累計 Summary (Iter 1-5)

| Severity | Iter1 | Iter2 | Iter3 | Iter4 | Iter5 | **累計** |
|----------|-------|-------|-------|-------|-------|----------|
| Critical | 1     | 0     | 0     | 0     | 0     | **1+α** |
| High     | 16    | 11    | 9     | 14    | 5     | **55** |
| Medium   | 20    | 18    | 19    | 17    | 13    | **87** |
| Low      | 11    | 13    | 17    | 10    | 13    | **64** |
| Info     | 0     | 1     | 0     | 0     | 1     | **2** |
| **計**   | **48**| **43**| **45**| **41**| **32**| **209** |

## Tier 1 ブロッカー 累計 25 件

- 業務ロジック 7: NR-C1 / A01 / A03 / NR-H1 / NR-H2 / NR-H3 / IT4-WEBHOOK-H1
- セキュリティ 7: IT3-SHARED-M01 / IT2-ADM-F01 / IT2-ADM-F09 / IT4-SCRIPTS-H1 / IT4-TESTS-H3 / IT5-GAS-F01 / IT5-GAS-F02
- errorCode 3: IT5-ERR-F01 / IT5-ERR-F02 / IT5-ERR-F03
- インフラ 3: IT2-DOCKER-F01-F03 / IT3-DB-H3 / IT3-DB-H4
- テスト CI Ops 5: T2 / IT2-E2E-T4 / IT2-CI-H1 / IT4-OPS-H2 / IT4-OPS-H3 / IT4-OPS-H4

# 次イテレーション候補 (Iter 6+)

1. 実 DB EXPLAIN + 本番想定データ量 index 効果測定
2. frontend bundle size / sourcemap 漏洩 / tree-shaking
3. Node dep transitive CVE audit (`npm audit` 詳細化)
4. Playwright config timeouts / parallel safety
5. 既 Tier 1 25 件の PR 化 roadmap / 修正順序 (依存関係考慮)

---

# Iteration 6 (2026-04-17) — server routes / npm audit / webhook deep / Tier1 regression check

4 並列 agent: security-auditor(routes) / security-engineer(npm) / payment-integration(webhook) / Explore(regression)

## 重要: Tier 1 regression check 結果 (Agent D)

**25 件中 5 件が commit `378fbd6 fix(payment): NR-C1 atomic inflight clear + high-severity audit fixes` で既修正。**

| # | ID | 状態 | 備考 |
|---|-----|------|------|
| 1 | NR-C1 | **fixed** | `updateMemberAfterSubscribe` 1 クエリ統合済 |
| 3 | A03 | **fixed** | `attemptRoleSyncAllRoles` 経由で insertImpactLog 実行 |
| 19 | IT3-DB-H3 | **fixed** | acquireAdvisoryLock 例外時 `client.release()` + finally 実装 |
| 23 | IT4-OPS-H2 | **fixed** | `compose.yaml` 正しく記載 |
| 5 | NR-H2 | **partially-fixed** | throw 未保護は残るが `slog('warn')` で非致死化 |
| 10 | IT2-ADM-F09 | **partially-fixed** | `cf-access-authenticated-user-email` は strip、JWT assertion は未 strip |
| 18 | IT2-DOCKER-F01-F03 | **partially-fixed** | useradd 済、マルチステージ + digest pin 未 |

**still-present = 16 件、partially = 3、cannot-verify = 1 (IT4-SCRIPTS-H1 deploy.sh 順序議論余地)**

→ **Tier 1 実働残数: 20 件 (16 still + 3 partial + 1 要判断)**

## Summary (Iter 6 新規 findings)

High 3 / Medium 3 / Low 7 / Info 9 = **22 件**

- Agent A routes: 0 High / 2 Medium / 5 Low / 1 Info
- Agent B npm audit: 0 CVE vulnerabilities (A- posture) / 2 Low / 8 Info
- Agent C webhook deep: 3 High (new) / 1 Medium + 1 High 再確認 (WEBHOOK-H1)
- Agent D regression: verification only

## Iter 6 新規 Tier 1 候補 (High 3)

- **IT6-WHK-07** `webhook.ts:129-136` — 冪等チェック `findPayjpEvent` が TX 外実施 → 並列リクエストで二重 UPDATE members ウィンドウ。TX 内 lock 取得直後に再チェック必須
- **IT6-WHK-08** `webhook.ts:163` — `resolveMember` が 3 クエリ非アトミック SELECT → TOCTOU で `MemberResolutionConflictError` 誤発火、正規 webhook が `failed`、PAY.JP 再送 3-9 分ロール不整合。単一 `WHERE discord_user_id=$1 OR payjp_subscription_id=$2 OR id=$3` に統合推奨
- **IT6-WHK-06** `webhook.ts:372-376` — plan-swap 判定で `txResult.lockedMember.subscription_status` (TX 前 snapshot) を使用。現状 `!statusChanged` で実害なしだが将来リグレッション源

## Iter 6 Medium/Low 主要

- IT6-WHK-09 webhook.ts:301 canceled + current_period_end 欠落時 access_end_at 旧値残留
- IT6-RTE-01 auth.routes.ts /start /callback に isForbiddenCrossSiteFetch ガード無 (Sec-Fetch-Site 差分で情報漏洩)
- IT6-RTE-02 auth/member のエラー shape 不整合 (`{error}` vs `{ok:false,errorCode}`)
- IT6-RTE-03 sync.routes.ts webhook の rawBody 保証要確認
- IT6-RTE-06 member.routes.ts:347 updateMemberRoleState 失敗無音飲み込み
- IT6-DEP-01 @types/cron 2.0.1 pin drift (Dependabot PR マージ済だが package.json `^2.0.1` のまま)
- IT6-DEP-02/03 vitest v3/v4 / vite v6/v7/v8 混在 (CVE なし、統一推奨)

## npm audit 結果 (Agent B)

```
npm audit: 0 vulnerabilities (Critical/High/Moderate/Low すべて 0)
```

依存数 321 (prod 101/dev 193/optional 129)、GPL/AGPL 0 件、CI `npm audit --audit-level=high` 適用済。Dependabot 稼働中。Posture **A-**。

## Webhook posture (Agent C 再評価)

**6.5/10** (既修正考慮) / **5.5/10** (Iter1-5 既知未修正前提)。
強み: 署名検証 / 定数時間比較 / TX 設計 / advisory lock / idempotency テーブル。
弱み: syncRole リトライ未実装 (spec §5.5 item12 SLA 欠落) / TOCTOU 誤 conflict / TX 外冪等チェック。

---

# 累計 Summary (Iter 1-6)

| Severity | Iter1 | Iter2 | Iter3 | Iter4 | Iter5 | Iter6 | **累計** |
|----------|-------|-------|-------|-------|-------|-------|----------|
| Critical | 1     | 0     | 0     | 0     | 0     | 0     | **1+α** |
| High     | 16    | 11    | 9     | 14    | 5     | 3     | **58** |
| Medium   | 20    | 18    | 19    | 17    | 13    | 3     | **90** |
| Low      | 11    | 13    | 17    | 10    | 13    | 7     | **71** |
| Info     | 0     | 1     | 0     | 0     | 1     | 9     | **11** |
| **計**   | **48**| **43**| **45**| **41**| **32**| **22**| **231** |

## Tier 1 ブロッカー 実働残数 (Iter 6 回帰後 = 23 件)

**実働残 (fixed/partial 除外 + Iter6 新規 3):**
- 業務ロジック 3 残: A01 / NR-H1 / NR-H3 (WEBHOOK-H1 含む = 4) + IT6-WHK-06/07/08 = 計 7
- セキュリティ 5: IT3-SHARED-M01 / IT2-ADM-F01 / IT4-TESTS-H3 / IT5-GAS-F01 / IT5-GAS-F02
- errorCode 3: IT5-ERR-F01 / IT5-ERR-F02 / IT5-ERR-F03
- インフラ 2: IT3-DB-H4 / IT2-DOCKER-F01-F03 部分
- テスト CI Ops 4: IT2-E2E-T4 / IT2-CI-H1 / IT4-OPS-H3 / IT4-OPS-H4

Go-Live (2026-04-20) 直前の状態: **直近の PR で Tier 1 5 件解消、残 20 (要判定) ～ 23 件**。

# 次イテレーション候補 (Iter 7+)

1. **Tier 1 修正 PR の PAY.JP webhook 再適用検証** — webhook は変更多く regression risk 高
2. frontend bundle / sourcemap / tree-shaking 実測
3. Playwright config timeouts / parallel safety
4. 既 Tier 1 20 件の PR 化 roadmap 起草 (依存順)
5. @types/cron pin drift 解消 (IT6-DEP-01, 1 行修正)
6. vitest / vite バージョン統一 calendar

---

# Iteration 7 (2026-04-17) — billing.routes / Playwright infra / frontend bundle

3 並列 agent: payment-integration(billing.routes) / pr-test-analyzer(e2e) / typescript-pro(frontend bundle)

## Summary (Iter 7)

Critical 1 / High 6 / Medium 12 / Low 7 = **26 件**

## Iter7 Tier 1 候補 (新規 4 件)

- **IT7-E2E-06** `.github/workflows/ci.yml` — **E2E が CI に未組込**。`playwright install` も `npm run e2e` も実行されず、Go-Live 判定 T-P0-01〜T-P0-07 が CI 自動検証されていない
- **IT7-E2E-02** `e2e-serve.ts` — テスト前後 DB TRUNCATE / teardown 不在、ローカル `reuseExistingServer` で前回行残存 → 副作用フレーク
- **IT7-FE-02** `frontend/index.html:41` — `<script src="https://js.pay.jp/v2/pay.js">` に SRI `integrity` 属性なし。CDN 改ざん / supply chain で 3DS フロー乗っ取りリスク (PCI DSS SAQ A iframe 整合性保証要件)
- **IT7-ROUTE-01** `billing.routes.ts:83-155` POST /v1/subscriptions に bodyLimit 未設定 (Fastify default 1MB)。攻撃者が 1MB 近い JSON 送付でメモリ・CPU 消費

## Iter7 Tier 2 主要

- IT7-E2E-01 `fullyParallel: true` + CI `workers: 1` + ローカル `workers: undefined` の意図不明確
- IT7-E2E-03 `e2eDiscordUserIdSeq` `+= 1n` 非アトミック → 並列実行で UNIQUE 違反リスク
- IT7-E2E-04 ローカル `retries: 0` + `reuseExistingServer: true` で DB 汚染起因フレーク隠蔽
- IT7-FE-01 `vite.config.ts` build.sourcemap 未指定 (Vite default false だが将来回帰リスク、明示推奨)
- IT7-ROUTE-02/03/04 GET /status / cancel / google-form-link に schema なし、追加プロパティ受理
- IT7-ROUTE-05 subscribe 503 catch ブロックで operationId ログ欠落 (ops 相関不可)
- IT7-FE-04 `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` 未設定
- IT7-FE-05 `module: "NodeNext"` がフロント不適切 (`ESNext` + `Bundler` 推奨)

## Iter7 Agent A — billing.routes.ts

7 件 (1 High / 4 Medium / 2 Low)。**posture B-** (機能安全だが schema 適用一貫性 + ops 可視性に空白)。

## Iter7 Agent B — Playwright e2e infra

10 件 (1 Critical / 3 High / 4 Medium / 2 Low)。**posture 5/10**。
強み: PAY.JP SDK モック / Discord OAuth ブラウザフロー代替 / `--unsafely-treat-insecure-origin-as-secure` での `__Host-` Cookie 対応。
弱み: DB 分離 / CI 統合 / 並列安全性 3 点で基盤未完成。

## Iter7 Agent C — frontend bundle / vite.config

9 件 (2 High / 4 Medium / 3 Low)。**posture C+**。
強み: 外部依存ゼロ (PAY.JP.js CDN のみ)、CSP 存在、TS strict。
弱み: SRI 未設定 / sourcemap 未明示 / NodeNext 流用。

---

# 累計 Summary (Iter 1-7)

| Severity | Iter1 | Iter2 | Iter3 | Iter4 | Iter5 | Iter6 | Iter7 | **累計** |
|----------|-------|-------|-------|-------|-------|-------|-------|----------|
| Critical | 1     | 0     | 0     | 0     | 0     | 0     | 1     | **2** |
| High     | 16    | 11    | 9     | 14    | 5     | 3     | 6     | **64** |
| Medium   | 20    | 18    | 19    | 17    | 13    | 3     | 12    | **102** |
| Low      | 11    | 13    | 17    | 10    | 13    | 7     | 7     | **78** |
| Info     | 0     | 1     | 0     | 0     | 1     | 9     | 0     | **11** |
| **計**   | **48**| **43**| **45**| **41**| **32**| **22**| **26**| **257** |

## Tier 1 ブロッカー累計 ≈ 24 件 (Iter 6 regression check 後)

| 区分 | 件数 | ID |
|------|------|-----|
| 業務ロジック | 7 | A01 / NR-H1 / NR-H3 / IT4-WEBHOOK-H1 / IT6-WHK-06 / IT6-WHK-07 / IT6-WHK-08 |
| セキュリティ | 5 | IT3-SHARED-M01 / IT2-ADM-F01 / IT4-TESTS-H3 / IT5-GAS-F01 / IT5-GAS-F02 |
| errorCode | 3 | IT5-ERR-F01 / IT5-ERR-F02 / IT5-ERR-F03 |
| インフラ | 2 | IT3-DB-H4 / IT2-DOCKER-F01-F03 部分 |
| テスト/CI/Ops | 7 | IT2-E2E-T4 / IT2-CI-H1 / IT4-OPS-H3 / IT4-OPS-H4 / IT7-E2E-06 (E2E 未CI) / IT7-E2E-02 (DB teardown) / IT7-FE-02 (SRI) |

---

# 推奨修正 Roadmap (Tier 1 24 件、PR 化順序)

## Wave 1 — 単一ファイル小修正 (各 1-2 行) — Sprint 1

並列マージ可、依存なし、テスト追加軽微:

1. **IT5-ERR-F01** cancel.ts:138 `'NO_ACCESS_END'` → `'ACCESS_END_AT_NULL'` (1 行)
2. **IT5-ERR-F02** cancel.ts:326,354 `'DISCORD_ROLE_REVOKE_FAILED'` → `'ROLE_REVOKE_FAILED'` (2 行)
3. **IT5-ERR-F03** subscribe.ts:203-208 503 return に `operationId` 追加 (1 行)
4. **IT3-SHARED-M01** cross-site-fetch.ts:36 `!['same-origin','same-site'].includes(site)` (1 行)
5. **A01** sync core/index.ts:187 `event.livemode === undefined` も拒否 (3 行)
6. **NR-H3** cli.ts:409-412 `mapSubscriptionStatus` 経由化 (5 行)

## Wave 2 — 中規模 + テスト

7. **NR-H1** cli.ts:388-412 subscribeRecovery fail-close 追加 (≈10 行 + test)
8. **IT4-WEBHOOK-H1** cli-deps-factory.ts:97-103 `syncRole` リトライ実装 (≈15 行 + test)
9. **IT6-WHK-07** webhook.ts:129 TX 内 idempotency 再チェック (≈5 行 + test)
10. **IT6-WHK-08** webhook.ts:163 resolveMember 単一クエリ統合 (≈10 行 + test)
11. **IT4-TESTS-H3** webhook-flow.test.ts syncRole 引数検証 `toHaveBeenCalledWith` 追加 (test only, ≈30 行)

## Wave 3 — インフラ・設定

12. **IT3-DB-H4** schema.sql `CREATE UNIQUE INDEX ... WHERE first_trial_granted_at IS NOT NULL` migration 追加
13. **IT2-CI-H1** GitHub Actions SHA pin (gh CLI で SHA 取得 + 全 workflow 置換)
14. **IT2-DOCKER-F01-F03** マルチステージ Dockerfile + image digest pin (PR 大、リスク中)
15. **IT7-FE-02** index.html:41 PAY.JP.js SRI integrity (PAY.JP に hash 確認後)
16. **IT2-ADM-F01** admin-server 起動時ガード + nginx x-admin-api-key strip
17. **IT5-GAS-F02** X-Google-Cancel-Secret deadline config 追加

## Wave 4 — Ops 文書 / E2E

18. **IT4-OPS-H3** production-readiness-checklist.md DAILY_RESYNC_CRON 確認手順修正
19. **IT4-OPS-H4** alerts.md HTTP_5XX_SPIKE → NGINX_5XX_BURST に統一
20. **IT5-GAS-F01** apps-script-cancel.md secret 平文ヘッダ削除 + HMAC のみ認証
21. **IT2-E2E-T4** T-P0-05 退会完了 E2E 追加
22. **IT7-E2E-02** global-setup で DB TRUNCATE 実装
23. **IT7-E2E-06** ci.yml に Playwright E2E job 追加 (postgres service + playwright install)
24. **IT6-WHK-06** webhook.ts plan-swap で `txResult.newStatus` 渡す型追加

## 修正済み確認 (Wave 0、すでに `378fbd6` で完了)

- NR-C1 / A03 / IT3-DB-H3 / IT4-OPS-H2 / NR-H2 (partial)

---

# 次イテレーション候補 (Iter 8+)

1. Wave 1 修正 6 件の PR 起票 dry-run / diff 試作
2. Wave 2 webhook 修正の regression test 設計
3. spec text vs code の最終確認 (Go-Live 直前 sanity check)
4. 既マージ PR (#117/#121/#129/#130/#131/#133/#134/#117) の後続関連バグ精査
5. 監視アラート 50+ コードと実装の最終突合
