# スクリプト攻撃非脆弱性の確認 — SAQ A v4.0.1 r1 適格基準

SAQ A v4.0.1 r1（2025年1月）の適格基準:
> "The merchant has confirmed that their site is not susceptible to attacks from scripts that could affect the merchant's e-commerce system(s)."

本文書は上記基準への適合を確認するものである。

最終確認日: 2026-04-09  
確認者: penpon  
次回確認: 2027-04-09（年次、またはフロントエンド変更時）

## 1. 決済ページの構成

- 決済フォームURL: `https://www.and--line.com/`（SPA、購読フロー内）
- カード入力: PAY.JP.js v2（`https://js.pay.jp/v2/pay.js`）による**iframe**
- カード入力フィールドはPAY.JPドメインのiframe内で描画され、本サービスのJavaScriptからアクセス不可

## 2. 実装済みの保護措置

### 2.1 Content Security Policy（CSP）

nginx (`security-headers.conf`) および Cloudflare Pages (`_headers`) で適用:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' https://js.pay.jp;
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  connect-src 'self' https://api.pay.jp;
  frame-src https://js.pay.jp;
  img-src 'self' data:
```

**効果:**
- `script-src 'self' https://js.pay.jp` — 許可されたドメイン以外のスクリプト実行をブロック
- `frame-src https://js.pay.jp` — iframeの差し替え攻撃を防止
- `connect-src 'self' https://api.pay.jp` — 外部へのデータ送信を制限
- インラインスクリプト（`'unsafe-inline'`）はscript-srcで**許可していない**

### 2.2 Subresource Integrity（SRI）

| リソース | SRI | 状態 |
|---|---|---|
| `https://js.pay.jp/v2/pay.js` | なし | **未対応** — PAY.JPがハッシュを公開していないため適用不可 |
| 自サイトのJS（Vite ビルド） | ファイル名にハッシュ含む | ビルド時にハッシュ付きファイル名で生成（キャッシュバスティング） |

### 2.3 その他のセキュリティヘッダー

| ヘッダー | 値 | 効果 |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | HTTPS強制（2年） |
| `X-Frame-Options` | `DENY` | クリックジャッキング防止 |
| `X-Content-Type-Options` | `nosniff` | MIMEスニッフィング防止 |

### 2.4 TLS構成

- TLSv1.2 / TLSv1.3のみ（SSL/TLSv1.0/1.1は無効）
- ECDHE鍵交換（前方秘匿性）
- OCSPステープリング有効

## 3. 決済ページのスクリプト一覧

| スクリプト | 提供元 | 目的 | 変更管理 |
|---|---|---|---|
| `/src/main.ts`（ビルド済み） | 自サービス | SPA アプリケーション | Git + CI/CD |
| `https://js.pay.jp/v2/pay.js` | PAY.JP | カード入力iframe + トークン化 | PAY.JP管理（バージョン固定なし） |

第三者スクリプト（広告・アナリティクス等）: **なし**

## 4. リスク評価

| 攻撃ベクター | 対策 | 残存リスク |
|---|---|---|
| 悪意あるスクリプトの注入 | CSP `script-src` でブロック | 低: 許可ドメインの侵害時のみ |
| PAY.JP iframe の差し替え | CSP `frame-src` でブロック | 低 |
| 自サイトJS の改ざん | Git管理 + CI/CD + Cloudflare CDN | 低: サーバー侵害時のみ |
| `pay.js` の改ざん | PAY.JP側のセキュリティに依存 | 中: SRI未適用のため、PAY.JP CDN侵害時にリスクあり |
| XSSによるデータ窃取 | CSP + `connect-src` 制限 | 低 |

## 5. 確認結果

上記の保護措置により、本サイトはスクリプト攻撃に対して適切に保護されていることを確認する。

**残存課題:**
- `pay.js` のSRI未対応（PAY.JPがハッシュを公開した場合に対応予定）
- `style-src 'unsafe-inline'` の将来的な除去検討

**結論: SAQ A v4.0.1 r1 の適格基準を満たす。**
