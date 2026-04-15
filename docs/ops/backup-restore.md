# DB Backup & Restore Runbook

PAY.JP の PostgreSQL backup は二層構造：

| 層 | 場所 | 保持 | 用途 |
|---|---|---|---|
| ローカル | `/var/backups/payjp-db/` (VPS) | 14日 | 迅速な復元、軽微な事故 |
| オフサイト | B2 bucket `payjp-db-backup-prod` | 32日 (lifecycle) | VPS全損・ランサムウェア対策 |

オフサイトは **age 暗号化 + B2 Object Lock Compliance 30日** によるゼロ知識・ランサム耐性設計。

## 構成要素

| 要素 | 実体 |
|---|---|
| 毎日 03:00 JST ローカル backup | `payjp-ops-backup.timer` → `backup-db.sh` |
| 成功時オフサイト upload (OnSuccess=) | `payjp-ops-offsite.service` → `offsite-upload.sh` |
| 月次 restore drill (第1日曜 04:00 JST) | `payjp-ops-restore-drill.timer` → `restore-drill.sh` |
| Discord alert (3種) | `DB_BACKUP_STALE` / `DB_OFFSITE_STALE` / `DB_RESTORE_DRILL_STALE` |

## age 鍵の所在

- **public key** (暗号化用): `deploy/ops-systemd/backup-age-recipients.pub` (repo commit)
  - install 後: `/opt/payjp-ops/etc/backup-age-recipients.pub`
- **private key** (復号用):
  - 1Password "PAY.JP DB Backup - age private key" (primary)
  - 紙印刷 or USB (金庫保管、primary の backup)
  - 復元 drill 時のみ systemd-creds encrypted blob として VPS 上に存在 (`/etc/payjp-ops/creds/BACKUP_AGE_PRIVATE_KEY`、tmpfs 上で drill 中のみ平文化)

**private key を失うと B2 上の過去 backup は永久に読めなくなる。** 1Password ロックアウト + 物理 backup も紛失 = 全滅。

## B2 application keys

| Name | Capabilities | 用途 | VPS上 | 1Password |
|---|---|---|---|---|
| `payjp-backup-write` | writeFiles | 日次 upload | ○ (systemd-creds) | ○ |
| `payjp-drill-read` | readFiles, listFiles | 月次 drill + daily digest quota | ○ (systemd-creds) | ○ |
| master account key | all | rotation, bucket reconfig | × | ○ |

---

## シナリオ別復元手順

### (A) ローカル backup から復元

DB が壊れたが VPS は稼働している場合。最も速い。

```bash
# 1. app 停止
cd /home/ubuntu/payjp
op run --env-file=.env -- docker compose stop api admin-api

# 2. 最新 backup を特定
LATEST=$(sudo ls -1t /var/backups/payjp-db/payjp_*.sql.gz | head -1)
echo "restoring: $LATEST"

# 3. DB を空にして restore
op run --env-file=.env -- docker compose exec -T db \
  psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS $POSTGRES_DB; CREATE DATABASE $POSTGRES_DB;"

sudo zcat "$LATEST" | \
  op run --env-file=.env -- docker compose exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1

# 4. app 再開
op run --env-file=.env -- docker compose start api admin-api
```

### (B) オフサイト backup から復元 (VPS が稼働している場合)

ローカル backup が破損・消失しているが VPS 本体は生きている。

**重要**: 秘密情報を shell 引数 / heredoc で貼り付けない（`~/.bash_history` と readline buffer に残る）。下記手順は `sudoedit` と stdin パイプのみで secret を扱う。

```bash
# 1. 作業用 tmpfs ディレクトリ作成
sudo install -d -m 0700 /root/restore.$$
cd /root/restore.$$

# 2. age private key を sudoedit で作成 (editor が tmpfile を開くのでhistory汚染なし)
sudo install -m 0600 /dev/null age-key.txt
sudoedit /root/restore.$$/age-key.txt
# → editor が開く。1Password から AGE-SECRET-KEY-1... を1行コピペ、保存、終了

# 3. B2 read credentials も同様 (shell history に残らないよう read -s 経由)
unset HISTFILE
read -r -s -p "drill-read keyID: "          RCLONE_CONFIG_B2_ACCOUNT; echo
read -r -s -p "drill-read applicationKey: " RCLONE_CONFIG_B2_KEY;     echo
export RCLONE_CONFIG_B2_TYPE=b2
export RCLONE_CONFIG_B2_ACCOUNT RCLONE_CONFIG_B2_KEY

# 4. 対象 blob を list、選択
rclone lsf b2:payjp-db-backup-prod/ | grep 'payjp_.*\.sql\.gz\.age' | sort
TARGET=payjp_20260415_180000Z.sql.gz.age   # 復元したい時点

# 5. download + decrypt + restore (streaming)
sudo rclone cat "b2:payjp-db-backup-prod/$TARGET" \
  | sudo age -d -i /root/restore.$$/age-key.txt \
  | gunzip \
  | op run --env-file=/home/ubuntu/payjp/.env -- \
    docker compose -f /home/ubuntu/payjp/compose.yaml exec -T db \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1

# 6. private key を確実に破棄 + env 変数 unset
sudo shred -u /root/restore.$$/age-key.txt
sudo rm -rf /root/restore.$$
unset RCLONE_CONFIG_B2_ACCOUNT RCLONE_CONFIG_B2_KEY RCLONE_CONFIG_B2_TYPE
# もし HISTFILE を unset せずに export していた場合は history -c + 新shell開く
```

### (C) VPS 全損 — 別ホストで復元

最悪ケース。新しい VPS を立ち上げ、そこで復元。

