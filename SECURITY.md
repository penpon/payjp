# Security Policy

本リポジトリ (PAY.JP × Discord 連携 MVP) のセキュリティ脆弱性報告先とスコープ。

## Reporting a Vulnerability

- **連絡先**: `animato.techno2022@gmail.com` もしくは運用チームの Discord (連絡先は [`docs/ops/incident-contacts.md`](docs/ops/incident-contacts.md))
- **期待応答**: 48 時間以内に初回応答、以後 PoC 共有と修正方針すり合わせ
- **機密情報**: PoC・スクリーンショット・ログ断片には **カード番号・PAY.JP トークン・セッション ID・Cookie 値** を含めない。必要なら値をマスクして提出

## Scope

- `packages/*` の実装 (auth / billing / sync / server / admin-server / shared)
- `frontend/`, `admin-frontend/` のクライアント実装
- `scripts/ops/`, `deploy/ops-systemd/` の運用スクリプト
- `nginx/` のエッジ設定
- 外部公開: `www.and--line.com` (購読 UI), `admin.and--line.com` (管理 console、Cloudflare Access 保護)

## Out of Scope

- PAY.JP 側の脆弱性 (PAY.JP 公式サポート窓口へ)
- Discord 側の脆弱性 (Discord 公式セキュリティチームへ)
- 本 repo の fork / snapshot (本 repo 固有の修正は対象外)
- GitHub / Cloudflare / 1Password / B2 など外部プラットフォーム側の脆弱性 (各サービスの窓口へ)

## 既知の運用ガードレール

- 3DS `verified` 強制、`operationId` 先行保存、不確定失敗 503 (`docs/2weeks-spec.md` §5)
- `__Host-` prefix cookie で `Secure, Path=/, HttpOnly, SameSite=Lax` 固定 (`docs/2weeks-spec.md` §6)
- `.env*` は Claude / ローカルツールから読み取り禁止、1Password CLI (`op read` / `op run`) 経由のみ
- nginx / fail2ban / UFW / CF Access / 外部監視の詳細は `docs/ops/` 配下
