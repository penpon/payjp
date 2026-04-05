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

## 開発フロー

VCSDD（Verified Contract-based Spec-Driven Development）を主軸とする。
詳細は `CLAUDE.md` および `.vcsdd/` を参照。
