# 受け入れ証跡（Go-Live / T-P0）

本ディレクトリには、[tdd-acceptance-matrix-mvp.md](../tdd-acceptance-matrix-mvp.md) §5 および [2weeks-spec.md](../2weeks-spec.md) §14 に従い、手動・CI の証跡を保存する。

## 命名規則

```
YYYYMMDD-<testid>.md
```

例: `20260416-T-P0-02.md`（2026年4月16日に `T-P0-02` を実施した記録）

## テンプレート

[TEMPLATE.md](./TEMPLATE.md) をコピーして、該当する `<testid>` のファイル名で保存する。

## 推奨ファイル（Go-Live 前に作成）

| 種別 | ファイル名の例 | 備考 |
|------|----------------|------|
| T-P0 各項 | `YYYYMMDD-T-P0-01.md` … `T-P0-07.md` | Vitest/Playwright のログまたはコマンド出力を添付 |
| Day10 本番スモーク | `YYYYMMDD-day10-smoke.md` | OAuth→登録→退会、Webhook livemode 等 |
| 503 復旧 CLI リハーサル | `YYYYMMDD-cli-recovery-rehearsal.md` | `npm run resync -- --operation-id …` の結果JSON |
| cancel 事前検証 | `YYYYMMDD-cancel-precheck.md` | 受付期間内テストユーザーでの検証 |
| ASV / PAY.JP 問い合わせ | `YYYYMMDD-asv-payjp-inquiry.md` | [pci-asv-scan-policy.md](../pci-asv-scan-policy.md) の記録用 |

**機密**（APIキー、生ログのトークン、個人情報）は **リポジトリに含めない**。要約とファイルパス（社内ストレージ）で代替する。
