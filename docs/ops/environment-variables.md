# 環境変数リファレンス

`.env.example` を正本としたうえで、各変数の**取得元**・**本番とローカルの差**・**`op://` 参照可否**・**関連ドキュメント**を一覧する。

`op://` 参照を使う場合、`docker compose up` 単体では解決されない。`npm run docker:up` (内部で `bash scripts/local/docker-compose-op.sh`) もしくは `op run --env-file=.env -- <cmd>` 経由で起動する。

## 1. PostgreSQL

| 変数 | 取得元 | 本番 / ローカル差 | `op://` 可 | 備考 |
|---|---|---|---|---|
| `POSTGRES_DB` | 任意 (Docker 内部) | 同一 | ✓ | Compose がコンテナ初期化に使用 |
| `POSTGRES_USER` | 任意 | 同一 | ✓ | 同上 |
| `POSTGRES_PASSWORD` | ランダム生成推奨 | **本番は 1Password 必須** | ✓ | Compose / API 両方で参照 |
| `DATABASE_URL` | 上記 3 変数から構築 | ローカル: `postgres://hayane:changeme@localhost:5432/hayane` / 本番: `op://` | ✓ | Node アプリが接続先として使用 |

## 2. Discord OAuth

| 変数 | 取得元 | 本番 / ローカル差 | `op://` 可 | 備考 |
|---|---|---|---|---|
| `DISCORD_CLIENT_ID` | [Discord Developer Portal](https://discord.com/developers/applications) → OAuth2 | 同一アプリを流用 | ✓ | |
| `DISCORD_CLIENT_SECRET` | 同上 | 同上 | ✓ | |
| `DISCORD_REDIRECT_URI` | Portal の Redirects 設定値 | ローカル: `http://localhost:3000/v1/auth/discord/callback` / 本番: `https://www.and--line.com/v1/auth/discord/callback` | — | |

## 3. Discord Bot / Guild

| 変数 | 取得元 | 本番 / ローカル差 | `op://` 可 | 備考 |
|---|---|---|---|---|
| `DISCORD_BOT_TOKEN` | Developer Portal → Bot | 同一 Bot を流用 | ✓ | Manage Roles 権限必須 |
| `DISCORD_GUILD_ID` | Discord サーバー (開発者モードで右クリックコピー) | 同一 | — | |
| `DISCORD_PLAN_ROLE_IDS` | Discord ロール ID | 同一 | — | `PAYJP_PLAN_IDS` と同じ順序・要素数 (CSV) |

## 4. PAY.JP

| 変数 | 取得元 | 本番 / ローカル差 | `op://` 可 | 備考 |
|---|---|---|---|---|
| `PAYJP_SECRET_KEY` | [PAY.JP ダッシュボード](https://pay.jp/) → API キー → 秘密鍵 | テスト / ライブで別物 | ✓ | サーバー側のみ |
| `PAYJP_WEBHOOK_TOKEN` | PAY.JP → Webhook → トークン | 同上 | ✓ | |
| `PAYJP_LIVEMODE` | — | ローカル: `false` / 本番: `true` | — | 混在禁止 |
| `PAYJP_PLAN_IDS` | PAY.JP → 定期課金プラン | 同上 | — | CSV |
| `PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS` | プラン設計に依存 | 同上 | — | 正整数 CSV、`PAYJP_PLAN_IDS` と順序一致 |
| `VITE_PAYJP_PUBLIC_KEY` | PAY.JP → API キー → 公開鍵 | テスト / ライブで別物 | — (ビルド時埋込) | フロント側のみ、Vite が build 時に static 埋込 |

## 5. Frontend / Gate / Admin

| 変数 | 取得元 | 本番 / ローカル差 | `op://` 可 | 備考 |
|---|---|---|---|---|
| `FRONTEND_BASE_URL` | — | ローカル: `http://localhost:3000` 等 / 本番: `https://www.and--line.com` | ✓ | origin 形式のみ |
| `SUBSCRIBE_GATE_CODE` | 運用決定 | 空なら gate 無効 | ✓ | `docs/ops/access-gate.md` |
| `ACCESS_GATE_SESSION_TTL_SECONDS` | 運用決定 | 同一 (正整数) | ✓ | ブラウザ gate cookie の Max-Age |
| `ADMIN_FRONTEND_ORIGIN` | — | 本番: `https://admin.and--line.com` | — | `docs/ops/admin-console.md` |
| `PORT` | — | デフォルト `3000` | — | API サーバポート |

## 6. Google Form (退会)

| 変数 | 取得元 | 本番 / ローカル差 | `op://` 可 | 備考 |
|---|---|---|---|---|
| `GOOGLE_FORM_CANCEL_BASE_URL` | 退会受付 Google Form の `viewform` URL | 同上 | — | `docs/ops/apps-script-cancel.md` |
| `GOOGLE_FORM_CANCEL_EMAIL_ENTRY_ID` | Form の `entry.<id>` の `<id>` 部分 (email) | 同上 | — | |
| `GOOGLE_FORM_CANCEL_TOKEN_ENTRY_ID` | Form の `entry.<id>` の `<id>` 部分 (token) | 同上 | — | |
| `GOOGLE_FORM_CANCEL_SECRET` | Apps Script ↔ アプリ間の共有シークレット | ローカルはダミー OK | ✓ | |
| `GOOGLE_FORM_CANCEL_TOKEN_SECRET` | 退会用署名トークンの HMAC secret | 同上 | ✓ | |
| `GOOGLE_FORM_CANCEL_TOKEN_TTL_SECONDS` | 運用決定 | 同一 (正整数) | — | Google Form 遷移リンクの有効秒数 |

## 7. 運用

| 変数 | 取得元 | 本番 / ローカル差 | `op://` 可 | 備考 |
|---|---|---|---|---|
| `DAILY_RESYNC_CRON` | 運用決定 | 同一 (cron 構文、JST 評価) | — | `docs/ops/resync-cli.md` |

## `.env*` 取り扱いルール

- `.env` `.env.*` の中身を Claude / Read ツール / `cat` / `grep` で**読み取り禁止**
- 必要な値は `op read` もしくは `op run --env-file=.env -- <cmd>` で per-item / per-process 注入
- `op://` を含む `.env` は `docker compose` 直 (`op run` なし) では解決されず起動失敗
- ops サービスは **systemd-creds** で secret を machine-bound 配布 (`docs/ops/backup-restore.md` 参照)
