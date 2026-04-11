# ブラウザ E2E（Playwright）

MVP のユーザージャーニー（OAuth・購読・退会導線・薄いスモーク）は **Playwright + Chromium** で `e2e/` に置く。  
**P0 の網羅**は [tdd-acceptance-matrix-mvp.md](./tdd-acceptance-matrix-mvp.md) を正とし、ブラウザに載せないものは [testing-system-p0.md](./testing-system-p0.md) の Vitest / サーバー E2E に残す。

## 前提

- PostgreSQL（`DATABASE_URL` または `DATABASE_URL_TEST`）
- 初回: `npm run e2e:install`（Chromium + システム依存）
- Linux で `libatk` 等が足りない場合は `sudo npx playwright install-deps chromium` または同等パッケージを入れる

## コマンド

| コマンド | 説明 |
|---------|------|
| `npm run e2e` | Playwright テスト実行（[playwright.config.ts](../playwright.config.ts) が API + Vite を起動） |
| `npm run e2e:ui` | UI モード |
| `npm run e2e:install` | ブラウザバイナリ取得 |

例:

```bash
export DATABASE_URL='postgres://user:pass@localhost:5432/payjp?sslmode=disable'
npm run e2e
```

任意: `E2E_BASE_URL`（既定 `http://localhost:5173`）、`E2E_API_PORT`（既定 `3999`）。

## 構成

| パス | 役割 |
|------|------|
| [playwright.config.ts](../playwright.config.ts) | `webServer`: `@hayane/server` の `e2e:serve` → フロント `dev`、baseURL・Chrome フラグ |
| [packages/server/src/e2e-serve.ts](../packages/server/src/e2e-serve.ts) | ブラウザ E2E 専用 API。Vitest 非依存のモックは [e2e-mocks.ts](../packages/server/src/e2e/e2e-mocks.ts) |
| [e2e/fixtures/payjp-mock.ts](../e2e/fixtures/payjp-mock.ts) | 本物の `pay.js` の代わりに `js.pay.jp/v2/pay.js` を差し替え |
| [e2e/fixtures/oauth-browser-flow.ts](../e2e/fixtures/oauth-browser-flow.ts) | OAuth: `page.route` はメインフレームの Discord 遷移を拾えないため、`request.get(/start)` + `goto(/callback)` |

## テスト一覧（概要）

| ファイル | 内容 |
|----------|------|
| `e2e/tests/smoke.spec.ts` | トップ・プラン選択の表示 |
| `e2e/tests/oauth-session.spec.ts` | OAuth 完了後 `/v1/auth/discord/session` が linked |
| `e2e/tests/subscribe.spec.ts` | 課金フォームから登録完了まで |
| `e2e/tests/member-journey.spec.ts` | 登録 → OAuth → 購読状況 → 退会モーダル → Google Form |

## 注意

- **`__Host-*` + Secure Cookie** は http ローカルで扱いづらいため、[playwright.config.ts](../playwright.config.ts) で `localhost` ベース URLと Chrome の `--unsafely-treat-insecure-origin-as-secure` を使用している。
- **Discord 外部ドキュメント遷移**は `page.route` ではメインリクエストを捕捉できない場合があるため、OAuth 完了は `oauth-browser-flow.ts` の API 駆動に統一している。
