# Operational Alerts — payjp-ops

> **Scope deviation notice.** `2weeks-spec.md §3` declares "Alert自動通知" out of scope for MVP. This feature is an **additive host-level observability layer** that does not modify runtime behavior of in-scope services (`packages/`, `docker-compose.yml`, `nginx/*`, `schema.sql`). By decision 2026-04-14, operator accepts deployment without filing a Change Request against `2weeks-spec.md`. Removal is reversible via `install.sh --uninstall` with zero application-side rollback.

---

## What this is

A minimal **pure-poll external observer** for the single-VPS deployment. Bash scripts run by systemd timers check 5 layers (Linux host / Docker / Nginx / Web app / PostgreSQL) every 5 minutes, post severity-coded embeds across **two operator Discord webhooks** (alerts + normal), and emit a daily digest at 09:00 JST.

- No SaaS dependencies
- No changes to application code / DB schema
- No additional npm packages
- State under `/var/lib/payjp-ops/state.d/` (per-alert stamps + green-streak counters + per-tick storm buffer)
- Removal leaves zero trace in application process or DB

| Severity | Color   | Channel | Default cooldown |
|----------|---------|---------|------------------|
| critical | red     | alerts  | 10 min |
| warn     | yellow  | alerts  | 30 min |
| normal   | green   | normal  | 60 min (typically RESOLVED posts only) |

| Post type | Channel |
|-----------|---------|
| `critical` / `warn` fire (e.g. `HOST_DISK_ROOT`, `DB_BACKUP_STALE`) | alerts |
| `OPS_STORM` aggregate | alerts |
| `*_RESOLVED` (normal, 2 consecutive green ticks) | normal |
| Daily digest 09:00 JST | normal |

Per-code cooldown overrides live in `scripts/ops/lib/thresholds.conf` (e.g., `COOLDOWN_HOST_TLS_EXPIRING=86400`).

