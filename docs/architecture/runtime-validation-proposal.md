# Runtime Validation Proposal — zod 段階導入

- **Status**: DRAFT (2026-04-16)
- **Scope**: post-MVP — Go-Live (2026-04-20) までは現状維持、以後段階導入
- **Authors**: 2026-04-16 レビュー結果 (`/home/ubuntu/.claude/plans/immutable-booping-fairy.md`) に基づく
- **Related findings**: Agent A review — `any`/`unknown` + `as` cast の混用 (163 箇所推定)

## 背景

現状の信頼境界:

| レイヤー | 型の扱い | 観察される問題 |
|---|---|---|
| HTTP route (Fastify) | schema なしで `req.body as T` | payload 構造違反が route handler 内で `undefined` 参照として顕在化 |
| Webhook payload (PAY.JP) | `WebhookEvent` interface + optional chaining | 新 event type や field 追加時に silent 受容、`as` cast 多数 |
| CLI args | `process.argv` の parse をハンドメイド | 型 narrow が弱く `as unknown as X` 経由 |

**強み**: Pure core + Shell 分離で副作用が外殻に閉じている。Core 関数は 引数レベルで完結。

**弱み**: Shell 層で「外部入力 → core 関数への引数」の橋渡しが `as` cast と optional chaining 頼りで、runtime で構造エラーに気づきにくい。

## 目的

1. **早期失敗**: 不正な payload を handler 到達前に 400/401 で reject
2. **型整合**: static 型と runtime 検証結果を一致させる (`z.infer<Schema>` → handler 内で unchecked)
3. **保守性**: schema を 1 箇所に集約、破壊的変更時に grep で影響範囲特定

## 採用候補

| ライブラリ | 特徴 | 本 proposal での評価 |
|---|---|---|
| **zod** | TypeScript-first、型推論強、生態系大、ESM 対応 | ★ 推奨 |
| valibot | zod 比で軽量 (bundle size 10x 小) | ★ frontend で有効、backend は zod で十分 |
| io-ts | fp-ts 前提、学習コスト高 | × 本 repo の関数型傾向と合うが依存ツリー肥大 |
| ajv | JSON Schema 準拠、Fastify 標準 | ★ Fastify の `schema` オプションで併用可能 |

**推奨**: backend = zod、frontend = 既存無し (将来 valibot を検討)。**Fastify の `schema` (ajv) との使い分け** → HTTP route body 検証は Fastify schema、PAY.JP webhook / 内部関数は zod。

## 段階計画

### Phase 1 (2026-05、Go-Live 後 2 週間)

**目的**: 最もリスクの高い Webhook エントリに zod を適用

- `packages/sync-service` に `zod` を追加 (dev + prod)
- `packages/sync-service/src/shell/schemas.ts` を新設、`WebhookEventSchema` を定義
- `packages/sync-service/src/shell/webhook.ts:78` `req.body as WebhookEvent` を `WebhookEventSchema.safeParse(req.body)` に置換
- 既存 `WebhookEvent` interface は `z.infer<typeof WebhookEventSchema>` で置き換え

**サンプル実装** (proposal — Go-Live 前は適用しない):

```typescript
// packages/sync-service/src/shell/schemas.ts
import { z } from 'zod';

export const WebhookEventSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  livemode: z.boolean().optional(),
  created: z.number().optional(),
  data: z.object({
    id: z.string().optional(),
    object: z.string().optional(),
    status: z.string().optional(),
    current_period_end: z.union([z.number(), z.string()]).optional(),
    plan: z.object({ id: z.string() }).optional(),
    metadata: z.object({
      member_id: z.string().optional(),
      operation_id: z.string().optional(),
      discord_user_id: z.string().optional(),
    }).optional(),
  }).optional(),
});

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
```

```typescript
// packages/sync-service/src/shell/webhook.ts (該当行のみ)
const parseResult = WebhookEventSchema.safeParse(req.body);
if (!parseResult.success) {
  deps.log({
    service: 'sync-service',
    endpoint: '/v1/payjp/webhook',
    result: 'failure',
    error: 'schema_validation_failed',
    issues: parseResult.error.issues.map((i) => i.path.join('.')),
  } as LogEntry);
  return { status: 400, body: { error: 'Bad Request' } };
}
const event = parseResult.data;
```

**検証項目**:
- 既存 `packages/sync-service/src/__tests__/integration/webhook-flow.test.ts` が全 PASS
- 不正 payload (例: `type` 欠落、`data.metadata.operation_id` が number 等) で 400 返却 + `payjp_events` 非保存 (既存 T-P0-07 拡張)

### Phase 2 (2026-05〜06)

- `packages/server/src/routes/*.routes.ts` の HTTP body/query 検証を Fastify `schema` (ajv) で統一
- zod を使わない。Fastify 標準 feature を活用、依存追加ゼロ

### Phase 3 (2026-06 以降)

- CLI entry (`packages/server/src/resync-cli.ts`, `truncate-app-data-cli.ts`, `invalidate-access-gate-sessions-cli.ts`) の arg parse を zod 化
- `packages/billing-service/src/shell/cancel.ts` 等の外部入力接面を順次 zod 化
- `any` / `as unknown as` 検出を `scripts/dev/check-unsafe-casts.ts` として作成、CI に warn-only で組み込む

### Phase 4 (長期)

- OpenAPI spec (docs の API 契約) → zod schema 自動生成 or その逆 (例: `zod-to-openapi`)
- schema の源を単一化 (現状の `packages/shared/src/types.ts` と contract を bridging)

## UUID redaction との統合

Agent B 指摘の `packages/server/src/app.ts:16` UUID redaction は、現状 `error.message` に operationId が流入しない設計のため実害なし。ただし Phase 3 で CLI arg を zod 化する際に、エラーメッセージ内の UUID を構造化ログに移行する。そこで operationId を redaction 対象から除外する allow-list を一括整備する。

## 非採用案

- **全面書き換え**: 段階適用でなく全 layer 同時移行 → 移行コスト・リスク過大、skip
- **io-ts**: fp-ts エコシステム連動必要、学習コストと本 repo の傾向ミスマッチ
- **runtime schema 生成なし**: TypeScript compile time のみでは外部入力を守れない、本 proposal の動機と矛盾

## 参考

- zod docs: https://zod.dev/
- Fastify schema: https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/
- レビュー報告: `/home/ubuntu/.claude/plans/immutable-booping-fairy.md` Agent A findings

## 備考

本 proposal は Go-Live 後の段階導入を前提とする。MVP 期間中 (2026-04-20 まで) は現状コードで固定し、zod 導入による回帰リスクを避ける。
