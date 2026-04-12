# PAY.JP 審査向け説明メモ（B2B・支払後 Discord・3DS・カード非保持）

**目的**: 本番利用申請・審査時に、実装に基づき「何を」「どう安全に」「どう解約するか」を短く説明する。  
**正本仕様**: [2weeks-spec.md](2weeks-spec.md)、[implementation-design-mvp.md](implementation-design-mvp.md)。本メモはコード参照を付した要約である。

## 0. 商材・対象（B2B）

- **商材**: 法人向け **SES コミュニティ参加権**（Discord 上の限定コミュニティへのアクセス・プランに応じたロール付与）。
- **対象**: 日本国内の**法人**（決済・契約は法人名義を想定）。
- **明示的非対象**: **案件紹介・職業斡旋・求人仲介そのものの対価ではない**（公開ページ [frontend/public/service.html](../frontend/public/service.html) と整合）。

## 1. カード非保持（PAN 非送信）

- **フロント**: PAY.JP 公式 `pay.js`（[frontend/index.html](../frontend/index.html)）により決済フォームを表示。カード番号は **PAY.JP へ直接** 送信され、当社アプリケーションサーバには **カード番号・有効期限・セキュリティコードを保存しない**。
- **送信**: サーバへ送るのは PAY.JP が発行した **トークン** に限る（[frontend/src/billing-ui.ts](../frontend/src/billing-ui.ts)、API 側 [packages/server/src/routes/billing.routes.ts](../packages/server/src/routes/billing.routes.ts)）。
- **個人情報**: [frontend/public/privacy.html](../frontend/public/privacy.html) には、リポジトリ同梱の **SES 向けプライバシーポリシー**（[SES向けプライバシーポリシー及び個人情報の利用目的について.pdf](../SES向けプライバシーポリシー及び個人情報の利用目的について.pdf)）と**同一の条項本文**を掲載している。決済情報は決済代行会社の取扱いとしカード番号等の詳細は当社が保持しない旨、取得・利用目的、第三者提供の制限、安全管理措置、お問い合わせ窓口を含む。**商材説明**（コミュニティ参加権中心）は [service.html](../frontend/public/service.html) と併せて参照する（プライバシー面の条項は PDF 準拠ページを正とする）。

## 2. 3D セキュア（本人認証）

- **ポリシー**: 課金・購読作成は **3DS 結果が `verified`** の場合に限る（ビジネスロジック [packages/billing-service/src/core/index.ts](../packages/billing-service/src/core/index.ts) の判定）。
- **購読オーケストレーション**: [packages/billing-service/src/shell/subscribe.ts](../packages/billing-service/src/shell/subscribe.ts) において、PAY.JP への書き込み前に **`operationId` を永続化**し、不確定失敗時は **503 + `operationId`** で返す（再試行・手動確認のため）。確定失敗時は inflight を解除する。

## 3. 支払い後の Discord 連携（`guilds.join`）

- **順序**: **課金完了 → `__Host-member_session` → Discord OAuth（`identify` + `guilds.join`）→ `POST /v1/members/link-discord`** で自動参加・ロール付与（[packages/server/src/routes/member.routes.ts](../packages/server/src/routes/member.routes.ts)）。
- **課金 API**: `POST /v1/subscriptions` は **メール起点**で、課金前に Discord ギルド参加を要求しない（CR-009）。

## 4. 解約（定期課金停止）フロー

- **利用者操作**: ログイン後、購読 UI から **Google フォーム URL を取得**（[frontend/src/main.ts](../frontend/src/main.ts) → `createCancelFormLink`）。フォーム送信後、バックエンドが退会処理を反映するまで **ポーリング** する実装あり。
- **サーバ API**: `POST /v1/subscriptions/cancel/google-form-link` および `POST /v1/subscriptions/cancel` / `google-submit`（仕様 [2weeks-spec.md](2weeks-spec.md)）。PAY.JP cancel 前に **`operationId` 記録**（曖昧失敗時の運用は仕様どおり）。
- **利用期間**: 退会後も **当該請求期間の終了日（`current_period_end` / 画面上の `accessEndAt`）まで** 役務・ロールを維持し、**次回請求は発生しない**（[frontend/public/refund.html](../frontend/public/refund.html) と整合）。

## 5. 統合サーバ（HTTP / CORS / Cookie）

- API の組み立て・CORS・資格情報付き Cookie は [packages/server/src/main.ts](../packages/server/src/main.ts) 経由で [buildApp](../packages/server/src/app.ts) に委譲。フロントは **`FRONTEND_BASE_URL` 同一サイト** 前提で `__Host-*` Cookie を利用（詳細は [.claude/rules/security.md](../.claude/rules/security.md)）。

## 6. 審査員向け公開ページ

- **ログイン不要**: [frontend/public/service.html](../frontend/public/service.html) で商材・税込月額（20,000 / 50,000 / 70,000 円）・申込〜解約の流れを静的に提示。
- **トップ**: [frontend/index.html](../frontend/index.html) に **サービス案内・法務リンク** を常時表示。

## 7. 提出用セット（別紙として用意）

| 資料 | 内容 |
|------|------|
| **料金表兼サービス概要** | 1〜2 ページ。3 プラン金額、法人向け、支払後 Discord 招待、トライアル条件、解約は `current_period_end` まで利用 |
| **Discord 画面キャプチャ** | 審査員向け：チャンネル構成・参加権の説明が分かるスクリーンショット（個人を特定しないようマスク） |
| **非仲介メモ** | 「コミュニティ参加権の提供であり、職業斡旋・求人仲介の対価ではない」旨の一文 |

---

申請時は、上記 URL の **本番確定オリジン** でリンク切れなく開けること、および [TEMPLATE-legal-page-verification.md](evidence/TEMPLATE-legal-page-verification.md) の記載と **事業者情報が一致** すること、**`privacy.html` の本文が SES 向け PDF と一致**していることを最終確認する。
