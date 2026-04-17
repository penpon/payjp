# インシデント連絡先（運用メモ）

本ファイルは **実メールアドレス・電話番号・APIキーをリポジトリに書かない** ための参照先だけを示す。実値は **1Password** または **PAY.JP / 各ベンダーの管理画面** で取得する。

| 用途 | 取得方法 |
|------|----------|
| PAY.JP サポート（決済・加盟店アカウント） | [PAY.JP](https://pay.jp/) にログインし、ダッシュボード内のサポート・お問い合わせ（表示URLをブックマーク）。緊急時は同画面の連絡手段に従う。 |
| ホスティング / VPS | 契約中プロバイダのサポートコンソール（契約書・請求メールに記載）。 |
| Cloudflare | Cloudflare ダッシュボード → Support |
| Discord（Bot / OAuth） | [Discord Developer Portal](https://discord.com/developers/applications) のサポート導線 |
| インシデント責任者（社内） | 1Password Vault に `Incident` 等の名前で連絡先を保管（電話・メール）。 |

**ユーザー向けの公開問い合わせ先**は `/` および `/service` 上の TimeRex 予約 CTA（[frontend/index.html](../../frontend/index.html) / [frontend/service.html](../../frontend/service.html) の `data-todo="timerex-url"`）と整合させる。旧 `/contact.html` 単独ページは廃止済（nginx 301 で `/member` へ転送）。
