# External monitoring

External dependencies / upstream status / domain-level events that the app cannot detect on its own. All alerts converge on Discord `#payjp-ops-alerts`.

- Internal host/app/DB alerts — see [`alerts.md`](alerts.md).
- Admin-plane access control — see [`admin-access-cloudflare.md`](admin-access-cloudflare.md).

## Scope

### Liveness / reachability (3-layer defense)

| Layer | Source | Unique coverage | Notify path |
|---|---|---|---|
| ① Internal | `payjp-ops` (host/docker/nginx/app/db) | Filesystem, container, app-level signals visible from inside the VPS | Discord webhooks (alerts + normal) |
| ② Outbound silence | Healthchecks.io (HC.io) | VPS total loss, outbound NW death, cron drift (any scenario that stops the heartbeat) | HC.io → Discord native integration |
| ③ Inbound external | HetrixTools | Inbound UFW/routing block, DNS resolution, TLS chain/SNI, BGP-level reachability, regional routing differences | HetrixTools → Discord native webhook |

Each layer has a blind spot the others cover. Internal checks still pass when inbound is blocked. HC.io still receives heartbeats when external inbound is broken. HetrixTools still alerts Up when outbound-only paths fail. All three are required.

### Upstream / third-party status

| Source | Type | Risk covered | Notify path |
|---|---|---|---|
| PAY.JP status page | Atlassian Statuspage | Payment provider incident / API degradation | MonitoRSS → Discord |
| Discord status page | Atlassian Statuspage | OAuth / webhook / CDN incident | MonitoRSS → Discord (or `/slack` trick if tenant exposes Slack tab) |
| Let's Encrypt status | status.io | CA outage affecting cert issuance/renewal | MonitoRSS → Discord |
| CT log (`crt.sh`) | Atom feed | Unauthorized certificate issuance for `and--line.com` | **Skipped** (see [Decision log](#decision-log)) |

### Domain-level

| Source | Type | Risk covered | Notify path |
|---|---|---|---|
| DNS CAA record | `and--line.com` | First-line defense against misissuance | Static DNS config (no runtime alert) |
| Domain expiry | whois polling | Registrar auto-renew failure → domain loss | Internal `HOST_DOMAIN_EXPIRING` alert, see [`alerts.md`](alerts.md) |

Constraint: solo operator cannot triage multi-channel noise. Email is not monitored. All active alerts route to a single Discord channel (`#payjp-ops-alerts`) via its webhook.

## Channel architecture

```
 Layer ① Internal (on-VPS)
 ┌──────────────────────────┐
 │ payjp-ops (check-host /  │──→ alerts / normal webhooks (systemd-creds encrypted)
 │  docker / nginx / app /  │       ├── critical / warn  → #payjp-ops-alerts
 │  db, every 5 min)        │       └── RESOLVED / digest → #payjp-ops-normal
 └──────────────────────────┘

 Layer ② Outbound silence (off-VPS SaaS, catches VPS total loss)
 ┌──────────────────────────┐
 │ cron: curl hc-ping.com/  │──→ Healthchecks.io ─→ (silence > 15 min) ─→ Discord native
 │ <uuid> every 5 min       │                                                  │
 └──────────────────────────┘                                                  ↓
                                                                         #payjp-ops-alerts
 Layer ③ Inbound reachability (off-VPS external probe)
 ┌──────────────────────────┐
 │ HetrixTools (3 regions,  │──→ https://api.and--line.com/health ─→ Discord native
 │  1 min, keyword "ok")    │                                                  │
 └──────────────────────────┘                                                  ↓
                                                                         #payjp-ops-alerts

 Upstream / third-party status pages
 ┌──────────────────────────┐
 │ PAY.JP status (RSS)      │──┐
 │ Discord status (RSS)     │──┼─→ MonitoRSS ──→ Discord webhook ──→ #payjp-ops-alerts
 │ Let's Encrypt (RSS)      │──┘                  (3 feeds)
 └──────────────────────────┘

 Domain-level
 ┌──────────────────────────┐
 │ HOST_DOMAIN_EXPIRING     │──→ payjp-ops check-host.sh ─→ alerts webhook (encrypted)
 └──────────────────────────┘
```

MonitoRSS / HC.io / HetrixTools all run off-VPS. No VPS dependency — if the VPS is down, external monitoring is unaffected (and in fact Layers ② and ③ detect the outage).

## Per-source configuration

### Healthchecks.io (Layer ② — outbound silence)

| Property | Value |
|---|---|
| Check UUID | `0315d31e-d89c-4a07-a2cf-934d32743e09` |
| Period | 5 min (heartbeat expected every 5 min) |
| Grace | 10 min (alert if silent > 15 min total) |
| Heartbeat owner | `payjp-ops` user crontab (NOT `ubuntu` — aligns with other ops scheduling) |
| Discord integration | HC.io native Discord (no `/slack` trick needed) |

Crontab entry (set via `sudo crontab -u payjp-ops -e`):

```cron
*/5 * * * * curl -fsS -m 10 --retry 3 https://hc-ping.com/0315d31e-d89c-4a07-a2cf-934d32743e09 > /dev/null 2>&1
```

**Why Layer ②**: internal `payjp-ops` checks cannot fire if the VPS is powered off, kernel-panicked, or has total outbound NW failure. HC.io fires on silence — the absence of heartbeats itself is the signal.

**Failure mode — heartbeat owner drift**: if the cron entry gets installed under `ubuntu` (or any other user), it still reaches HC.io, but violates the `payjp-ops` scheduling convention (memory: `reference_payjp_ops_infrastructure.md`). Always keep under `payjp-ops`:

```bash
sudo crontab -u payjp-ops -l    # verify entry present
sudo crontab -u ubuntu -l       # verify empty (or no HC.io entry)
```

### HetrixTools (Layer ③ — inbound external)

| Property | Value |
|---|---|
| Monitor name | `payjp-api-health` |
| URL | `https://api.and--line.com/health` |
| Type | HTTP(s) keyword |
| Keyword | `ok` (literal, no quotes) |
| Keyword Match | Must exist |
| Frequency | 1 min |
| Probe regions | San Francisco / London / Tokyo (3 regions, default free tier spread) |
| SSL Monitoring | Enabled (covers cert expiry from external vantage point — complements internal `HOST_TLS_EXPIRING`) |
| Contact List | `discord-ops-external` (Discord native webhook, no `/slack` trick needed) |
| Tier | Free (15 monitors / 1-min interval, no credit card required) |

**URL trap — use `api.` not `www.`**: `/health` is defined only in the `api.and--line.com` nginx server block (`nginx/nginx.conf:239`). `https://www.and--line.com/health` falls through to the SPA `index.html` fallback (`nginx.conf:186`), which returns HTML 200 without the `ok` keyword, causing **permanent false-Down**. Correct URL is `https://api.and--line.com/health`. Body: `{"status":"ok"}` (15 bytes JSON). Implementation: `packages/server/src/app.ts:94`.

**Keyword quoting trap**: HetrixTools keyword parser treats a leading `"` as a literal char that rarely matches. Using `"status":"ok"` as the keyword triggers continuous `keyword not found` → Down. Using `ok` alone works. The `/health` response cannot produce `ok` on a real error (any 5xx/error page contains different text), so false-positive Up risk is negligible.

**Verifying probe hits**: nginx access log is not visible via `docker logs payjp-nginx-1` (alpine image replaces `/var/log/nginx/*.log` stdout symlinks with real files at entrypoint — see memory: `reference_nginx_alpine_log_pipeline.md`). Use `docker exec`:

```bash
sudo docker exec payjp-nginx-1 tail -n 3000 /var/log/nginx/access.log | grep 'HetrixTools'
```

Expected: ~30 hits in 10 min (3 regions × 10 checks).

**Why Layer ③**: HC.io still receives heartbeats (outbound OK) even when inbound is broken — e.g., UFW misconfiguration, CF proxy routing error, TLS chain invalidation, BGP hijack, region-specific routing failure. Only an external probe actually fetching the health URL can detect these.

### PAY.JP status page

| Property | Value |
|---|---|
| URL | https://status.pay.jp/ |
| Platform | Atlassian Statuspage |
| Slack tab exposed | **No** — MonitoRSS required |
| RSS feed | `https://status.pay.jp/history.rss` |
| MonitoRSS feed name | `PAY.JP Status` |
| Target channel | `#payjp-ops-alerts` |

### Discord status page

| Property | Value |
|---|---|
| URL | https://discordstatus.com/ |
| Platform | Atlassian Statuspage |
| Slack tab exposed | Yes (but we use MonitoRSS for uniformity) |
| RSS feed | `https://discordstatus.com/history.rss` |
| MonitoRSS feed name | `Discord Status` |
| Target channel | `#payjp-ops-alerts` |

### Let's Encrypt status page

| Property | Value |
|---|---|
| URL | https://letsencrypt.status.io/ |
| Platform | status.io (different from Atlassian — no Slack tab) |
| MonitoRSS feed | taken from the Subscribe modal's RSS/Atom URL |
| Target channel | `#payjp-ops-alerts` |

### MonitoRSS setup (one-time)

1. Visit https://monitorss.xyz/ → **Login with Discord**
2. Invite bot to the Discord server containing `#payjp-ops-alerts`
3. Dashboard → **Add Feed** × 3 (one per source above)
4. Refresh rate: 10 minutes (free tier)

Initial subscribe may backfill existing incidents — tolerate the one-time flood.

### Discord webhook `/slack`-compatible endpoint

Atlassian Statuspage "Subscribe via Slack" can post to Discord by appending `/slack` to any Discord webhook URL:

```
https://discord.com/api/webhooks/<id>/<token>/slack
```

The Slack-formatted payload (`text` / `attachments` / `blocks`) is auto-converted to a Discord embed. Appending `/slack` is mandatory — omitting it silently fails with a 400.

Use this when a service offers Slack webhook integration but not Discord webhook. PAY.JP status does **not** expose a Slack tab, so MonitoRSS is required; Discord status does, so either path works.

## DNS CAA record

`and--line.com` restricts which CAs may issue certificates. Current state (inspect with `dig CAA and--line.com +short`):

- `letsencrypt.org` (issue + issuewild) — operator-added, for VPS certbot
- `pki.goog`, `comodoca.com`, `digicert.com`, `ssl.com` (with SXG parameters) — **auto-added by Cloudflare** for Universal SSL / Advanced Certificates on proxied subdomains (e.g., `admin.and--line.com` via CF Tunnel)

**Do not delete the Cloudflare-added entries.** They are required for CF edge certificate renewal on any proxied domain. Deleting them will break edge cert issuance at next renewal (silent until the cert expires).

See: https://developers.cloudflare.com/ssl/edge-certificates/caa-records/#caa-records-added-by-cloudflare

## Domain expiry monitoring

Implemented as `HOST_DOMAIN_EXPIRING` in `scripts/ops/check-host.sh:check_domain`. Full runbook in [`alerts.md`](alerts.md).

- Source: `whois Registry Expiry Date` for `$DOMAINS_TO_MONITOR`
- Threshold: `DOMAIN_DAYS_CRITICAL=30` (aligns with Cloudflare Registrar's auto-renew window)
- Cadence: every 5 minutes via `payjp-ops-check.timer` (same tick as other host checks)
- Cooldown: 86400 s (one alert per day maximum)
- Also surfaces in daily digest `Domain` field

Cloudflare Registrar auto-renews ~30 days before expiry. A `HOST_DOMAIN_EXPIRING` alert means auto-renew did not complete — check CF dashboard → Registrar → payment method validity.

## Decision log

| Decision | Rationale |
|---|---|
| Email-based subscriptions not used | Operator does not monitor email — all alerts must reach Discord |
| All external feeds to single channel (`#payjp-ops-alerts`) | Solo operator: multi-channel triage adds noise without value |
| 3-layer liveness (internal + HC.io + HetrixTools), not single-layer | Each layer has blind spots the others cover; user correction of an initial "HC.io alone is enough" proposal |
| HetrixTools over Better Stack for Layer ③ | Better Stack free tier dropped outgoing webhooks (paid-only since 2025); Discord native integration was also deprecated. HetrixTools free tier still offers both |
| HetrixTools over UptimeRobot | UptimeRobot free tier restricted webhook/Discord/Slack integration to Team / Enterprise since 2025 |
| LINE Notify not considered | Service shut down 2025-03. LINE Messaging API requires a bot registration and ongoing management — overhead not justified for solo operator |
| MonitoRSS over self-hosted poller | No VPS dependency (independent availability); free tier sufficient for 3 feeds |
| CT log monitoring skipped | MonitoRSS free-tier slot used for higher-signal sources; CAA provides first-line defense; MVP blocker does not depend on CT log |
| CAA set to `letsencrypt.org` only (operator-added) | Minimize CA surface beyond what CF auto-injects; over-permissive CAA is equivalent to no CAA |
| CF auto-added CAA entries retained | Removal breaks CF edge cert renewal on proxied subdomains (`admin.and--line.com` via Tunnel) — structural trade-off of CF proxy use |
| Domain expiry via whois polling (not CF API) | Registrar-agnostic; future registrar change does not require monitoring rewrite |
| `DOMAIN_DAYS_CRITICAL=30` | Matches CF Registrar's ~30 d auto-renew window → alert fires only when auto-renew failed |
| HC.io heartbeat cron under `payjp-ops` user (not `ubuntu`) | Aligns with ops scheduling convention (memory: `reference_payjp_ops_infrastructure.md`); separates operational cron from interactive user |
| HetrixTools keyword `ok` (not `"status":"ok"`) | Hetrix keyword parser fails to match keywords containing a leading `"`; `ok` is unambiguous in the `/health` response body |

## Adding a new external source

1. Check whether the source offers a **native Discord webhook integration** → use it directly.
2. If not, check whether it exposes a **Slack webhook field** → append `/slack` to the Discord webhook URL and paste there.
3. If neither, look for an **RSS/Atom feed** → add as a MonitoRSS feed in the existing Discord server.
4. If none of the above, consider a custom poller in `payjp-ops` (same pattern as `check_domain`).

Always confirm delivery: after subscribing, wait for the first test or regular post to appear in `#payjp-ops-alerts` before trusting the pipeline.

## Failure modes & gotchas

| Symptom | Likely cause | Fix |
|---|---|---|
| HC.io Down alert but VPS is up | Heartbeat cron removed / `payjp-ops` user locked / outbound NW blocked | `sudo crontab -u payjp-ops -l` to verify entry; `curl -v https://hc-ping.com/...` to test manually |
| HC.io alerts duplicated from two cron entries | Heartbeat was added to both `ubuntu` and `payjp-ops` crontabs during migration | `sudo crontab -u ubuntu -l` must not contain the hc-ping line; remove with `sudo crontab -u ubuntu -r` if it does (after confirming it is the only entry) |
| HetrixTools Down but health check returns 200 in a browser | Keyword mismatch (e.g. keyword set to `"status":"ok"` — Hetrix parser fails on leading `"`) | Change keyword to `ok`; the literal response `{"status":"ok"}` contains it |
| HetrixTools probes shown but `docker logs payjp-nginx-1` is empty | Normal behavior — alpine nginx image uses real log files, not stdout symlinks (`reference_nginx_alpine_log_pipeline.md`) | Verify with `sudo docker exec payjp-nginx-1 tail /var/log/nginx/access.log` |
| HetrixTools permanently Down on what looks like the right URL | Using `www.and--line.com/health` (SPA fallback 200 without keyword) instead of `api.and--line.com/health` | Change URL to `api.` subdomain |
| Slack-webhook subscribe submits but no delivery | Forgot `/slack` suffix on Discord webhook URL | Re-edit subscription URL to end in `/slack` |
| MonitoRSS feed shows errors | Feed URL 404 / malformed / rate-limited | Verify feed URL in a browser; try Atom alternative if RSS fails |
| CAA wizard adds many CAs when only LE is wanted | Cloudflare auto-injects its partner CAs on any CAA change | Retain auto-added entries; remove only operator-added duplicates (e.g., trailing-space variants) |
| `HOST_DOMAIN_EXPIRING` fires on a 1-year-old domain | `whois` returned parseable expiry < 30 d, real scenario | Check CF Registrar payment method immediately; do not increase threshold as workaround |
| `HOST_DOMAIN_EXPIRING` never fires in testing | Env-var override of `DOMAIN_DAYS_CRITICAL` is squashed by `source lib/thresholds.conf` | Edit `thresholds.conf` inline, run, revert (see test matrix row 10b in `alerts.md`) |
| PAY.JP status incident posted but no Discord message | MonitoRSS refresh (10 min free tier) not yet triggered | Wait one cycle; if persistently missing, check MonitoRSS dashboard feed health |

## Related

- [`alerts.md`](alerts.md) — internal alert codes, thresholds, runbook, test matrix
- [`admin-access-cloudflare.md`](admin-access-cloudflare.md) — CF Access + Tunnel for admin plane (the main consumer of CF edge certificates that CAA auto-add protects)
- `scripts/ops/check-host.sh:check_domain` — `HOST_DOMAIN_EXPIRING` implementation
- `scripts/ops/daily-digest.sh:gather_domain` — digest Domain field
