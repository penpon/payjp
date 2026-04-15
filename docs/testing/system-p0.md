# System / Integration テスト（ブラウザ E2E 外の P0）

[2weeks-spec.md](../2weeks-spec.md) 12.1 P0 のうち、**並列性・Webhook 順序・CLI 復旧・日次再同期**などは実ブラウザではなく **Vitest / サーバー inject E2E** で担保する。  
ブラウザで見る導線は [browser-e2e.md](./browser-e2e.md) を参照。

## 503・二重課金・CLI・operationId

| 観点 | 主なテスト置き場 |
|------|------------------|
| 課金の不確定失敗・503 + operationId | [packages/billing-service/src/__tests__/integration/failure-handling.test.ts](../packages/billing-service/src/__tests__/integration/failure-handling.test.ts)、[packages/server/src/__tests__/billing-routes.test.ts](../packages/server/src/__tests__/billing-routes.test.ts) |
| 再同期・CLI 系 | [packages/sync-service/src/__tests__/integration/resync-flow.test.ts](../packages/sync-service/src/__tests__/integration/resync-flow.test.ts) |

## Webhook・失効・再同期

| 観点 | 主なテスト置き場 |
|------|------------------|
| Webhook 認証・冪等 | [packages/server/src/__tests__/e2e/webhook-auth.test.ts](../packages/server/src/__tests__/e2e/webhook-auth.test.ts) |
| イベント種別・順序 | [packages/server/src/__tests__/e2e/webhook-events.test.ts](../packages/server/src/__tests__/e2e/webhook-events.test.ts) |
| 日次再同期 | [packages/sync-service/src/__tests__/integration/daily-resync.test.ts](../packages/sync-service/src/__tests__/integration/daily-resync.test.ts) |

## サーバー E2E ハーネス（inject）

実 DB + モック PAY.JP/Discord の共通ビルダーは [packages/server/src/__tests__/e2e/helpers.ts](../packages/server/src/__tests__/e2e/helpers.ts)。  
Vitest 非依存の素モックは [packages/server/src/e2e/e2e-mocks.ts](../packages/server/src/e2e/e2e-mocks.ts)（`e2e-serve.ts` もここを利用）。

## Issue 対応表（計画メモ）

| 計画 Issue 相当 | 内容 |
|-----------------|------|
| browser 基盤 | Playwright 設定・`e2e-serve`・モック方針 → 本ディレクトリ + `package.json` スクリプト |
| OAuth / session | `oauth-session.spec.ts` + `oauth-browser-flow.ts` |
| 購読 | `subscribe.spec.ts` |
| 退会・購読状況 | `member-journey.spec.ts` |
| スモーク | `smoke.spec.ts` |
| system: 復旧・CLI | 上記 billing/sync integration |
| system: Webhook・再同期 | 上記 server e2e + sync integration |
