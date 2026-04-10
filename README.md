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

## ローカル起動手順

### 前提条件

- Node.js 22+、Docker（Docker Compose）

### 1. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集して以下を入力：

| 変数 | 取得場所 |
|---|---|
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | [Discord Developer Portal](https://discord.com/developers/applications) → OAuth2 |
| `DISCORD_REDIRECT_URI` | ローカルは `http://localhost:3000/v1/auth/discord/callback` のまま |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → Bot |
| `DISCORD_GUILD_ID` | DiscordサーバーID（開発者モードで右クリックコピー）|
| `DISCORD_PAID_ROLE_ID` | 付与対象ロールのID |
| `PAYJP_SECRET_KEY` | [PAY.JP ダッシュボード](https://pay.jp/) → APIキー → 秘密鍵 |
| `PAYJP_WEBHOOK_TOKEN` | PAY.JP → Webhook → トークン |
| `PAYJP_PLAN_IDS` | PAY.JP → 定期課金プランID（カンマ区切り） |
| `VITE_PAYJP_PUBLIC_KEY` | PAY.JP → APIキー → 公開鍵 |

### 2-A. Docker Compose で起動（推奨）

API サーバー（ポート 3000）+ PostgreSQL をまとめて起動。**DBマイグレーションは自動実行**。

`.env` に **1Password の参照**（`op://...`）をそのまま書いている場合、Docker Compose は参照を解決しないため、**1Password CLI で注入してから**起動する必要がある。

```bash
# 推奨: op:// を含む .env 用（1Password CLI が PATH にあり、セッション済みであること）
npm run docker:up
# または
bash scripts/docker-compose-op.sh up --build
```

`op://` を含まない通常の `.env`（`.env.example` をベースにしたローカル値）では、このスクリプトは通常の `docker compose` をそのまま実行する。

```bash
docker compose up --build
```

**トラブルシュート（`op://` 関連）**

- PostgreSQL に `FATAL: role "op://ENV/.../credential" does not exist`、または API に `FRONTEND_BASE_URL ... got: op://...` が出る場合、**`op://` が解決されないまま** `docker compose` を直接実行している可能性が高い。`npm run docker:up` または `bash scripts/docker-compose-op.sh up --build` で起動し直す（1Password CLI で `op signin` 済みであること）。
- ログに `POST /cgi-bin/...` と **status 400** や **444** が出る場合、インターネット上の自動スキャンが典型である。アプリが CGI を使っていなければ侵入成功のログではない（nginx 側で拒否・接続切断される想定）。

### 2-B. ローカル開発（フロントエンドのホットリロードあり）

**ターミナル 1 — DB のみ Docker で起動：**

```bash
docker compose up db
```

**ターミナル 2 — API サーバー（DBマイグレーション自動）：**

```bash
npm install
cd packages/server && npm run start
```

**ターミナル 3 — フロントエンド（`/v1/*` を自動でポート 3000 にプロキシ）：**

```bash
cd frontend && npm run dev
# → http://localhost:5173 で起動
```

### 動作確認

```bash
# セッション確認（401 が返れば API は起動している）
curl http://localhost:3000/v1/auth/discord/session

# フロントエンド（2-B の場合）
open http://localhost:5173
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