External-dependency monitoring (PAY.JP / Discord / Let's Encrypt status pages, CAA, domain expiry) is documented separately in [`external-monitoring.md`](external-monitoring.md).

---

## Architecture

```
systemd.timer *:0/5  ──►  payjp-ops-check.service
                           ├── EnvironmentFile: /etc/payjp-ops/.env          (non-secret config)
                           ├── LoadCredentialEncrypted (BOTH channels):
                           │     DISCORD_OPS_WEBHOOK_ALERTS:/etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_ALERTS
                           │     DISCORD_OPS_WEBHOOK_NORMAL:/etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_NORMAL
                           │     (systemd-creds machine-bound; decrypt requires
                           │      this VPS's /etc/machine-id + credential.secret)
                           └── ExecStart: run-all-checks.sh
                                           │ (systemd surfaces each decrypted secret as a
                                           │  regular file under $CREDENTIALS_DIRECTORY/)
                                           ▼
                                   run-all-checks.sh  ──► check-{host,docker,nginx,app}.sh
                                                       │                              │
                                                       │   severity=critical|warn     │   severity=normal
                                                       ▼                              ▼
                                                   notify.sh ──► ALERTS webhook   notify.sh ──► NORMAL webhook

systemd.timer 09:00 JST ► payjp-ops-digest.service ──► daily-digest.sh ──► NORMAL webhook only
                           └── LoadCredentialEncrypted:
                                 DISCORD_OPS_WEBHOOK_NORMAL:/etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_NORMAL

                                                         /var/lib/payjp-ops/state.d/<code>.stamp
```

The `severity → webhook kind` mapping lives in `scripts/ops/lib/op-webhook.sh::severity_to_webhook_kind`:
`critical`/`warn`/unknown → `alerts`, `normal` → `normal`. `OPS_STORM` is emitted with `severity=critical` → routes to alerts.

**Dedup**: `should_fire CODE SEVERITY` checks stamp age vs cooldown. `on_healthy CODE` counts consecutive green ticks; after 2, posts RESOLVED.

**Global rail**: 1 post / 60 s across all codes (`GLOBAL_MIN_INTERVAL_SEC`). Digest is exempt.

**Storm collapse**: when ≥ `STORM_CODES_THRESHOLD` (default 5) distinct codes fire in one tick, subsequent individual posts are suppressed; `tick_finalize` emits a single `OPS_STORM` critical post listing all codes. Runs inside `run-all-checks.sh`.

---

## Bootstrap (operator, one-time)

**Secret model**: the two secrets (Discord webhook URLs, one per channel) are
encrypted with **systemd-creds** and surfaced to the process at runtime via
`LoadCredentialEncrypted=`. This is machine-bound — the encrypted files on
disk cannot be decrypted on another host (requires this VPS's
`/etc/machine-id` + `/var/lib/systemd/credential.secret`). 1Password stores
the plaintext URLs as a **backup** only; no 1P runtime dependency, so
1Password Personal is sufficient.

### Files

| Path | Mode | Contents |
|------|------|----------|
| `/etc/payjp-ops/.env` | 0640 root:payjp-ops | Non-secret runtime config (`POSTGRES_USER`, paths, thresholds) |
| `/etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_ALERTS` | 0600 root:root | Encrypted webhook URL for **critical/warn/OPS_STORM** |
| `/etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_NORMAL` | 0600 root:root | Encrypted webhook URL for **RESOLVED + daily digest** |

Note: the runtime service user `payjp-ops` does **not** need direct read
access to the encrypted files — systemd itself decrypts and places the
plaintext under `$CREDENTIALS_DIRECTORY` only for the service's process tree.

### Steps

1. **Install** (requires root). Verifies `systemd-creds`/`jq`/`curl`/`rsync` presence, creates the `payjp-ops` user, state dir, systemd units, sudoers drop-in, seeds the `.env` template, and prepares the creds directory:
   ```
   cd /home/ubuntu/payjp
   sudo ./deploy/ops-systemd/install.sh
   ```
   Idempotent.

2. **Discord channel + webhook setup**:
   - Create two channels (e.g. `#payjp-ops-alerts`, `#payjp-ops-normal`).
   - In each channel: Integrations → Webhooks → New Webhook → copy URL.
   - Save BOTH URLs to 1Password (e.g. `ENV` vault, items `ops-discord-webhook-alerts` and `ops-discord-webhook-normal`). 1P Personal plan is sufficient.
   - This 1P item is the canonical plaintext source for (a) re-encryption during VPS rebuild and (b) inter-operator sharing. **Not** queried at runtime.

3. **Populate `/etc/payjp-ops/.env`** (non-secret values):
   ```
   sudoedit /etc/payjp-ops/.env
   ```
   Fill:
   - `POSTGRES_USER=...` / `POSTGRES_DB=...` (match the app's `.env`)

4. **Encrypt BOTH webhook URLs into systemd credential files**:

   4a. alerts channel (critical / warn / OPS_STORM):
   ```
   sudo bash -c 'systemd-creds encrypt \
       --name=DISCORD_OPS_WEBHOOK_ALERTS - /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_ALERTS'
   # paste the alerts webhook URL (single line), Ctrl+D
   sudo chmod 0600 /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_ALERTS
   sudo chown root:root /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_ALERTS
   ```

   4b. normal channel (RESOLVED + daily digest):
   ```
   sudo bash -c 'systemd-creds encrypt \
       --name=DISCORD_OPS_WEBHOOK_NORMAL - /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_NORMAL'
   # paste the normal webhook URL (single line), Ctrl+D
   sudo chmod 0600 /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_NORMAL
   sudo chown root:root /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_NORMAL
   ```

   The encrypted files are machine-bound: copying them to another host renders them unreadable.

5. **Verify each credential decrypts** (quick sanity check):
   ```
   sudo systemd-creds --name=DISCORD_OPS_WEBHOOK_ALERTS decrypt \
       /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_ALERTS - \
     | sed 's#\(https://discord.com/api/webhooks/\)[^/]*/.*#\1<id>/<token>#'
   sudo systemd-creds --name=DISCORD_OPS_WEBHOOK_NORMAL decrypt \
       /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_NORMAL - \
     | sed 's#\(https://discord.com/api/webhooks/\)[^/]*/.*#\1<id>/<token>#'
   # Expect each line: https://discord.com/api/webhooks/<id>/<token>
   ```
   The `sed` mask prevents the full URL from landing in shell history / journal.

6. **Remove any legacy single-webhook credential** (from the pre-split era):
   ```
   sudo rm -f /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK
   ```

7. **Dry-run the checks** (no Discord post, no systemd):
   ```
   sudo -u payjp-ops DRY_RUN=1 /opt/payjp-ops/bin/check-host.sh
   sudo -u payjp-ops DRY_RUN=1 /opt/payjp-ops/bin/check-docker.sh
   sudo -u payjp-ops DRY_RUN=1 /opt/payjp-ops/bin/check-nginx.sh
   sudo -u payjp-ops DRY_RUN=1 /opt/payjp-ops/bin/check-app.sh
   sudo -u payjp-ops DRY_RUN=1 /opt/payjp-ops/bin/daily-digest.sh
   ```
   Dry-run skips the credential read and Discord POST; threshold crossings print JSON on stdout.

8. **Live smoke** — run each service once (systemd loads the encrypted credentials and posts to Discord):
   ```
   sudo systemctl start payjp-ops-check.service
   journalctl -u payjp-ops-check.service -n 40 --no-pager
   # Expect: fire events in the ALERTS channel
   sudo systemctl start payjp-ops-digest.service
   journalctl -u payjp-ops-digest.service -n 40 --no-pager
   # Expect: digest embed in the NORMAL channel
   sudo systemctl start payjp-ops-backup.service
   journalctl -u payjp-ops-backup.service -n 40 --no-pager
   sudo ls -lt /var/backups/payjp-db/ | head
   # Expect: new payjp_<ts>Z.sql.gz, minimum 500B enforced
   ```

9. **Enable timers**:
   ```
   sudo systemctl enable --now payjp-ops-check.timer payjp-ops-digest.timer payjp-ops-backup.timer
   systemctl list-timers | grep payjp-ops
   journalctl -u payjp-ops-check.service -f
   ```

10. **Webhook rotation** (per channel; regenerate one or both):
    - Update the matching 1P backup item with the new URL.
    - Re-encrypt the affected credential (replace `_ALERTS` with `_NORMAL` if rotating the normal channel):
      ```
      sudo rm /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_ALERTS
      sudo bash -c 'systemd-creds encrypt --name=DISCORD_OPS_WEBHOOK_ALERTS - /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_ALERTS'
      # paste the new URL, Ctrl+D
      sudo chmod 0600 /etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_ALERTS
      sudo systemctl restart payjp-ops-check.timer payjp-ops-digest.timer payjp-ops-backup.timer
      ```

11. **VPS rebuild migration** (rare, e.g. hardware failure):
    - machine-id changes on a new host → old encrypted files won't decrypt.
    - Re-run step 1 (install) on the new VPS, then step 4 (re-encrypt both) using the plaintext URLs from the 1P backup items.

---

## Alert runbook

### Linux host (Phase A)

| Code | Trigger | Severity | Remediation |
|------|---------|----------|-------------|
| `HOST_DISK_ROOT`       | `/` used > `DISK_PCT` | critical | `df -h /`; purge images (`docker system prune`), old logs |
| `HOST_DISK_VARLOG`     | `/var/log` used > `DISK_PCT` | warn     | inspect `json-file` driver retention; rotate |
| `HOST_DISK_BACKUPS`    | `$BACKUP_DIR` used > `DISK_PCT` | critical | prune `payjp_*.sql.gz` beyond retention |
| `HOST_LOAD_HIGH`       | load5 > `LOAD5_X_NPROC × nproc` × 3 ticks | warn | `top`, identify runaway proc |
| `HOST_OOM_KILL`        | ≥1 `Killed process` in kernel log / 24h | critical | find OOM target; raise limits or reduce load |
| `HOST_REBOOT_REQUIRED` | `/var/run/reboot-required` exists | warn | schedule reboot |
| `HOST_SWAP_HIGH`       | swap used > `SWAP_PCT`% | warn | investigate memory pressure |
| `HOST_FAIL2BAN_SURGE`  | currently-banned aggregate ≥ `FAIL2BAN_BANNED_THRESHOLD` | warn | `sudo fail2ban-client status <jail>`; inspect attack source |
| `HOST_TLS_EXPIRING`    | cert `notAfter` < `TLS_DAYS_CRITICAL` days | critical | `sudo certbot renew` (stop nginx first for standalone) |
| `HOST_DOMAIN_EXPIRING` | whois Registry Expiry Date < `DOMAIN_DAYS_CRITICAL` days for any domain in `DOMAINS_TO_MONITOR` | critical | CF dashboard → Registrar → verify auto-renew ON + payment method valid; trigger manual renewal if needed |

### Docker (Phase B)

| Code | Trigger | Severity | Remediation |
|------|---------|----------|-------------|
| `DOCKER_DAEMON_DOWN`     | `systemctl is-active docker` ≠ active | critical | `sudo systemctl status docker`; restart |
| `DOCKER_CONTAINER_EXITED` | any compose-project container in status=exited | critical | `sudo docker compose logs <svc>`; restart |
| `DOCKER_RESTART_DELTA`   | `RestartCount` increased since last tick | warn     | `sudo docker logs --tail 200 <container>` |
| `DOCKER_HEALTH_UNHEALTHY` | `payjp-db-1` healthcheck status=unhealthy | critical | `sudo docker inspect --format '{{json .State.Health}}' payjp-db-1` |

Only `payjp-db-1` has a Docker healthcheck. `api` / `admin-api` / `nginx` are covered by HTTP probe (`APP_HEALTH_FAIL`) and log tails (`NGINX_*`) instead.

### Nginx (Phase B)

| Code | Trigger | Severity | Remediation |
|------|---------|----------|-------------|
| `NGINX_5XX_BURST`      | >`NGINX_5XX_PER_5MIN` 5xx in 5 min | critical | `sudo tail -n 200 access.log \| jq 'select(.status>=500)'` |
| `NGINX_429_BURST`      | >`NGINX_429_PER_5MIN` 429 in 5 min | warn     | rate-limit zones engaged; inspect client IPs |
| `NGINX_UPSTREAM_SLOW`  | p95 `upstream_response_time` > `NGINX_UPSTREAM_P95_SEC` over last 200 samples | warn     | identify slow endpoint; check DB load |
| `NGINX_ERRLOG_CRIT`    | new `[crit\|alert\|emerg]` entry | critical | `sudo tail -n 50 error.log`; investigate |

### Web app + DB (Phase C)

| Code | Trigger | Severity | Remediation |
|------|---------|----------|-------------|
| `APP_HEALTH_FAIL`       | `curl HEALTH_URL` non-200 or timeout `APP_HEALTH_TIMEOUT`s | critical | check nginx, api container, upstream chain |
| `APP_HEALTH_SLOW`       | `%{time_total}` > `APP_HEALTH_SLOW_SEC`s | warn     | check CPU/DB load |
| `DB_PING`               | `SELECT 1` via `docker exec` fails | critical | check DB container; `sudo docker inspect --format '{{.State.Health.Status}}' payjp-db-1` |
| `APP_PAYJP_EVENTS_FAILED` | >`APP_PAYJP_EVENTS_FAILED_PER_1H` failed webhook rows in 1h | critical | query `payjp_events` for payload.`_processing`.`fail_reason`; see `docs/ops/resync-cli.md` |
| `APP_IMPACT_LOGS_OPEN`  | unresolved `member_impact_logs` > `APP_IMPACT_LOGS_OPEN` | warn     | `docs/ops/resync-cli.md` |
| `APP_INFLIGHT_STUCK_WARN` | any `inflight_operation_started_at` > `APP_INFLIGHT_WARN_MIN`min | warn     | watch; escalates to critical at `APP_INFLIGHT_CRIT_HOUR`h |
| `APP_INFLIGHT_STUCK_CRIT` | any `inflight_operation_started_at` > `APP_INFLIGHT_CRIT_HOUR`h | critical | `npm run resync -- --operation-id <id>` |
| `DB_BACKUP_STALE`       | latest `payjp_*.sql.gz` mtime > `DB_BACKUP_STALE_HOURS`h | critical | `systemctl list-timers payjp-ops-backup.timer`; manual run: `sudo systemctl start payjp-ops-backup.service` |

### Aggregate

| Code | Trigger | Severity |
|------|---------|----------|
| `OPS_STORM` | ≥`STORM_CODES_THRESHOLD` codes fired in one tick | critical |

---

## Daily digest (09:00 JST)

`payjp-ops-digest.timer` fires `daily-digest.sh` every day at 09:00 Asia/Tokyo. Embeds a green (normal) summary with:

- **KPI (24h)** — webhook failed / api 5xx / unresolved impact count
- **Backup** — last success age, size, filename
- **Host** — disk %, load5, uptime days
- **TLS** — days remaining per domain
- **Domain** — whois Registry Expiry days remaining per registered domain in `DOMAINS_TO_MONITOR`
- **Docker** — running/expected count + db healthcheck status
- **fail2ban** — currently banned per jail
- **Alerts fired (24h)** — `list_recent_alerts` summary (up to 8 entries)

Digest is not subject to cooldown — it always posts when the timer fires.

---

## Nightly DB backup (03:00 JST ±5min)

`payjp-ops-backup.timer` fires `backup-db.sh` every day at 03:00 Asia/Tokyo (`RandomizedDelaySec=5m`). Writes `payjp_<YYYYMMDD_HHMMSSZ>.sql.gz` (UTC) to `/var/backups/payjp-db/`, retention `${BACKUP_RETENTION_DAYS:-14}` days.

Implementation: runs as **root**, uses `docker compose exec -T db sh -c 'pg_dump -U $POSTGRES_USER -d $POSTGRES_DB --no-owner --no-privileges' | gzip -9`. `POSTGRES_*` come from inside the container; no host-side DB secret is required. The backup directory is `0750 root:payjp-ops` so the polling check (running as `payjp-ops`) can list + stat mtimes while file contents remain 0600 root-only.

Minimum size threshold: `${MIN_BACKUP_BYTES:-500}` bytes — suspiciously small dumps fail loudly.

Failure surfaces as `DB_BACKUP_STALE` via the polling `check-app.sh:check_backup_stale` (threshold `DB_BACKUP_STALE_HOURS`). Inspect:

```
systemctl list-timers payjp-ops-backup.timer
journalctl -u payjp-ops-backup.service -n 80 --no-pager
sudo ls -lt /var/backups/payjp-db/ | head
```

Manual run: `sudo systemctl start payjp-ops-backup.service`.

### Migration from legacy `payjp-db-backup.{service,timer}`

The repo-managed `payjp-ops-backup.*` unit **replaces** the host-level `/usr/local/sbin/payjp-db-backup` + `payjp-db-backup.{service,timer}`. `install.sh` detects and removes the legacy units idempotently. File naming (`payjp_*.sql.gz`), output directory (`/var/backups/payjp-db/`), and retention (14 days) are preserved, so existing backups carry over and age out normally.

---

## Test matrix

| # | Scenario | Command | Expected |
|---|---|---|---|
| 1  | Dry-run (any) | `sudo -u payjp-ops DRY_RUN=1 /opt/payjp-ops/bin/check-host.sh` | JSON payload(s) on stdout, no state writes |
| 2  | Disk fire | `DISK_PCT=10` in `thresholds.conf`; run once | 1 critical `HOST_DISK_ROOT` post |
| 3  | Disk dedup | re-run within 30 min | no post |
| 4  | Disk resolve | revert `DISK_PCT`; run twice | 1 normal `HOST_DISK_ROOT_RESOLVED` after 2nd tick |
| 5  | Docker restart | `sudo docker restart payjp-api-1`; wait 6 min | 1 warn `DOCKER_RESTART_DELTA` |
| 6  | Container exited | `sudo docker stop payjp-admin-api-1` (test env); wait 6 min | 1 critical `DOCKER_CONTAINER_EXITED` |
| 7  | /health down | `sudo docker pause payjp-api-1`; wait 6 min | 1 critical `APP_HEALTH_FAIL`; `unpause` to clear |
| 8  | DB ping | `sudo docker stop payjp-db-1` (test env); wait 6 min | 1 critical `DB_PING` |
| 9  | Backup stale | `sudo touch -d '30 hours ago' /var/backups/payjp-db/payjp_*.sql.gz` | 1 critical `DB_BACKUP_STALE` |
| 10 | TLS | point `CERT_PATHS` at a test cert <14 days remaining | 1 critical `HOST_TLS_EXPIRING` |
| 10b | Domain | `DOMAIN_DAYS_CRITICAL=400` (forces fire on any 1-year domain) in shell env, run check-host.sh once | 1 critical `HOST_DOMAIN_EXPIRING` |
| 11 | 5xx burst | inject 6 status-500 JSON lines into nginx access.log | 1 critical `NGINX_5XX_BURST` |
| 12 | Storm | trigger 5+ codes in one tick | `OPS_STORM` post; individual #5+ suppressed |
| 13 | Digest | `sudo -u payjp-ops /opt/payjp-ops/bin/daily-digest.sh` | 1 normal digest post in production channel |
| 14 | Uninstall | `sudo ./deploy/ops-systemd/install.sh --uninstall; systemctl list-timers` | no payjp-ops-* timers |

For dev-only testing without polluting the production ops channels, override both URLs via env for the shell session: `DISCORD_OPS_WEBHOOK_ALERTS=https://...test-alerts` and `DISCORD_OPS_WEBHOOK_NORMAL=https://...test-normal` (or set `DRY_RUN=1`).

---

## Deferred / not monitored

Explicitly **out of scope** for this implementation. File a Change Request against `CLAUDE.md` Spec Document Hierarchy if any becomes Go-Live-critical.

- External VPS-down probe (SaaS uptime monitor) — host death ≡ alert silence
- Log centralization (Loki, Vector, rsyslog remote)
- PAY.JP webhook signature anomaly counter (needs app-side hook)
- PII redaction continuous audit (one-shot review only)
- PagerDuty / Opsgenie / SMS escalation
- CSP violation aggregation endpoint
- PAY.JP / Discord upstream active probes (would hit billing endpoints)
- Postgres slow-query / autovacuum / WAL monitoring
- APM / distributed tracing
- `/health` deep check with DB/Discord/PAY.JP dependencies — requires changing `packages/server/src/app.ts:93`, out of pure-poll scope

---

## Uninstall

```
sudo /home/ubuntu/payjp/deploy/ops-systemd/install.sh --uninstall
```

**Removed**: timers, service units, `/opt/payjp-ops/bin/`, sudoers drop-in.

**Preserved** (delete manually if truly done):
- `/var/lib/payjp-ops/` — state stamps for postmortem
- `/etc/payjp-ops/.env` — non-secret runtime config
- `/etc/payjp-ops/creds/DISCORD_OPS_WEBHOOK_ALERTS` / `_NORMAL` — systemd-creds encrypted blobs (machine-bound, useless off-host, but delete for cleanliness)
- `payjp-ops` system user — `sudo userdel payjp-ops`

Zero application-side rollback needed. The webhook URLs themselves remain valid on the Discord side — regenerate them in Discord server settings if the uninstall is due to a compromise.

---

## Phase status

- [x] **Phase A** — notifier + Linux host signals + systemd scaffolding + bootstrap
- [x] **Phase B** — Docker + Nginx checks
- [x] **Phase C** — Web app HTTP + DB queries + storm-collapse protection
- [x] **Phase D** — Daily digest + complete runbook
