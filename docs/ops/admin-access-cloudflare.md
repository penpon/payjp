# 管理画面アクセス制限（Cloudflare Access + Tunnel）

`admin.and--line.com` の前段認証と origin 到達制御の運用手順。正本は `docs/admin-console-boundary.md`（CR-005 / CR-006）。

- **認証**: Cloudflare Access（Self-hosted application） + Google IdP + MFA
- **到達制御**: Cloudflare Tunnel（cloudflared, outbound-only）
- **利用者**: 運用者 2 名（allowlist 方式）
- **コスト**: Cloudflare Zero Trust Free プラン（50 ユーザまで無料）で十分

## 1. 前提条件（手動確認）

1. 2 名の運用者が **Google アカウント側で 2 段階認証を有効化**していること（個人 Gmail でも可、ただし各自で有効化必須）。
2. Cloudflare 上で `and--line.com` ゾーンが管理下にあること。
3. VPS 上で `docker compose up -d` 済みで、nginx の `admin.and--line.com` server block が稼働していること。

## 2. Cloudflare Zero Trust セットアップ

### 2.1 Team 有効化

- Cloudflare ダッシュボード > **Zero Trust** を開き、Team name（`<team>.cloudflareaccess.com`）を作成。
- プラン: **Free**。

### 2.2 Google を IdP として登録

1. Google Cloud Console で OAuth 2.0 クライアント ID（Web application）を作成。
2. Cloudflare ダッシュボード > Zero Trust > **Settings > Authentication** で `Login methods > Add new` > `Google` を選択し、Client ID / Client Secret を入力。
3. Google Cloud Console 側の Authorized redirect URI に Cloudflare が提示する URL（`https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`）を登録。
4. **One-time PIN は追加しない**（`admin-console-boundary.md` §4.1）。

### 2.3 Access Application 作成

- Zero Trust > **Access > Applications > Add an application > Self-hosted**
- 設定:
  - Application name: `admin-and-line`
  - Session duration: `24h`（任意で短縮可）
  - Application domain: `admin.and--line.com` / path `/*`
  - Identity providers: **Google のみ有効化**

### 2.4 Access Policy（default deny）

Policy を 1 つ作成:

| 項目 | 値 |
|---|---|
| Action | `Allow` |
| Include | `Emails` = 運用者 2 名の Google アカウント email を明示列挙 |
| Require | `Authentication method = Google` |

- **bypass policy は作成しない**。
- Service Token も発行しない（初期スコープ外）。

## 3. Cloudflare Tunnel（cloudflared）導入

### 3.1 VPS への `cloudflared` インストール

Cloudflare 公式手順（Debian/Ubuntu）に従う。パッケージリポジトリ追加後:

```bash
sudo apt install cloudflared
cloudflared --version
```

### 3.2 Tunnel 作成と DNS ルーティング

```bash
# 1. Cloudflare アカウント認証（ブラウザ開く）
cloudflared tunnel login

# 2. Tunnel 作成
cloudflared tunnel create admin-and-line

# 3. 作成された Tunnel ID と credentials ファイルパスを控える
#    例: /home/ubuntu/.cloudflared/<tunnel-id>.json

# 4. admin.and--line.com を Tunnel 宛 CNAME に切り替え
cloudflared tunnel route dns admin-and-line admin.and--line.com
```

### 3.3 Tunnel 設定ファイル

`/etc/cloudflared/config.yml`（または `~/.cloudflared/config.yml`）:

```yaml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json

ingress:
  - hostname: admin.and--line.com
    # admin vhost は nginx コンテナ内で `listen 127.0.0.1:8443 ssl;`(nginx/nginx.conf)。
    # docker-compose.yml で host 127.0.0.1:8443 に publish 済。
    # cloudflared はホスト側インストール(ホストの loopback から nginx の publish port へ接続)。
    service: https://localhost:8443
    originRequest:
      originServerName: admin.and--line.com
      # nginx は Let's Encrypt 証明書なので caPool 指定不要
  - service: http_status:404
```

