# 管理画面（`admin.and--line.com`）ローカル / 本番

Phase A は **read-only** です（`docs/admin-console-boundary.md`）。

## 構成

- **admin-frontend**: Vite 静的ビルド（一覧・詳細・概要）
- **admin-api** (`@hayane/admin-server`): Fastify、**GET のみ**、PostgreSQL 参照
- **nginx**: `Host: admin.and--line.com` で静的配信 + `/admin/*` を admin-api にリバースプロキシ

## 環境変数（admin-api）

| 変数 | 例 | 説明 |
|------|-----|------|
| `DATABASE_URL` | `postgres://...` | 本番DBと同一スキーマ（マイグレーション実行） |
| `ADMIN_FRONTEND_ORIGIN` | `https://admin.and--line.com` | CORS 許可オリジン（末尾スラッシュなし） |
| `ADMIN_API_KEY` | `long-random-string` | ローカル検証時のフォールバック認証キー（Cloudflare Access 経由時は不要） |
| `PORT` | `3011` | リッスンポート |

`admin-api` は GET/HEAD リクエストで次のどちらかを要求します。

1. Cloudflare Access の `CF-Access-Authenticated-User-Email` ヘッダ
2. ローカル検証時の `X-Admin-Audit-Actor` + `X-Admin-Api-Key`（`ADMIN_API_KEY` と一致）

認証済みリクエストでは `auditActor` をログに記録します。

## フロント（ビルド）

```bash
npm run build:admin-frontend
```

開発時:

```bash
npm -w @hayane/admin-frontend run dev
# VITE_ADMIN_API_BASE=http://localhost:3011 のように API を直指定可能
```

## Docker Compose

`docker-compose.yml` の `admin-api` サービスが `Dockerfile.admin` を使用します。`admin-frontend/dist` を nginx にマウントする前に上記ビルドが必要です。
