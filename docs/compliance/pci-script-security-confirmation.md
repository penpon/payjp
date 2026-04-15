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
  style-src 'self';
  font-src 'self';
  connect-src 'self' https://api.pay.jp;
  frame-src https://js.pay.jp;
  frame-ancestors 'none';
  base-uri 'none';
  object-src 'none';
  form-action 'self';
  img-src 'self' data:
```

スタイルは Vite ビルドで出力される **外部 CSS**（`frontend/dist/assets/index-*.css`）のみを読み込み、`index.html` および法務系静的ページに **インライン `<style>` は置かない**。実体は [frontend/public/_headers](../../frontend/public/_headers) および [nginx/security-headers.conf](../../nginx/security-headers.conf) と一致させる。整合は CI で [`scripts/dev/check-payment-page-security.ts`](../../scripts/dev/check-payment-page-security.ts) が検証する。

**効果:**
- `script-src 'self' https://js.pay.jp` — 許可されたドメイン以外のスクリプト実行をブロック
- `frame-src https://js.pay.jp` — iframeの差し替え攻撃を防止
- `frame-ancestors 'none'` — 当該レスポンスのフレーム埋め込みを禁止（`X-Frame-Options: DENY` と併用）
- `base-uri 'none'` / `object-src 'none'` — base タグ・object/embed の悪用を抑制
- `form-action 'self'` — フォーム送信先を同一オリジンに制限（静的ページのフォームがない場合も将来の誤追加を抑制）
- `connect-src 'self' https://api.pay.jp` — 外部へのデータ送信を制限（本番 API オリジンに合わせる）
- `style-src 'self'` — スタイルは自オリジンの CSS のみ（インライン**スクリプト**は `script-src` で**許可していない**）
- `font-src 'self'` — 外部フォント CDN をサイトから排除

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

**制御境界の明示:**

- 許可するスクリプトは上記 **2つのみ**。CSP の `script-src` は `'self'` と `https://js.pay.jp` のみを許可する。
- `pay.js` は **SRI を付与できない**（PAY.JP が整合性ハッシュを公開していない）。残存リスクは [pci-payment-page-monitoring.md](pci-payment-page-monitoring.md) の補償的統制（変更検知・レビュー）で説明する。
- バックエンド JSON API（別ホスト想定）のレスポンスヘッダは [packages/server/src/app.ts](../../packages/server/src/app.ts) で `default-src 'none'` 等としており、**購読 UI の HTML とは別オリジン・別ポリシー**である。

第三者スクリプト（広告・アナリティクス・タグマネージャ等）: **なし**  
（過去に使用していた Web フォント用の第三者読込は削除済み。）

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
- `pay.js` のSRI未対応（PAY.JPがハッシュを公開した場合に対応予定）。独自のハッシュを捏造しない。
- ブラウザからの **CSP 違反レポート自動集約**は未実装。手動レビュー・運用手順は [pci-payment-page-monitoring.md](pci-payment-page-monitoring.md) を参照。

**結論: SAQ A v4.0.1 r1 の適格基準を満たす。**
