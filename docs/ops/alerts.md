# Operational Alerts — payjp-ops

> **Scope deviation notice.** `2weeks-spec.md §3` declares "Alert自動通知" out of scope for MVP. This feature is an **additive host-level observability layer** that does not modify runtime behavior of in-scope services (`packages/`, `docker-compose.yml`, `nginx/*`, `schema.sql`). By decision 2026-04-14, operator accepts deployment without filing a Change Request against `2weeks-spec.md`. Removal is reversible via `install.sh --uninstall` with zero application-side rollback.

---

## What this is

A minimal **pure-poll external observer** for the single-VPS deployment. Bash scripts run by systemd timers check 5 layers (Linux host / Docker / Nginx / Web app / PostgreSQL) every 5 minutes, post severity-coded embeds to **one operator Discord webhook**, and emit a daily digest at 09:00 JST.

- No SaaS dependencies
- No changes to application code
- No additional npm packages
- State under `/var/lib/payjp-ops/state.d/` (per-alert stamps + green-streak counters for auto-resolve)
- Removal leaves zero trace in application process or DB

| Severity | Color    | Cooldown |
|----------|----------|----------|
| critical | red      | 10 min (default) |
| warn     | yellow   | 30 min |
| normal   | green    | 60 min (typically auto-resolve posts only) |

Refer to `scripts/ops/lib/thresholds.conf` for the canonical numeric thresholds.

---

## Architecture

```
systemd.timer *:0/5  ──►  payjp-ops-check.service  ──►  run-all-checks.sh  ──►  check-{host,docker,nginx,app}.sh
                                                                               │
systemd.timer 09:00  ──►  payjp-ops-digest.service  ──►  daily-digest.sh      │
                                                                               ▼
                                                                            notify.sh  ──►  Discord webhook (1P)
                                                                               │
                                                                   /var/lib/payjp-ops/state.d/<code>.stamp
```

Dedup: `should_fire <code> <severity>` checks stamp age vs cooldown. `on_healthy <code>` counts consecutive green ticks; after 2, posts RESOLVED.

Global rail: 1 post / 60 s across all codes (storm protection). `list_recent_alerts` enumerates stamps fired in the last 24h for the daily digest.

---

## Bootstrap (operator, one-time)

1. **Install** (requires root):
   ```
   cd /home/ubuntu/payjp
   sudo ./deploy/ops-systemd/install.sh
   ```
   The installer creates the `payjp-ops` system user, the state directory, installs systemd units, seeds a sudoers drop-in (minimum read-only commands), and drops a template `/etc/payjp-ops/env` (0400 root:root).

2. **1Password service account**:
   - Create a new 1Password **service account** with read-only access to a `Private` vault item named `ops-discord-webhook` (single field `url`).
   - `op signin` in the 1P CLI and copy the service account token.

3. **Populate `/etc/payjp-ops/env`**:
   ```
   sudo nano /etc/payjp-ops/env
   ```
   Fill:
   - `OP_SERVICE_ACCOUNT_TOKEN=ops_xxx...`
   - `OP_WEBHOOK_ITEM=op://Private/ops-discord-webhook/url` (or your vault path)
   - `PGUSER`, `PGDB` from `op read op://Private/payjp-db/{user,db}` (Phase C only — can leave blank for Phase A)

4. **Verify dry-run** (no Discord post):
   ```
   sudo -u payjp-ops DRY_RUN=1 /opt/payjp-ops/bin/check-host.sh
   ```
   Expect JSON payload(s) on stdout for any threshold crossings; no state-file writes.

5. **Enable the timer**:
   ```
   sudo systemctl enable --now payjp-ops-check.timer
   systemctl list-timers | grep payjp-ops
   journalctl -u payjp-ops-check.service -f
   ```

6. **Token rotation** (every 90 days):
   - Rotate the 1P service account token.
   - Update `/etc/payjp-ops/env`.
   - `sudo systemctl restart payjp-ops-check.service` (next tick picks up new env).
   - Revoke old SA in 1P console.

---

## Host-layer alerts (Phase A)

