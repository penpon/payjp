# 決済ページ・スクリプト整合レビュー証跡

（`TEMPLATE-pci-payment-page-review.md` から作成。本番 URL 確定後に実施。）

- 実施日: 2026-04-12（記録枠の作成）
- 実施者: （未記入）
- 対象 URL: （本番購読 UI のトップ URL）

## 確認項目

- [ ] [frontend/index.html](../../frontend/index.html) に `<script src="https://js.pay.jp/v2/pay.js">` および自前バンドルのみがある（追加の第三者スクリプトなし）
- [ ] [pci-payment-page-script-register.md](../pci-payment-page-script-register.md) の台帳と一致
- [ ] [frontend/public/_headers](../../frontend/public/_headers) の CSP が意図どおり（`script-src` に `js.pay.jp` のみ）
- [ ] 本番で `curl -I` またはブラウザ DevTools で同一 CSP が見える（配信経路が nginx の場合は [nginx/security-headers.conf](../../nginx/security-headers.conf) も確認）

## 結果

- [ ] 問題なし
- [ ] 要フォロー（内容）: _______________

## 証跡

- （スクリーンショット・コマンド出力は社内ストレージに置き、ここにはパス要約のみ）
