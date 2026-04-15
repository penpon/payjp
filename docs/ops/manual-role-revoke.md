# 手動ロール剥奪手順（Discord）

## 目的

Webhook・日次再同期・手動再同期CLIでも **Discord API の一時障害等**によりロール剥奪が完了しない場合に、**Bot トークンを用いて手動でロールを削除**し、会員状態と整合させる。

## 前提

- `DISCORD_BOT_TOKEN` が有効であること。
- Bot が対象ギルドで **Manage Roles** を持ち、対象ロールより **上の位置** にあること（仕様どおり）。
- 対象ユーザーの `discord_user_id` と、剥奪する `role_id`（プランに応じた有料ロール）を特定していること。

## 手順（REST API）

1. Discord Developer Portal で Bot がギルドに参加していることを確認する。
2. 以下のエンドポイントで **DELETE**（`@discordjs/rest` と同等）:
   - `DELETE /guilds/{guild.id}/members/{user.id}/roles/{role.id}`
3. 成功時は `204`。失敗時はステータスとボディを記録し、再試行または [resync-cli](./resync-cli.md) で状態確認。

## アプリ側の整合

手動でロールを剥奪したら:

- `members` の `subscription_status` / `access_end_at` が仕様と一致しているか DB で確認する。
- 必要に応じて `npm run resync -- --discord-user-id <id>` で再同期する。

## 記録

インシデントや手動対応の場合は [pci-incident-response-plan.md](../compliance/pci-incident-response-plan.md) に沿って **時系列と実施者** を残す。証跡用メモを [docs/evidence/](../evidence/) に保存してよい。

## 参考コード

アプリ内のロール操作は `@discordjs/rest` を使用（[packages/server/src/main.ts](../../packages/server/src/main.ts) の `discordClient` 周辺）。