| Code | Trigger | Severity | Cooldown | Remediation |
|------|---------|----------|----------|-------------|
| `HOST_DISK_ROOT`     | `/` used > `DISK_PCT` | critical | 30 min | `df -h /`; purge docker images, old logs |
| `HOST_DISK_VARLOG`   | `/var/log` used > `DISK_PCT` | warn | 30 min | inspect container json-file driver retention |
| `HOST_DISK_BACKUPS`  | `$BACKUP_DIR` used > `DISK_PCT` | critical | 30 min | prune old `hayane_*.sql.gz` beyond retention |
| `HOST_LOAD_HIGH`     | load5 > `LOAD5_X_NPROC × nproc` for 3 consecutive ticks | warn | 30 min | `top`, identify runaway process |
| `HOST_OOM_KILL`      | `journalctl -k -g 'Killed process'` ≥1 in 24h | critical | 60 min | identify OOM target, raise limits or tune |
| `HOST_REBOOT_REQUIRED` | `/var/run/reboot-required` exists | warn | 24h | schedule maintenance window, `reboot` |
| `HOST_SWAP_HIGH`     | swap used > `SWAP_PCT`% | warn | 60 min | investigate memory pressure |
| `HOST_FAIL2BAN_SURGE` | `fail2ban-client status` currently-banned aggregate ≥ `FAIL2BAN_BANNED_THRESHOLD` | warn | 60 min | `sudo fail2ban-client status <jail>` — investigate attack source |
| `HOST_TLS_EXPIRING`  | cert `notAfter` < `TLS_DAYS_CRITICAL` days | critical | 24h | `sudo certbot renew` (stop nginx first for standalone) |

---

## Test matrix (Phase A subset)

| # | Scenario | Command | Expected |
|---|---|---|---|
| 1 | Dry-run | `sudo -u payjp-ops DRY_RUN=1 /opt/payjp-ops/bin/check-host.sh` | payload JSON on stdout, no state writes |
| 2 | Disk fire | edit `thresholds.conf`: `DISK_PCT=10`, run | 1 critical `HOST_DISK_ROOT` post |
| 3 | Disk dedup | re-run within 30 min | no post |
| 4 | Disk resolve | revert `DISK_PCT=85`, run twice | 1 normal `HOST_DISK_ROOT_RESOLVED` post after 2nd tick |
| 5 | TLS | point `CERT_PATHS` at a test cert with <14d remaining | 1 critical `HOST_TLS_EXPIRING` |
| 6 | Uninstall | `sudo ./deploy/ops-systemd/install.sh --uninstall; systemctl list-timers` | no payjp-ops-* timers |

---

## Deferred / not monitored

These are explicitly **out of scope** for this phase. Reference `CLAUDE.md` Spec Document Hierarchy to file a future Change Request if any becomes Go-Live-critical.

- External VPS-down probe (SaaS uptime monitor) — host death ≡ alert silence
- Log centralization (Loki, Vector, rsyslog remote)
- PAY.JP webhook signature anomaly counter (needs app-side hook)
- PII redaction continuous audit
- PagerDuty / Opsgenie / SMS escalation
- CSP violation aggregation endpoint
- PAY.JP / Discord availability active probes (would hit billing endpoints)
- Postgres slow-query / autovacuum / WAL monitoring
- APM / distributed tracing
- `/health` deep check (needs `packages/server/src/app.ts:93` change)

---

## Uninstall

```
sudo /home/ubuntu/payjp/deploy/ops-systemd/install.sh --uninstall
```

**Removed**: timers, services, `/opt/payjp-ops/bin/`, sudoers drop-in.

**Preserved** (by design — delete manually if desired):
- `/var/lib/payjp-ops/` — state stamps for postmortem
- `/etc/payjp-ops/env` — contains 1P service account token; operator should revoke the token in the 1P console before deletion
- `payjp-ops` system user — kept for audit continuity; `sudo userdel payjp-ops` if truly done

No application-side rollback needed. `packages/`, `docker-compose.yml`, `nginx/*.conf`, `schema.sql` are never touched.

---

## Phase status

- [x] **Phase A**: notifier + Linux host signals + systemd scaffolding + bootstrap
- [ ] **Phase B**: Docker + Nginx checks
- [ ] **Phase C**: Web app HTTP + DB queries + storm-collapse protection
- [ ] **Phase D**: Daily digest + runbook completion
