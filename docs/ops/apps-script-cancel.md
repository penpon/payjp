# Apps Script 退会 submit（`POST /v1/subscriptions/cancel/google-submit`）実装手順

`docs/2weeks-spec.md` CR-013 で追加された `X-Cancel-Signature` HMAC 署名を Apps Script 側で生成する手順。

## 前提

- スクリプト プロパティ（`PropertiesService.getScriptProperties()`）に `GOOGLE_FORM_CANCEL_SECRET` を設定済み（サーバー側 `.env` の同名値と一致）。
- Google Form の `onFormSubmit` トリガーから呼ばれる関数内で実装する。

## 署名対象（canonical form）

```
${normalizedEmail}\n${token}
```

- `normalizedEmail`: `email.trim().toLowerCase()`（サーバー側 `normalizeEmail` と同一）。
- `token`: Google Form の prefill で渡された署名付きトークン（改行なし）。
- 改行は `\n`（LF）。`\r\n` 禁止。
- name / reason は **署名対象外**（Apps Script 実行ログに平文で残るため）。

## 実装例（Apps Script / V8）

```javascript
function submitCancelToServer(email, name, reason, token) {
  const secret = PropertiesService.getScriptProperties().getProperty('GOOGLE_FORM_CANCEL_SECRET');
  if (!secret) throw new Error('GOOGLE_FORM_CANCEL_SECRET is not set');

  const normalizedEmail = String(email).trim().toLowerCase();
  const canonical = normalizedEmail + '\n' + token;

  // HMAC-SHA256(secret, canonical) → hex
  const rawSig = Utilities.computeHmacSha256Signature(canonical, secret);
  const signature = rawSig
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');

  // ⚠️ セキュリティ警告: X-Cancel-Secret の値を Logger.log() や console.log() で
  // 出力しないこと。GAS の実行ログ（Apps Script ダッシュボード）に平文記録される。
  const response = UrlFetchApp.fetch('https://api.and--line.com/v1/subscriptions/cancel/google-submit', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'X-Cancel-Secret': secret,
      'X-Cancel-Signature': signature,
    },
    payload: JSON.stringify({ email: email, name: name, reason: reason, token: token }),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Cancel submit failed: HTTP ' + code + ' ' + response.getContentText());
  }
  return JSON.parse(response.getContentText());
}
```

## セキュリティ注意事項

- `X-Cancel-Secret` の値を `Logger.log()` や `console.log()` で出力しないこと。Apps Script ダッシュボードの実行ログに平文記録され、ダッシュボードにアクセスできる全員が閲覧できる。
- すでにログ出力した場合は、直ちに `GOOGLE_FORM_CANCEL_SECRET` をローテートし、サーバー側 `.env` と Script Properties を同時に更新すること。

## デプロイ手順

1. Apps Script エディタで本ファイルの内容を反映。
2. `PropertiesService` に `GOOGLE_FORM_CANCEL_SECRET` が設定されていることを確認。
3. **サーバー側デプロイと同時**に公開（CR-013 はサーバーで `X-Cancel-Signature` 必須化するため、先にサーバーだけデプロイすると退会が `401 INVALID_CANCEL_SIGNATURE` で全件失敗する）。
4. テスト送信を 1 件実施し、サーバー側ログで `INVALID_CANCEL_SIGNATURE` が出ていないこと・`200 OK` が返ることを確認。

## 失敗時の切り分け

| 症状 | 原因候補 |
|---|---|
| `401 INVALID_GOOGLE_SECRET` | `X-Cancel-Secret` がサーバー側と不一致。スクリプト プロパティと `.env` の照合。 |
| `401 INVALID_CANCEL_SIGNATURE` | HMAC 計算方法が一致していない。`\n` が `\r\n` になっていないか、`normalizeEmail` の実装（lowercase + trim）漏れを確認。 |
| `401 TOKEN_EMAIL_MISMATCH` | Form submit の `email` が prefill 時の値と異なる（ユーザが Form 上で書き換えた）。`token` 再発行を案内。 |
| `401 INVALID_CANCEL_FORM_TOKEN` / `EXPIRED_CANCEL_FORM_TOKEN` / `CONSUMED_CANCEL_FORM_TOKEN` | `token` が期限切れ / 使用済み / 不正。再度 Google Form URL を生成する導線を案内。 |