1. 新 VPS 起動、docker + postgres container 起動 (compose 既定値)
2. Mac or 信頼できる作業機で以下を実行：
   ```bash
   # Mac 側で B2 credentials を rclone config に登録 (interactive、history汚染なし)
   brew install age rclone
   rclone config
     # name: payjp-b2
     # type: b2
     # account: <paste drill-read keyID>
     # key:     <paste drill-read applicationKey>

   rclone lsf payjp-b2:payjp-db-backup-prod/
   rclone copy payjp-b2:payjp-db-backup-prod/payjp_<TARGET>.sql.gz.age /tmp/

   # age private key は 1Password から file (Documents/age-private.txt) に一時保存
   age -d -i ~/Documents/age-private.txt /tmp/payjp_<TARGET>.sql.gz.age > /tmp/dump.sql.gz

   # 新 VPS へ転送
   scp /tmp/dump.sql.gz new-vps:/tmp/
   ssh new-vps 'zcat /tmp/dump.sql.gz | docker compose exec -T db psql -U $POSTGRES_USER -d $POSTGRES_DB'
   ```
3. 作業終了後の必須 cleanup (鍵管理衛生)：
   ```bash
   # Mac 側
   shred -u ~/Documents/age-private.txt  # 1Password がマスター保管、tmp copy は必ず破棄
   shred -u /tmp/payjp_<TARGET>.sql.gz.age /tmp/dump.sql.gz
   rclone config delete payjp-b2           # B2 credentials を config file からも消去
   ```

---

## 復元 drill (月次自動)

### 何をするか

1. B2 bucket から最新の `payjp_*.sql.gz.age` を download
2. systemd-creds で load した age private key で復号
3. scratch postgres container (ephemeral, port 55432) を起動
4. 復号した dump を restore
5. テーブル件数 sanity check
6. container 破棄、success stamp 更新

### 失敗時の対応

- Discord `#payjp-ops-alerts` に `DB_RESTORE_DRILL_STALE` が critical で発火
- `journalctl -u payjp-ops-restore-drill.service -n 100 --no-pager` でログ確認
- 失敗パターン別：

| 症状 | 疑い | 対処 |
|---|---|---|
| `rclone lsf` で list 空 | drill-read key の scope 誤り | B2 console でkey capability確認 |
| `age: no identity matched` | private key と public key の組不整合 | 1Password の key を確認、正しい pair か |
| `psql: SYNTAX ERROR` | dump 自体が壊れている | local backup 側も確認、pg_dump process の失敗 |
| `docker: permission denied` | systemd の sandboxing 過剰 | `payjp-ops-restore-drill.service` 緩和検討 |

### 手動 trigger

月次待たずに drill を回したい時：
```bash
sudo systemctl start payjp-ops-restore-drill.service
journalctl -u payjp-ops-restore-drill.service -fn 80
```

---

## 鍵ローテーション手順 (post-MVP)

### age keypair を新しくする

1. Mac で新 keypair 生成、新 private を 1Password に保存 (別 item `v2`)
2. `deploy/ops-systemd/backup-age-recipients.pub` を新 public に差し替え
3. deploy: `sudo deploy/ops-systemd/install.sh`
4. 次の offsite upload から新 public で暗号化される
5. 旧暗号化 backup (B2 にある30日分) は旧 private key でしか読めない → 旧 1Password item は**最低32日**保管
6. 32日経過 + 新 key での drill 成功を確認後、旧 key を安全に廃棄

### B2 application key のローテーション

1. B2 console で新 key 発行 (同名でも別 keyID になる)
2. 旧 encrypted blob を削除:
   `sudo rm /etc/payjp-ops/creds/B2_BACKUP_KEY_ID /etc/payjp-ops/creds/B2_BACKUP_APPLICATION_KEY`
3. 新値を encrypt: install.sh の step 5 に従って再実行
4. service restart: `sudo systemctl restart payjp-ops-backup.timer`
5. 確認: `sudo systemctl start payjp-ops-offsite.service && journalctl -u payjp-ops-offsite -n 40`
6. B2 console で旧 key を delete

---

## 失敗シナリオ

| 原因 | 影響 | 復旧 |
|---|---|---|
| B2 down | 新規 upload 失敗、30h後 `DB_OFFSITE_STALE` 発火。ローカル backup は継続 | B2 復旧待ち、復旧後 upload 再開 (手動 service start で backfill) |
| age private key 紛失 (1Password + 物理 両方) | B2 上の backup 全て読めない | 新 keypair で再開、旧 backup は諦め (lifecycle で 32日で消える) |
| VPS compromise (ransomware) | local backup 暗号化される、しかし B2 側は Object Lock で保護 | Object Lock 期間 (30日) 過ぎるまで生き延びる。復旧は (C) 別 VPS |
| B2 account compromise | writeFiles scope のみ → 新規 upload 可能だが過去 backup 削除不可 (Object Lock) | B2 account 回復、master key rotation、credential 全 rotation |

---

## 関連ファイル

- `scripts/ops/backup-db.sh` — local backup
- `scripts/ops/offsite-upload.sh` — B2 upload + age encrypt
- `scripts/ops/restore-drill.sh` — monthly drill
- `scripts/ops/b2-quota-check.sh` — bucket size probe (digest用)
- `deploy/ops-systemd/payjp-ops-{backup,offsite,restore-drill}.service`
- `deploy/ops-systemd/backup-age-recipients.pub`
- Plan: `.claude/plans/noble-swimming-pnueli.md` (セッションローカル、Issue #82)

## 関連 memory

- `project_b2_offsite_backup_design.md` — 設計経緯、decision table
- `reference_b2_bucket_creation_gotchas.md` — B2 UI 罠
