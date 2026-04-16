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
- **追加修正不要。次 iteration から L1〜L5, A1〜A5 の 10 項目に進む。**
