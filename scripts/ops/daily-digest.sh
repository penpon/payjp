#!/usr/bin/env bash
# Daily digest — posted 09:00 JST. Always fires (schedule-driven), not gated by dedup.
# Aggregates: 3 KPI (24h) · backup · host · TLS · domain · docker · fail2ban · recent alerts.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
ops_strict_mode
# shellcheck source=lib/thresholds.conf
source "$SCRIPT_DIR/lib/thresholds.conf"
# shellcheck source=lib/dedup.sh
source "$SCRIPT_DIR/lib/dedup.sh"
# shellcheck source=lib/op-webhook.sh
source "$SCRIPT_DIR/lib/op-webhook.sh"
ops_state_init

: "${COMPOSE_PROJECT:=payjp}"
: "${BACKUP_DIR:=/var/backups/payjp-db}"
: "${HEALTH_URL:=https://api.and--line.com/health}"
: "${NGINX_VOLUME:=payjp_nginx_logs}"

psql_q() {
  local sql="$1"
  [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_DB:-}" ]] && { echo "?"; return 0; }
  sudo -n docker exec "${COMPOSE_PROJECT}-db-1" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$sql" 2>/dev/null || echo "?"
}

gather_kpi() {
  local wf impact api_5xx nginx_dir cutoff
  wf=$(psql_q "SELECT count(*) FROM payjp_events WHERE process_status='failed' AND received_at > now() - interval '24 hours'")
  impact=$(psql_q "SELECT count(*) FROM member_impact_logs WHERE resolved_at IS NULL")
  api_5xx="?"
  nginx_dir=$(sudo -n docker volume inspect --format '{{.Mountpoint}}' "$NGINX_VOLUME" 2>/dev/null) || nginx_dir=""
  if [[ -n "$nginx_dir" ]]; then
    cutoff=$(date -d '-24 hours' +%s)
    api_5xx=$(sudo -n tail -n 50000 "$nginx_dir/access.log" 2>/dev/null | \
      jq -rc --argjson c "$cutoff" '
        select(.time != null) | select((.time | fromdateiso8601) >= $c) | .status
      ' 2>/dev/null | awk '$0+0 >= 500' | wc -l)
    [[ -z "$api_5xx" ]] && api_5xx=0
  fi
  printf 'webhook failed: %s · api 5xx: %s · unresolved impact: %s' "${wf:-?}" "${api_5xx}" "${impact:-?}"
}

gather_backup() {
  local latest
  latest=$(ls -1t "$BACKUP_DIR"/payjp_*.sql.gz 2>/dev/null | head -1)
  if [[ -z "$latest" ]]; then
    printf 'no backup found in %s' "$BACKUP_DIR"
    return
  fi
  local mtime age_h size_mb file
  mtime=$(sudo -n stat -c %Y "$latest" 2>/dev/null || stat -c %Y "$latest" 2>/dev/null || echo 0)
  age_h=$(( ( $(date +%s) - mtime ) / 3600 ))
  local size
  size=$(sudo -n stat -c %s "$latest" 2>/dev/null || stat -c %s "$latest" 2>/dev/null || echo 0)
  size_mb=$(awk -v s="$size" 'BEGIN {printf "%.1f", s/1048576}')
  file=$(basename "$latest")
  printf 'last: %dh ago · size: %sMB · file: %s' "$age_h" "$size_mb" "$file"
}

gather_offsite() {
  # Bucket size probe requires B2_DRILL creds loaded via LoadCredentialEncrypted
  # in payjp-ops-digest.service (not wired into the hourly check service).
  local state_d="${OPS_STATE_DIR:-/var/lib/payjp-ops}/state.d"
  local offsite_part="last: never" drill_part=" · drill: never" quota_part=""
  local stamp
  stamp=$(cat "$state_d/offsite-last-success.epoch" 2>/dev/null || true)
  if [[ "$stamp" =~ ^[0-9]+$ ]]; then
    offsite_part="last: $(( ( $(date +%s) - stamp ) / 3600 ))h ago"
  fi
  stamp=$(cat "$state_d/restore-drill-last-success.epoch" 2>/dev/null || true)
  if [[ "$stamp" =~ ^[0-9]+$ ]]; then
    drill_part=" · drill: $(( ( $(date +%s) - stamp ) / 86400 ))d ago"
  fi
  # Bucket size probe (cheap: 1 list call/day). If creds are not loaded we
  # surface "unprobed"; if probe fails we surface "probe-failed" rather than
  # silently dropping the segment — silent drop would mask a B2 outage.
  if [[ ! -r "${CREDENTIALS_DIRECTORY:-/nonexistent}/B2_DRILL_KEY_ID" ]]; then
    quota_part=" · bucket: unprobed"
  else
    local bytes
    if bytes=$(/opt/payjp-ops/bin/b2-quota-check.sh 2>/dev/null) && [[ "$bytes" =~ ^[0-9]+$ ]]; then
      quota_part=" · bucket: $(awk -v b="$bytes" 'BEGIN {printf "%.1f", b/1048576}')MB"
    else
      quota_part=" · bucket: probe-failed"
    fi
  fi
  printf '%s%s%s' "$offsite_part" "$drill_part" "$quota_part"
}

gather_host() {
  local root_pct varlog_pct backups_pct load5 uptime_days
  root_pct=$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
  varlog_pct=$(df -P /var/log | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
  backups_pct=$(df -P "$BACKUP_DIR" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}' || echo "?")
  load5=$(awk '{print $2}' /proc/loadavg)
  uptime_days=$(awk '{printf "%d", $1/86400}' /proc/uptime)
  printf 'disk /: %s%% · /var/log: %s%% · backups: %s%% · load5: %s · uptime: %sd' \
    "$root_pct" "$varlog_pct" "$backups_pct" "$load5" "$uptime_days"
}

gather_tls() {
  local cert list=""
  for cert in $CERT_PATHS; do
    local enddate end_epoch days domain
    enddate=$(sudo -n openssl x509 -enddate -noout -in "$cert" 2>/dev/null | sed 's/notAfter=//') || continue
    end_epoch=$(date -d "$enddate" +%s 2>/dev/null) || continue
    days=$(( (end_epoch - $(date +%s)) / 86400 ))
    domain=$(basename "$(dirname "$cert")")
    list+="${domain}: ${days}d · "
  done
  [[ -z "$list" ]] && list="(no readable certs)"
  printf '%s' "${list%· }"
}

gather_domain() {
  local domain list=""
  for domain in $DOMAINS_TO_MONITOR; do
    local raw expiry epoch days
    raw=$(timeout 10 whois "$domain" 2>/dev/null) || { list+="${domain}: ? · "; continue; }
    expiry=$(printf '%s\n' "$raw" | awk -F': +' '/Registry Expiry Date/ {print $2; exit}')
    [[ -z "$expiry" ]] && \
      expiry=$(printf '%s\n' "$raw" | awk -F': +' '/Registrar Registration Expiration Date/ {print $2; exit}')
    if [[ -z "$expiry" ]] || ! epoch=$(date -d "$expiry" +%s 2>/dev/null); then
      list+="${domain}: ? · "
      continue
    fi
    days=$(( (epoch - $(date +%s)) / 86400 ))
    list+="${domain}: ${days}d · "
  done
  [[ -z "$list" ]] && list="(no domains configured)"
  printf '%s' "${list%· }"
}

gather_docker() {
  local up=0 total=0 db_health="?"
  local svc container state
  for svc in db api admin-api nginx; do
    total=$(( total + 1 ))
    container="${COMPOSE_PROJECT}-${svc}-1"
    if state=$(sudo -n docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null); then
      [[ "$state" == "running" ]] && up=$(( up + 1 ))
    fi
    if [[ "$svc" == "db" ]]; then
      db_health=$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo "?")
    fi
  done
  printf '%d/%d running · db health: %s' "$up" "$total" "${db_health:-?}"
}

gather_fail2ban() {
  local report="" jail out banned
  for jail in $FAIL2BAN_JAILS; do
    banned=0
    if out=$(sudo -n fail2ban-client status "$jail" 2>/dev/null); then
      banned=$(echo "$out" | awk -F'[ \t]+' '/Currently banned:/ {print $NF}')
      [[ -z "$banned" ]] && banned=0
    fi
    report+="${jail}: ${banned} · "
  done
  printf '%s' "${report%· }"
}

gather_alerts_24h() {
  local recent lines
  recent=$(list_recent_alerts 86400 2>/dev/null || true)
  if [[ -z "$recent" ]]; then
    echo "none"
    return
  fi
  lines=$(echo "$recent" | head -n 8 | while read -r mtime code; do
    local ts
    ts=$(TZ=Asia/Tokyo date -d "@$mtime" +%H:%M 2>/dev/null)
    printf -- "- %s JST · %s\n" "$ts" "$code"
  done)
  [[ -z "$lines" ]] && echo "none" || printf '%s' "$lines"
}

TITLE="PAY.JP 日次サマリ — $(TZ=Asia/Tokyo date +'%Y-%m-%d (JST)')"
KPI=$(gather_kpi)
BACKUP=$(gather_backup)
OFFSITE=$(gather_offsite)
HOST=$(gather_host)
TLS=$(gather_tls)
DOMAIN=$(gather_domain)
DOCKER_INFO=$(gather_docker)
FAIL2BAN=$(gather_fail2ban)
ALERTS_24H=$(gather_alerts_24h)

PAYLOAD=$(jq -cn \
  --arg title "$TITLE" \
  --argjson color 3066993 \
  --arg kpi "$KPI" \
  --arg backup "$BACKUP" \
  --arg offsite "$OFFSITE" \
  --arg host "$HOST" \
  --arg tls "$TLS" \
  --arg domain "$DOMAIN" \
  --arg docker "$DOCKER_INFO" \
  --arg fail2ban "$FAIL2BAN" \
  --arg alerts "$ALERTS_24H" \
  '{
    username: "payjp-ops-normal",
    embeds: [{
      title: $title,
      color: $color,
      fields: [
        {name: "KPI（直近24時間）",              value: $kpi,      inline: false},
        {name: "バックアップ（ローカル）",       value: $backup,   inline: true},
        {name: "バックアップ（オフサイトB2）",   value: $offsite,  inline: true},
        {name: "ホスト",                         value: $host,     inline: true},
        {name: "TLS 証明書",                     value: $tls,      inline: true},
        {name: "ドメイン",                       value: $domain,   inline: true},
        {name: "Docker",                         value: $docker,   inline: true},
        {name: "fail2ban（現在BAN中）",          value: $fail2ban, inline: true},
        {name: "発火アラート（直近24h）",        value: $alerts,   inline: false}
      ]
    }]
  }')

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  printf '%s\n' "$PAYLOAD"
  exit 0
fi

if ! URL=$(get_webhook_url normal); then
  log_discord_ops_webhook_unavailable normal
  exit 1
fi

if curl --silent --show-error --fail-with-body \
     --max-time 10 \
     -H "Content-Type: application/json" \
     -X POST \
     -d "$PAYLOAD" \
     "$URL" \
     2> >(sed 's#https://discord[^ ]*#[WEBHOOK]#g' >&2) \
     >/dev/null; then
  log_info "digest posted"
else
  log_error "digest POST failed" "exit" "$?"
  exit 1
fi
