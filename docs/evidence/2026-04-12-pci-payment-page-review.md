# 決済ページ・スクリプト整合レビュー証跡

（`TEMPLATE-pci-payment-page-review.md` から作成。本番 URL 確定後に実施。）

- 実施日: 2026-04-12（記録枠の作成）
- 実施者: （未記入）
- 対象 URL: （本番購読 UI `/member` の URL）

## 確認項目

- [ ] [frontend/member.html](../../frontend/member.html)（`/member`）に `<script src="https://js.pay.jp/v2/pay.js">` および自前バンドルのみがある（追加の第三者スクリプトなし）
- [ ] [pci-payment-page-script-register.md](../compliance/pci-payment-page-script-register.md) の台帳と一致
- [ ] [nginx/security-headers.conf](../../nginx/security-headers.conf) の CSP が意図どおり（`script-src` に `js.pay.jp` のみ、nginx 単一真実源）
- [ ] 本番で `curl -I https://…/member` またはブラウザ DevTools で nginx と同一 CSP が見える

## 結果

- [ ] 問題なし
- [ ] 要フォロー（内容）: _______________

## 証跡

- （スクリーンショット・コマンド出力は社内ストレージに置き、ここにはパス要約のみ）
