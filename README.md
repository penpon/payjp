# PAY.JP × Discord 連携サービス MVP

PAY.JP 定期課金の状態に応じて Discord ロールを自動付与/剥奪するサービス。

- **リリース目標**: 2026-04-20
- **体制**: 1名
- **仕様書**: `2weeks-spec.md` / `implementation-design-mvp.md` / `tdd-acceptance-matrix-mvp.md`

## サービス構成

| パッケージ | 責務 | 要件 |
|---|---|---|
| `packages/shared` | 型定義・DBスキーマ・共通ロジック | — |
| `packages/auth-service` | Discord OAuth Lite | R1 |
| `packages/billing-service` | PAY.JP課金・解約 | R2-R5 |
| `packages/sync-service` | Webhook・ロール同期・手動CLI | R6-R8 |
| `frontend` | 購読UI | — |

## セットアップ

```bash
npm install
```

## 技術スタック

- TypeScript / Node.js（統一）
- PostgreSQL
- `payjp` npm — PAY.JP SDK
- `@discordjs/rest` — Discord REST API
- Biome — Formatter / Linter
- npm workspaces — モノレポ管理

## デプロイ構成（Cloudflare Pages + API サーバー）

### eTLD+1 同一構成

`__Host-` Cookie は Domain 属性なし・Secure 必須のため、**フロントエンドと API が同一ホスト**で動作する必要がある。

| レイヤー | URL 例 | 実態 |
|---|---|---|
| フロントエンド | `https://app.example.com/` | Cloudflare Pages |
| API | `https://app.example.com/v1/*` | Pages Function → バックエンドへプロキシ |
| バックエンド | `https://api.example.com/v1/*` | Docker / VPS（外部非公開でも可） |

ブラウザは `/v1/*` を同一オリジンとして認識するため、`__Host-` Cookie はバックエンドが `Set-Cookie` で発行しても `app.example.com` に紐付けられる。

### Cloudflare Pages 設定手順

1. **ビルド設定**（Pages ダッシュボード）

   | 項目 | 値 |
   |---|---|
   | Framework preset | Vite |
   | Build command | `npm run build` |
   | Build output directory | `frontend/dist` |
   | Root directory | `frontend` |

2. **環境変数**（Pages → Settings → Environment variables）

   | 変数名 | 説明 |
   |---|---|
   | `CF_API_ORIGIN` | バックエンドの origin（例: `https://api.example.com`） |
   | `VITE_PAYJP_PUBLIC_KEY` | PAY.JP 公開鍵（`pk_live_` or `pk_test_`） |

3. **動作確認チェックリスト**

   - [ ] `https://app.example.com/v1/auth/discord/session` が 200 または 401 を返す
   - [ ] レスポンスに `Set-Cookie: __Host-session=...` が含まれる
   - [ ] Cookie に `Domain` 属性が**ない**こと（DevTools → Application → Cookies で確認）
   - [ ] 再リクエスト時にブラウザが `Cookie: __Host-session=...` を送信していること

## 開発フロー

VCSDD（Verified Contract-based Spec-Driven Development）を主軸とする。
詳細は `CLAUDE.md` および `.vcsdd/` を参照。
