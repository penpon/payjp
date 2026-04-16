# 2026-04-16 Loop Review — Evidence Log

`review/comprehensive-2026-04-16` branch 継続の 30 分ループ体系レビュー記録。Plan: `/home/ubuntu/.claude/plans/rustling-launching-nest.md`

## Iteration 1 — Agent B 再検証 (C-8 / C-9 / C-11)

過去レビューで Agent B の Critical 3 件を "誤認 skip" と判定済 (`memory: project_review_2026_04_16.md`)。第三者視点で独立再検証した。

### C-8: webhook TX 境界

**Agent B の指摘**: webhook handler 全体が transaction 内にない (一部 INSERT が TX 外)

**再検証結果**: **skip 妥当**
- `packages/sync-service/src/shell/webhook.ts:54-385` の `handleWebhook` を実読。
- Early return path (ignored / validation-fail / idempotency-hit / subscription.created / member-not-found) は単独 `INSERT INTO payjp_events` で、`ON CONFLICT (id) DO NOTHING` が冪等性を保証。副次 write がないため TX 不要。
- Main update path (advisory lock → stale check → UPDATE members → INSERT payjp_events) は `deps.db.withTransaction(async (query) => { ... })` でラップ、atomic。
- Post-TX の role sync は best-effort (外部副作用のため意図的に TX 外)。
- コード内 `lines 28-32` に設計意図コメントが明記されており、commit `a0f6967` で docs 化済。

### C-9: admin-server 127.0.0.1 bind

**Agent B の指摘**: `app.listen({ host: '0.0.0.0' })` は admin-server の attack surface を拡大

**再検証結果**: **skip 妥当**
- `packages/admin-server/src/main.ts:54-58` を実読。
- Container 内 `0.0.0.0:3011` + docker-compose `expose: 3011` (no `ports:`) で、host には publish されない。
- Nginx (別 container) から docker network 経由で到達する設計。
- `127.0.0.1` に変更すると container 内 localhost のみ、nginx → admin-api 疎通が切断される。
- VPS レベルの 127.0.0.1 listen 制約 (`memory: project_vps_defense_state`) とは別次元 — そちらは host 側の話で、本件とは独立。
- コード内 `lines 54-57` に機能破壊の警告コメントあり、commit `a0f6967` 記録済。

### C-11: UUID redaction in error messages

**Agent B の指摘**: エラーメッセージに `operationId` (UUID) が含まれる可能性、log 経由で漏洩

**再検証結果**: **skip 妥当**
- `grep -r '\$\{operationId\}'` → 全 packages で該当なし (`packages/**/*.ts`)。
- `Error(...operation...)` pattern → `packages/shared/src/db/pg-db-client.ts:315` の 1 件のみ、これは `memberId` (internal PK) であり operationId ではない。PG-level 内部エラー、client response に直接露出しない。
- `error.message` 参照 → `packages/billing-service/src/shell/errors.ts:30` の `msg.toLowerCase()` のみ、interpolation なし。
- 将来的な runtime validation 導入 (`docs/architecture/runtime-validation-proposal.md`, D-10) の際に HTTP boundary redaction 統合を検討。現状「実害なし」。

### 総括

- Agent B の Critical 3 件は全て設計上意図的な挙動または実害のない偽陽性。
- 2 件 (C-8 / C-9) は既にコード内コメントで設計意図が明記済み。
- 1 件 (C-11) は grep 実証ベースで検証、将来の zod 導入で改善余地。

## Iteration 2 — Logic (L1〜L5) + Security (A1〜A5)

### 修正適用 (Fix)

- **L2** `packages/billing-service/src/shell/cancel.ts:256-266` — role_state fallback update 失敗時の `catch {}` を `slog` 化。line 239 の対称 branch と同一パターンに揃え、debuggability 向上。挙動不変 (166 tests pass)。
- **L4** `packages/sync-service/src/shell/webhook.ts:608-622` — `logUnmappedPlanWarning` の silent catch を `deps.log` で観測可能化。"Best-effort; daily resync will catch this" 設計は維持 (136 tests pass)。

### コメント補強 (Annotate)

- **L1** `packages/sync-service/src/shell/webhook.ts` MemberWebhookUpdateColumn — `cancel_requested_at` を webhook 更新列から意図的に除外している理由を FIND-L1 で明記。ユーザ起点 cancel vs PAY.JP 側イベントのセマンティック分離。
- **L3** `packages/sync-service/src/core/index.ts` shouldGrantPaidDiscordAccess — `_accessEndAt` / `_now` が未使用である根拠を FIND-L3 で明記 (2weeks-spec.md §1/§5 の「即時剥奪」必須要件)。pure-core.test.ts:186-197 で明示的にアサート済。

### 検証のみ、アクション不要 (no-op)

- **L5** `isEventStale` の `<` 厳密比較 — event.id idempotency + advisory lock による serial 処理で正当。同秒イベントは idempotency check (event.id) で先に弾かれる。
- **A1** `packages/auth-service/src/shell/index.ts` Discord token encrypt — 暗号化成功/失敗/key 未設定の全ケースで graceful degradation 正しく実装。link_session save 失敗時の revoke 経路も整合。
- **A2** `packages/billing-service/src/shell/subscribe.ts` 3DS TOCTOU — operationId 保存 → 3DS verify → createCustomer の順序は `security.md` 準拠。`isThreeDSecureVerified` は `'verified'` のみ true を返す厳格実装。
- **A3** `verifySharedPasscode` — sha256 ハッシュ長正規化 + `timingSafeEqual` による標準 constant-time 実装。
- **A4** `payjp_events` audit insert TX 境界 — C-8 と実質同一、main update path のみ `withTransaction`、early-return は単独 INSERT + ON CONFLICT DO NOTHING で冪等。
- **A5** `packages/admin-server/src/queries.ts:100-108` — 6 placeholder / 6 params / `next += 6` 整合、全 user input は parameterized bind で SQLi リスクなし。

### 総合検証

- `npm test`: 661 passed / 248 skipped / 0 failed (14s)
- `biome check` (変更3ファイル): clean
- 全 workspace typecheck: PASS (pre-commit hook)
- `git diff main..HEAD` レビュー: surgical 3 commits、挙動変更ゼロ、docs + comment + logging のみ

### Commits (本 iteration)

- `f2e49d2` refactor(review): L1/L2/L4 observability + webhook semantic annotation
- `2591466` refactor(review): L3 annotate shouldGrantPaidDiscordAccess spec rationale

### 結論

計 12 項目全てレビュー完了。4 項目で差分（2 fix + 2 annotate）、残り 8 項目は設計正当性を検証のみ。Go-Live 2026-04-20 前のコード品質保証として充分。CR 起票を要する仕様変更レベルの bug は未検出。
