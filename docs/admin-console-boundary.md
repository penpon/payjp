# 管理画面（運用UI）仕様

本書は **CR-005** および **CR-006** に対応する。MVP Go-Live（2026-04-20）までは管理画面を **実装しない**（`2weeks-spec.md` §3 非スコープ）。Go-Live 後に着手する場合の **ホスト名・認証・配置・段階ロールアウト・緊急操作境界** を本書で固定する。

## 1. 固定方針

| 項目 | 決定内容 |
|------|----------|
| 管理画面ホスト名 | `admin.and--line.com` |
| 前段認証 | **Cloudflare Access** |
| 認証方式 | **外部IdP + MFA** を主手段とする |
| 配置 | **同一VPS** を使用するが、公開アプリとは **別プロセス/別コンテナ/別ポート** に分離する |
| ロールアウト | **Phase A: read-only** -> **Phase B: 緊急操作** |

## 2. スコープ

| 項目 | 方針 |
|------|------|
| MVP（〜2026-04-20） | 管理画面は追加しない。緊急復旧は手動再同期CLI + 運用文書に従う。 |
| リリース後 Phase A | read-only の会員検索・一覧・詳細・障害確認を提供する。 |
| リリース後 Phase B | 緊急操作を限定追加する。対象は単一会員の手動再同期、ロール調整、課金停止相当とする。 |

以下は本書の対象外とする。

- 一般利用者向けポータル
- 公開アプリ配下での管理画面同居
- ブラウザからの DB / PAY.JP / Discord 直接アクセス
- 初期段階での一括全会員操作UI

## 3. ホスト名とオリジン分離

- 利用者向けアプリは `www.and--line.com` と `api.and--line.com` を前提とする。
- 管理画面は **`admin.and--line.com` に固定**し、利用者向け `__Host-oauth_session` / `__Host-link_session` / `__Host-member_session` とは **オリジン・Cookie を共有しない**。
- 公開アプリ (`www.and--line.com` / `api.and--line.com`) から `admin.and--line.com` へのリンク、導線、CORS 許可は設けない。
- 管理画面のブラウザセッションは Cloudflare Access が管理し、利用者向け Cookie と混在させない。

## 4. Cloudflare Access と IdP + MFA

### 4.1 必須要件

- `admin.and--line.com/*` を対象に **Cloudflare Access の Self-hosted application** を必須化する。
- Cloudflare Access の認証元には **MFA を強制できる外部IdP** を使う。
- **One-time PIN** のような簡易認証は無効化し、IdP 経由のみを許可する。
- Access ポリシーは **default deny** とし、許可ルールは以下のいずれかに限定する。
  - 明示メールアドレス allowlist
  - IdP 側の管理者グループ
- **一般利用者向けドメイン全体許可**（例: `@and--line.com` 全員許可）は行わない。
- MFA は IdP 側で必須化し、Cloudflare Access 側では **IdP 認証済みのセッションのみ** 通す。

### 4.2 到達制御

- Cloudflare Access を通過していないリクエストは、**origin に到達させない**。
- Access bypass policy は定義しない。
- 管理UI用の自動化が必要になった場合でも、初期段階では **ブラウザUI向けのみ** を対象とし、Service Token 経路は追加しない。

### 4.3 実装時の運用固定

- 許可対象は「特定ユーザ」または「管理者グループ」のみとし、初期セットアップ時に明示登録する。
- 利用者が `admin.and--line.com` を知ってアクセスしても、許可対象に含まれなければ **Cloudflare Access で拒否** される。
- Access で認証済みでも、後段の管理バックエンドは受け取ったユーザ識別子（例: メールアドレス）を監査ログに残す。

## 5. 同一VPSでの隔離

同一VPSを使うが、以下を必須とする。

1. 管理UI/管理APIは **公開アプリとは別プロセスまたは別コンテナ** で起動する。
2. 管理バックエンドは **公開APIと別ポート** を使う。
3. リバースプロキシは `Host: admin.and--line.com` のみを管理系 upstream へ転送する。
4. origin への直接アクセスは **Cloudflare からの到達に限定**する。可能であれば firewall / reverse proxy で Cloudflare 送信元以外を拒否する。
5. 公開アプリのデプロイ失敗や負荷増大が直ちに管理UIへ波及しないよう、プロセス監視・再起動単位を分離する。

別VPSは初期条件では不要とする。ただし、運用者増加・常用化・秘密情報分離の必要が強まった場合は別VPSへ移行する。

## 6. バックエンド境界

- 管理UIから PostgreSQL / PAY.JP / Discord API を **ブラウザから直接呼ばない**。
- 管理ブラウザは `admin.and--line.com` のフロントエンドにのみ接続し、以降の副作用は **管理用バックエンド** が実行する。
- 管理用バックエンドは既存の billing/sync/server のサーバー側ロジック、または `packages/sync-service/src/shell/cli.ts` と同等の整合ルールを再利用する。
- `inflight_operation_*`、`operationId`、fail-close、PAY.JP 書き込み後の整合確認など、既存ルールを破る独自ショートカットは追加しない。
- **無条件解除**、**状態未確認の再課金**、**状態未確認の cancel 再実行** は禁止する。

## 7. Phase A — read-only 仕様

Phase A は **読み取り専用** とし、副作用ボタンを持たない。

### 7.1 機能

- 会員一覧
- 会員検索
- 会員詳細
- 未解決影響 (`member_impact_logs.resolved_at IS NULL`) の確認
- `inflight_operation_*` 残留会員の確認
- 課金・ロール状態の最終同期時刻の確認

### 7.2 検索キー

- `member_id`
- `discord_user_id`
- メールアドレス
- `payjp_customer_id`
- `payjp_subscription_id`
- `subscription_status`
- `role_state`
- `inflight_operation_id`

### 7.3 表示対象

- 会員基本情報
- Discord 連携識別子
- 現在プラン
- 課金状態
- `access_end_at`
- `next_billing_at`
- `cancel_requested_at`
- `inflight_operation_*`
- 未解決影響件数
- 直近の PAY.JP / ロール同期関連時刻

### 7.4 制約

- Phase A では DB の正を表示する。外部APIへの on-demand 更新は必須にしない。
- CSV エクスポート、一括ダウンロード、一括操作は提供しない。

## 8. Phase B — 緊急操作仕様

Phase B は **限定対象・単一会員中心** とし、操作前に確認と監査を必須化する。

### 8.1 対象操作

1. `operationId` 指定の手動再同期
2. `discord_user_id` 指定の手動再同期
3. 単一会員の Discord ロール付与
4. 単一会員の Discord ロール剥奪
5. 単一会員の課金停止相当操作

`--all` 相当の全会員操作は **初期UIに含めない**。必要な場合は別 Change Request で明示する。

### 8.2 共通要件

- 破壊的操作の前に **理由入力** を必須とする。
- 実行前に **確認ダイアログ** を出し、対象会員・操作内容・注意事項を表示する。
- 操作結果は成功/失敗だけでなく、`operationId` や fail-close 判定の有無を画面で確認できるようにする。
- 課金停止や再同期は既存コア/CLIと **同一の安全条件** で実行する。
- `inflight_operation_*` の無条件解除ボタンは作らない。

### 8.3 ロール手動操作の注意

- ロール付与/剥奪は **Discord 側の緊急調整** として扱う。
- 会員状態の正は引き続き DB / PAY.JP / Webhook / 再同期であり、手動ロール操作は将来の再同期で上書きされ得る。
- UI はこの注意を表示し、必要に応じて再同期導線を併記する。

## 9. 監査・記録

Phase B の操作は、少なくとも以下を **永続化される監査ログ** として残す。

- `timestamp`
- `actor`（Cloudflare Access / IdP で識別されたユーザ）
- `action`
- `target_member_id`
- `target_discord_user_id`
- `reason`
- `result`
- `operationId`（該当時）
- 主要な before/after 要約

機密情報や raw header/body は保存しない。

## 10. 将来テスト計画

実装時は `docs/tdd-acceptance-matrix-mvp.md` に Post-MVP テストIDを追加する。最低限、以下を対象にする。

1. Cloudflare Access 未通過ユーザが origin に到達できないこと
2. 許可対象外ユーザが `admin.and--line.com` を開いても拒否されること
3. Phase A が read-only であること
4. Phase B の緊急操作が理由入力・監査ログ付きで動作すること
5. 緊急操作が既存 fail-close / `inflight_operation_*` ルールを破らないこと

## 11. 関連文書

- `docs/2weeks-spec.md` — §3 非スコープ、§15 将来拡張、Change Request **CR-005 / CR-006**
- `docs/implementation-design-mvp.md` — §9 将来拡張（管理画面）
- `docs/tdd-acceptance-matrix-mvp.md` — §6 Post-MVP（管理画面）
