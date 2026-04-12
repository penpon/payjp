# 手動再同期 CLI 手順

## 目的

- PAY.JP / DB / Discord の状態を突き合わせ、`members` とロールを整合させる。
- `503` や不確定失敗後に残った `inflight_operation_*` を、**PAY.JP現状態の確認後にのみ**解除する（仕様: [2weeks-spec.md](../2weeks-spec.md) §10）。

## 前提

- 本番または対象環境の **環境変数** が揃っていること（`DATABASE_URL`, `PAYJP_SECRET_KEY`, `PAYJP_LIVEMODE`, `PAYJP_PLAN_IDS`, `DISCORD_PLAN_ROLE_IDS`, `DISCORD_GUILD_ID`, `DISCORD_BOT_TOKEN`, `PAYJP_PLAN_INITIAL_CHARGE_AMOUNTS`）。
- シークレットは **1Password / `op run`** で注入（`.env` をリポジトリに含めない）。

## 実行方法

リポジトリルートから:

```bash
npm run resync -- --operation-id <operationId>
```

または:

```bash
npm run resync -- --discord-user-id <discord_user_id>
```

全会員:

```bash
npm run resync -- --all
```

実体は [packages/server/src/resync-cli.ts](../../packages/server/src/resync-cli.ts)（`tsx src/resync-cli.ts`）。

## 引数のルール

- `--operation-id` / `--discord-user-id` / `--all` は **相互排他**（同時に指定しない）。
- 標準出力に **JSON**（`mode`, `target`, `processed_count`, `succeeded_count`, `failed_count`, `started_at`, `finished_at`, `duration_ms` 等）が出る（CLI は整形出力）。終了コードは `0` / `1` / `2`（仕様準拠）。

## 6時間超の確定不能時（エスカレーション）

`members.inflight_operation_*` が長時間残存し、CLIでも整合が取れない場合:

1. **解除可否**を判断（無条件解除は禁止）。
2. **担当者・実施時刻**を記録。
3. [incident-contacts.md](./incident-contacts.md) に従い PAY.JP / 社内エスカレーションへ連絡。

詳細は [implementation-design-mvp.md](../implementation-design-mvp.md) の再同期・CLI 節を参照。

## 証跡

実行結果JSONの要約を [docs/evidence/](../evidence/) に保存する（例: `YYYYMMDD-cli-recovery-rehearsal.md`）。
