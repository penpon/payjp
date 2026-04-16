# Day10 スモークテスト（本番 Go-Live 前）

PAY.JP 本番申請合格後、本番環境で実施する最終確認。自動化せず**手動で各手順のスクリーンショット・ログを evidence に保存する**。

- 実施タイミング: Go-Live 前日〜当日朝
- 所要時間: 約 60 分
- 前提: `production-readiness-checklist.md` の §1〜§8 全項目 PASS 済

---

## 準備

1. **テスト用 Discord アカウント**（本番 guild 外）と **個人メールアドレス**（PAY.JP に未登録）を用意
2. **PAY.JP 本番ダッシュボード**にログインし、リアルタイムにイベントを確認できる状態
3. **実カード**（少額決済可能なもの）。終了後に返金する前提
4. 対象ブラウザ（Chrome / Safari）の DevTools を開き、Network / Console タブを表示

## スモーク項目

### S1. サイト公開性・法的ページ到達性（5分）

- [ ] トップ（購読 UI）が HTTPS で閲覧可、Cookie に `Domain` 属性なし（DevTools → Application → Cookies）
- [ ] フッターから以下全ページにログインなしで到達：特商法表記 / プライバシー / 利用規約 / 返金・キャンセル / お問い合わせ / サービス案内
- [ ] 特商法表記の運営者名・住所・問い合わせ先が **本番値**（ダミーではない）

### S2. Discord OAuth（R1 / T-P0-01）（10分）

- [ ] トップから「Discord で認証」押下 → `https://discord.com/api/oauth2/authorize` 遷移、`scope=identify` のみ
- [ ] 認可完了後、アプリ側に戻る。302 Location の URL に OAuth token / link token が **含まれない**こと（DevTools → Network → Response Location を目視）
- [ ] Set-Cookie `__Host-link_session` 属性: `Secure` / `HttpOnly` / `SameSite=Lax` / `Path=/` / Domain なし / `Max-Age=900`
- [ ] `GET /v1/auth/discord/session` が 200、JSON が期待通り（`discord_user_id` / `email=null` 等）

### S3. 購読開始 + 3DS verified（R2-R4 / T-P0-02）（15分）

- [ ] 3 プラン中 1 つを選択、PAY.JP.js でカードを入力、3DS チャレンジ完了
- [ ] 完了後 `POST /v1/subscriptions` が 200、レスポンスに `operationId` なし（成功時）
- [ ] PAY.JP ダッシュボード → 定期課金: 新規 subscription が `active`、`metadata.member_id` / `metadata.operation_id` が set
- [ ] Discord: テストアカウントが **該当プランのロール**のみ付与されている
- [ ] DB（op run 経由）: `members.inflight_operation_*` が NULL、`subscription_status='trial'` or `'active'`

**失敗テスト（同じ枠で実施）**: 3DS 未対応カードで **`attempted`** を発生させ、`POST /v1/subscriptions` が 422 で拒否されることを確認

### S4. Webhook 受信（R6 / T-P0-07）（10分）

- [ ] PAY.JP ダッシュボード → Webhook ログ: S3 で発生した `subscription.created` / `charge.succeeded` が 200 応答
- [ ] DB `payjp_events` テーブル: 同 event が insert、`signature_ok=true`
- [ ] **token 不一致テスト**（staging またはテストモードで）: 意図的に無効 token を付けた webhook を送信し、**401 / 403 返却 + `payjp_events` 非保存**（監査ログは分離ログに残る）

### S5. 退会フロー（R5 / T-P0-05）（15分）

- [ ] トップで「退会する」押下 → Google Form にリダイレクト、URL の `entry.*` にメール/トークン事前入力済
- [ ] Form 送信 → Apps Script から `POST /v1/subscriptions/cancel/google-submit` が 200（Apps Script 実行ログ）
- [ ] アプリに `?cancel=submitted` で戻る → 「退会済み」表示、購読状況が `canceled`
- [ ] Discord: テストアカウントからロールが **剥奪されている**
- [ ] DB: `subscription_status='canceled'`、`cancel_form_token_consumed_at` が set
- [ ] `token_consumed_at` が set されている時に同 token で再送 → **409 or idempotent 200**（冪等性確認）

### S6. ロール再付与抑制（T-P0-06）（5分）

- [ ] S5 退会済みユーザーに対し Discord 側で手動ロール剥奪を発生させ、次回 `daily-resync` 実行時に **再付与されない**ことを確認（`canceled` + `access_end_at` 経過済みの場合）

---

## 合否判定

- **全項目 ✓**: Go-Live 実施可
- **1 項目でも ✗**: Go-Live 判断を保留。原因を切り分け、`docs/evidence/YYYYMMDD-smoke-fail.md` に起票

## 証跡保存

- 実施日時 / 実施者 / 各項目の結果（スクリーンショット or ログ抜粋）を `docs/evidence/YYYYMMDD-day10-smoke.md` にまとめる
- PAY.JP / Discord / DB のキャプチャは **PII マスク済み**版のみコミット。raw キャプチャは 1Password / 社内ストレージ

## 関連

- `docs/tdd-acceptance-matrix-mvp.md` T-P0-01〜07
- `docs/ops/production-readiness-checklist.md`
- `docs/ops/resync-cli.md`（不確定 503 復旧フロー）
