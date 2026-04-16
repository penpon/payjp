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

## 不確定 503 復旧フロー（T-P0-04）

`POST /v1/subscriptions` または `POST /v1/subscriptions/cancel` が `503 + operationId` を返した直後の標準手順。**クライアント自動再試行は禁止**（`.claude/rules/security.md`）、必ず本 CLI でオペレーターが状態確認してから進める。

### 1. 検出

以下のいずれかで「不確定 503」と判定する：

- ブラウザ DevTools で API レスポンス `503` + body に `{"operationId": "<uuid>"}`
- nginx access log: `grep ' 503 ' /var/log/nginx/access.log | grep -E '/v1/subscriptions(/cancel)?'`
- Discord `#payjp-ops-alerts` の `HTTP_5XX_SPIKE`（発火時）

### 2. operationId の確認

ユーザーから `operationId`（レスポンスに含まれる UUID）を回収する。不明なら DB で逆引き：

```bash
# member 単位で inflight 状態を確認（PGPASSWORD は op read 経由）
op run --env-file=.env -- docker compose exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT id, email, inflight_operation_id, inflight_operation_type, inflight_operation_started_at
   FROM members WHERE inflight_operation_id IS NOT NULL ORDER BY inflight_operation_started_at DESC LIMIT 20;"
```

### 3. CLI 引数決定

| 状況 | 推奨引数 | 挙動 |
|---|---|---|
| `operationId` 判明、単一復旧 | `--operation-id <uuid>` | 当該 op のみ再同期・PAY.JP 状態整合 |
| Discord ユーザー単位 | `--discord-user-id <id>` | member 単位で inflight 解消 + ロール整合 |
| 全体 drift が疑わしい（例: VPS 復旧後） | `--all` | 全会員 sweep（時間を要する） |

**排他ルール**: 3 引数のうち 1 つのみ指定。複数指定は CLI が拒否（exit 2）。

```bash
npm run resync -- --operation-id <operationId>
```

### 4. 期待動作

成功時の JSON 標準出力（抜粋）：

```json
{
  "mode": "operation_id",
  "target": "<uuid>",
  "processed_count": 1,
  "succeeded_count": 1,
  "failed_count": 0,
  "started_at": "2026-04-20T03:00:00.000Z",
  "finished_at": "2026-04-20T03:00:04.123Z",
  "duration_ms": 4123
}
```

- `succeeded_count == processed_count` なら `inflight_operation_*` が解除済み、PAY.JP ↔ DB ↔ Discord が整合
- exit code `0` = 全件成功、`2` = 実行完了だが `failed_count > 0`（JSON の `failed_count` 参照）、`1` = CLI 実行エラー（入力不正／依存障害）

### 5. 失敗時分岐

| `failed_count > 0` の原因候補 | 次手 |
|---|---|
| PAY.JP API 429 / 5xx | 数分待機後に同じ引数で再実行。3 回連続失敗なら PAY.JP status を確認し incident 起票 |
| Discord API 429 / 5xx | `--discord-user-id` で単一 member を対象に再実行（PAY.JP はすでに確定済のはず） |
| `inflight_operation_started_at` が 6 時間超 | 本ページ上部「6時間超の確定不能時」エスカレーション手順へ |
| JSON が出ず `Error:` 出力 | 環境変数不足の可能性。`op run --env-file=.env -- env` で `DATABASE_URL` 等存在確認（値は表示しない） |

### 6. 証跡保存

成功/失敗いずれも、JSON 出力の要約を `docs/evidence/YYYYMMDD-cli-recovery.md` に保存（コマンド、exit code、`processed_count` / `failed_count`、所要時間、対応者）。

## 証跡

実行結果JSONの要約を [docs/evidence/](../evidence/) に保存する（例: `YYYYMMDD-cli-recovery-rehearsal.md`）。