- nginx admin vhost は `listen 127.0.0.1:8443 ssl;`。docker-compose で `127.0.0.1:8443:8443` publish 済み（H-A(改) 2026-04-14、`security-hardening-pm`）。
- 外部 443 からは admin vhost に到達しない（default_server が 444 を返す）— cloudflared 導入有無に関わらず admin の外部到達は既に遮断されている。
- cloudflared 未導入の状態では、運用者は SSH port-forward で admin を開く: `ssh -L 8443:127.0.0.1:8443 <vps>` → ブラウザで `https://admin.and--line.com/`（ただし `admin.and--line.com:8443` を hosts や SSH dynamic forwarding で解決する必要あり、もしくは `https://localhost:8443/` 直接でも SNI 一致するよう設定）。

### 3.4 systemd サービス化

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

### 3.5 credentials ファイルの権限

```bash
sudo chown root:root /etc/cloudflared/<tunnel-id>.json
sudo chmod 600 /etc/cloudflared/<tunnel-id>.json
```

リポジトリにコミットしない。

## 4. Origin 外部到達遮断（実装済み 2026-04-14 / H-A(改)）

`admin-console-boundary.md` §5-4「Cloudflare 送信元以外を拒否」は **すでに実装済み**。

実装形態（§3.3 の前提）:

- admin vhost は nginx コンテナ内で `listen 127.0.0.1:8443 ssl;`（`nginx/nginx.conf`）。
- docker-compose で `127.0.0.1:8443:8443` のみ host publish（`docker-compose.yml`）。
- `www.and--line.com` / `api.and--line.com` は `0.0.0.0:443:443` 公開のまま（公開サービスは影響なし）。
- admin-api は docker network `admin-frontend` に隔離済（H-A(改)、`api` コンテナが compromise されても admin-api に到達不可）。

過去に検討した代替案（参考）:

- A. 公開サービスも Tunnel 化してから 443 を UFW 全遮断（最厳格・別作業）
- B. nginx で Cloudflare 送信元 IP allowlist 限定（公開サービス現状維持）
- C. admin vhost を loopback 限定 ← **採用済み（H-A(改) で 127.0.0.1:8443 に変更、internal port 分離で SSH port-forward / cloudflared 両経路と整合）**

Docker ネットワーク内からの cloudflared 接続は使わない方針（cloudflared は **ホスト側インストール** で、ホストの `127.0.0.1:8443` → docker-proxy → nginx コンテナ `127.0.0.1:8443`）。

## 5. 動作確認

1. **拒否の確認**（非許可 Google アカウントで）:
   - ブラウザで `https://admin.and--line.com/` を開く
   - Google ログイン → Cloudflare Access の拒否画面表示を確認
2. **許可の確認**（許可運用者アカウントで）:
   - `https://admin.and--line.com/` → Google ログイン → MFA → 管理画面 SPA 表示
3. **監査ログの確認**:
   ```bash
   docker compose logs admin-api | grep auditActor
   ```
   `auditActor: "<email>"` が記録されていること。
4. **origin 直接到達の遮断確認**（§4 実施時）:
   ```bash
   curl --resolve admin.and--line.com:443:<origin-ip> https://admin.and--line.com/ -I
   ```
   接続拒否またはタイムアウトになること。
5. **セッション失効**:
   - §2.3 の `Session duration` 経過後、再認証が要求されること。

## 6. 利用者の追加・削除

Zero Trust > Access > Applications > `admin-and-line` > Policies > Include > Emails を編集して保存。即時反映。削除対象ユーザの既存セッションを即時無効化するには、同画面の `Revoke sessions` を実行。

## 7. トラブルシュート

- **Cloudflare Access ログインループ**: IdP の redirect URI が `<team>.cloudflareaccess.com/cdn-cgi/access/callback` と一致しているか確認。
- **502/521 on admin.and--line.com**: `systemctl status cloudflared` と `journalctl -u cloudflared -n 100` を確認。`ingress` の `service:` が nginx listen port と一致しているか確認。
- **`CF-Access-Authenticated-User-Email` が空**: `admin-server` 到達前に Cloudflare Access を経由していない（Tunnel 外からの直接到達）。§4 の遮断を確認。

## 8. 関連文書

- `docs/admin-console-boundary.md` — 仕様正本（CR-005 / CR-006）
- `docs/ops/admin-console.md` — 管理画面構成・環境変数
- `docs/2weeks-spec.md` §15 将来拡張 / CR-006
