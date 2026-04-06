---
name: create-migration
description: PostgreSQLマイグレーションファイルを作成（タイムスタンプ付き、up/down対応）
disable-model-invocation: true
---

# Create Migration

PostgreSQL マイグレーションファイルを生成する。

## 手順

1. 既存マイグレーションを確認: `ls packages/shared/migrations/` でタイムスタンプ順序を把握
2. 新しいタイムスタンプを生成: `YYYYMMDDHHMMSS` 形式（UTC）
3. ファイル作成: `packages/shared/migrations/{timestamp}_{name}.sql`

## ファイル構造

```sql
-- migrate:up
CREATE TABLE ...;

-- migrate:down
DROP TABLE IF EXISTS ...;
```

## ルール

- テーブル名はスネークケース複数形（例: `subscription_plans`）
- `id` は `UUID DEFAULT gen_random_uuid() PRIMARY KEY`
- `created_at` / `updated_at` は `TIMESTAMPTZ NOT NULL DEFAULT now()`
- 外部キーには明示的な `ON DELETE` を指定
- DOWN は UP の逆操作を正確に記述（データロスに注意喚起）
- `packages/shared/src/db/` の型定義も同時に更新
