# 本番前チェックリスト（PAY.JP / 公開サイト）

**目的**: PAY.JP 本番利用申請・Go-Live 前に、技術・運用・法務の観点で確認する。  
実施日と担当者を記入し、証跡は [docs/evidence/](../evidence/) に保存する。

---

## 1. 公開 URL・閲覧性

- [ ] 申請する **本番 URL** が確定している（ダミー・ローカル専用 URL ではない）
- [ ] 審査員が **ログインなしで** 以下を閲覧できる
  - [ ] トップ（購読 UI）
  - [ ] [特定商取引法に基づく表記](../../frontend/public/tokushou.html)（**運営者名・住所・問い合わせ先を本番値に更新済み**）
  - [ ] [プライバシーポリシー](../../frontend/public/privacy.html)
  - [ ] [利用規約](../../frontend/public/terms.html)
  - [ ] [返金・キャンセル](../../frontend/public/refund.html)
  - [ ] [お問い合わせ](../../frontend/public/contact.html)
- [ ] フッターから各法的ページへ到達できる（`frontend/index.html` の `site-footer`）

## 2. HTTPS / TLS

- [ ] 本番サイトが **HTTPS** で提供されている
- [ ] リバースプロキシ / CDN で **TLS 1.2 以上**（古いプロトコル無効化）
- [ ] `Strict-Transport-Security` 等のヘッダが意図どおり（API: [packages/server/src/app.ts](../../packages/server/src/app.ts)、静的: [frontend/public/_headers](../../frontend/public/_headers)）

## 3. 同一サイト（Cookie）

- [ ] フロントと API が **同一 eTLD+1** でユーザーブラウザから見える構成（`__Host-*` Cookie のため）。参照: [README.md](../../README.md) のデプロイ構成
- [ ] 本番 `FRONTEND_BASE_URL` と実際のオリジンが一致

## 4. PAY.JP ダッシュボード

- [ ] **本番**秘密鍵 / 公開鍵が本番環境に設定されている（`pk_live_` / `sk_live_`）
- [ ] **Webhook** URL・`PAYJP_WEBHOOK_TOKEN`・`PAYJP_LIVEMODE` が本番に合致
- [ ] プラン ID（`PAYJP_PLAN_IDS`）がダッシュボードと一致
- [ ] 管理アカウントの **メール認証** 済み、**MFA（TOTP）** 有効化（推奨どおり）

## 5. 決済フロー（3DS・非保持）

- [ ] 実機またはステージングで **3DS `verified`** のみ課金されることを確認（モックではなくテストモード可）
- [ ] カード番号が自サーバに保存されない（PAY.JP.js + トークンのみ）

## 6. 運用

- [ ] `DAILY_RESYNC_CRON` が本番で有効、直近の日次再同期成功ログを確認
- [ ] [手動再同期 CLI](./resync-cli.md) の実行手順を把握
- [ ] [手動ロール剥奪](./manual-role-revoke.md) の手順を把握
- [ ] [インシデント連絡先](./incident-contacts.md) が運用で共有されている

## 7. 法務・表記

- [ ] 特商法の **所在地・事業者名** が、登記・開業届・PAY.JP 登録と一致
- [ ] **お支払い方法** に、実際に提供する手段を列挙（本サービスはクレジットカード中心）

---

**実施日**: ____年__月__日  
**実施者**: ________________  
**備考**:
