# 本番前チェックリスト（PAY.JP / 公開サイト）

**目的**: PAY.JP 本番利用申請・Go-Live 前に、技術・運用・法務の観点で確認する。  
実施日と担当者を記入し、証跡は [docs/evidence/](../evidence/) に保存する。

**証跡の置き場（早見）**

| 区分 | 置き場 | テンプレート例 |
|------|--------|------------------|
| Git 管理可（要約・Pass-Fail） | [docs/evidence/](../evidence/) | [TEMPLATE.md](../evidence/TEMPLATE.md)、[TEMPLATE-pci-payment-page-review.md](../evidence/TEMPLATE-pci-payment-page-review.md) 等 |
| Git 管理外（スキャン全文・画面キャプチャ） | 社内ストレージ / 1Password | [TEMPLATE-mfa-check.md](../evidence/TEMPLATE-mfa-check.md) 参照 |

---

## 1. 公開 URL・閲覧性

- [ ] 申請する **本番 URL** が確定している（ダミー・ローカル専用 URL ではない）
- [ ] 審査員が **ログインなしで** 以下を閲覧できる
  - [ ] トップ（`/` マーケティング）および [サービス案内（料金・流れ）](../../frontend/service.html)（`/service`）
  - [ ] [特定商取引法に基づく表記](../../frontend/specified-commercial-transactions.html)（`/specified-commercial-transactions`。**運営者名・住所・問い合わせ先を本番値に更新済み**）
  - [ ] [プライバシーポリシー](../../frontend/privacy-policy.html)（`/privacy-policy`）
  - [ ] [利用規約](../../frontend/terms-of-service.html)（`/terms-of-service`。返金・キャンセル条項を統合）
  - [ ] 購読ページ [会員ページ / 購読 UI](../../frontend/member.html)（`/member`。PAY.JP SPA マウント）
  - [ ] 問い合わせ導線: `/` および `/service` 上の TimeRex 予約 CTA（旧 `/contact.html` は nginx 301 で `/member` に転送）
- [ ] フッターから各法的ページへ到達できる（`frontend/index.html` および `frontend/member.html` の `site-footer`）
- [ ] 法務ページの本番値一致を記録した（[TEMPLATE-legal-page-verification.md](../evidence/TEMPLATE-legal-page-verification.md)）

## 2. HTTPS / TLS

- [ ] 本番サイトが **HTTPS** で提供されている
- [ ] リバースプロキシ / CDN で **TLS 1.2 以上**（古いプロトコル無効化）
- [ ] `Strict-Transport-Security` 等のヘッダが意図どおり（API: [packages/server/src/app.ts](../../packages/server/src/app.ts)、静的: [nginx/security-headers.conf](../../nginx/security-headers.conf) — CF Pages 型 `_headers` ファイルは廃止、nginx が単一真実源）

## 3. 同一サイト（Cookie）

- [ ] フロントと API が **同一 eTLD+1** でユーザーブラウザから見える構成（`__Host-*` Cookie のため）。参照: [README.md](../../README.md) のデプロイ構成
- [ ] 本番 `FRONTEND_BASE_URL` と実際のオリジンが一致

## 4. PAY.JP ダッシュボード

- [ ] **本番**秘密鍵 / 公開鍵が本番環境に設定されている（`pk_live_` / `sk_live_`）
- [ ] **Webhook** URL・`PAYJP_WEBHOOK_TOKEN`・`PAYJP_LIVEMODE` が本番に合致
- [ ] プラン ID（`PAYJP_PLAN_IDS`）がダッシュボードと一致
- [ ] 管理アカウントの **メール認証** 済み、**MFA（TOTP）** 有効化（推奨どおり）

**証跡**: MFA の実確認は [TEMPLATE-mfa-check.md](../evidence/TEMPLATE-mfa-check.md)。詳細キャプチャはリポジトリ外。

## 5. 決済フロー（3DS・非保持）

- [ ] 実機またはステージングで **3DS `verified`** のみ課金されることを確認（モックではなくテストモード可）
- [ ] カード番号が自サーバに保存されない（PAY.JP.js + トークンのみ）
- [ ] 3DS `attempted` が来た場合に **422 で拒否**されることを確認（`packages/billing-service/src/core/index.ts` `isThreeDSecureVerified` — `=== 'verified'` の厳密比較）

**証跡**: [Day10 スモーク手順](./day10-smoke-test.md) §S3 に従い実施。結果を `docs/evidence/YYYYMMDD-day10-smoke.md` に記録。

**現状**: _未実施。Go-Live 前日〜当日朝に Day10 スモークで実施予定。_

## 6. 運用

- [ ] `DAILY_RESYNC_CRON` が本番で有効、直近の日次再同期成功ログを確認
- [ ] [手動再同期 CLI](./resync-cli.md) の実行手順を把握（[不確定 503 復旧フロー](./resync-cli.md#不確定-503-復旧フローt-p0-04) を含む）
- [ ] [手動ロール剥奪](./manual-role-revoke.md) の手順を把握
- [ ] [インシデント連絡先](./incident-contacts.md) が運用で共有されている
- [ ] [DB backup runbook](./backup-restore.md) の復元手順とキーローテーション計画を把握

**現状**: `DAILY_RESYNC_CRON` 本番値確認は Go-Live 当日に `sudo crontab -u payjp-ops -l` または `systemctl list-timers` で実施。

## 7. 法務・表記

- [ ] 特商法の **所在地・事業者名** が、登記・開業届・PAY.JP 登録と一致
- [ ] **お支払い方法** に、実際に提供する手段を列挙（本サービスはクレジットカード中心）

**現状**: 本番値への差し替えは `frontend/specified-commercial-transactions.html` で実施。`docs/evidence/2026-04-12-legal-page-verification.md` の更新版を Go-Live 前に発行予定。

## 8. PCI 補助（決済ページ・ASV・TPSP）

- [ ] 決済ページのスクリプト台帳・監視手順を確認した（[pci-payment-page-script-register.md](../compliance/pci-payment-page-script-register.md)、[pci-payment-page-monitoring.md](../compliance/pci-payment-page-monitoring.md)）
- [ ] ASV 方針・PAY.JP 問い合わせ記録欄を埋めた（[pci-asv-scan-policy.md](../compliance/pci-asv-scan-policy.md)、証跡 `docs/evidence/YYYYMMDD-asv-payjp-inquiry.md`）
- [ ] TPSP 規約・AOC 記録欄を更新した（[pci-tpsp-management.md](../compliance/pci-tpsp-management.md)。機密は社外保管）

---

**実施日**: ____年__月__日  
**実施者**: ________________  
**備考**:
