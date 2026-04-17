# 決済ページ許可スクリプト台帳（Script register）

**目的**: 購読 UI（決済を含む）で読み込むスクリプトを列挙し、業務上の正当性と変更管理を明示する。  
**関連**: [pci-script-security-confirmation.md](pci-script-security-confirmation.md)、[pci-payment-page-monitoring.md](pci-payment-page-monitoring.md)

最終更新: 2026-04-12  
次回レビュー: 決済ページ `frontend/member.html` / バンドル読込に変更が入ったとき、または年次。

## スクリプト一覧

| # | リソース | 提供元 | 目的 | バージョン固定 | 変更管理 |
|---|----------|--------|------|------------------|----------|
| 1 | ビルド済みアプリ JS（`/assets/*.js` 等、Vite 出力） | 自サービス | OAuth・購読・課金 UI、PAY.JP トークン送信以外の業務ロジック | ファイル名にコンテンツハッシュ | Git、CI、本番デプロイ手順 |
| 2 | `https://js.pay.jp/v2/pay.js` | PAY.JP | iframe 内カード入力、トークン化、3DS 連携 | PAY.JP 側の配信（タグは v2 固定） | PAY.JP の配信・セキュリティに依存。改ざんリスクは [pci-script-security-confirmation.md](pci-script-security-confirmation.md) §2.2 および監視手順で補足 |

## 明示的に許可しないもの

- 広告・行動解析・タグマネージャ等の第三者スクリプト: **導入しない**
- 決済ページでの **Google Fonts 等の追加 CDN 読込**: **行わない**（[frontend/member.html](../../frontend/member.html)）

## CSP との対応

[nginx/security-headers.conf](../../nginx/security-headers.conf) の `script-src 'self' https://js.pay.jp` が、上記 1・2 のみを実行可能とする前提である（nginx 単一真実源。`_headers` ファイル方式は廃止）。
