#!/usr/bin/env bash
# Linux host signals → payjp-ops Discord.
# Codes: HOST_DISK_{ROOT,VARLOG,BACKUPS} · HOST_LOAD_HIGH · HOST_OOM_KILL ·
#        HOST_REBOOT_REQUIRED · HOST_SWAP_HIGH · HOST_FAIL2BAN_SURGE · HOST_TLS_EXPIRING ·
#        HOST_DOMAIN_EXPIRING

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
ops_strict_mode
# shellcheck source=lib/thresholds.conf
source "$SCRIPT_DIR/lib/thresholds.conf"
# shellcheck source=lib/dedup.sh
source "$SCRIPT_DIR/lib/dedup.sh"
NOTIFY_SCRIPT="$SCRIPT_DIR/notify.sh"
export NOTIFY_SCRIPT
ops_state_init

check_disk() {
  local mount="$1" code="$2" severity="$3"
  local use
  use=$(df -P "$mount" 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
  if [[ -z "$use" ]]; then
    log_warn "disk mount not found" "mount" "$mount" "code" "$code"
    return 0
  fi
  if (( use > DISK_PCT )); then
    handle "$code" "$severity" fire \
      "disk ${mount}: ${use}%" \
      "Threshold: ${DISK_PCT}%
$(df -Ph "$mount" 2>&1)"
  else
    handle "$code" "$severity" clear "" "disk ${mount}=${use}% (threshold ${DISK_PCT}%)"
  fi
}

check_load() {
  local nproc_c load5 ratio_pct
  nproc_c=$(get_nproc)
  load5=$(awk '{print $2}' /proc/loadavg)
  # integer percent of load5/nproc — avoids floating-point branching
  ratio_pct=$(awk -v l="$load5" -v n="$nproc_c" 'BEGIN {printf "%d", (l/n)*100}')
  local threshold_pct=$(( LOAD5_X_NPROC * 100 ))
  local streak_file="$OPS_STATE_DIR/state.d/HOST_LOAD_HIGH.tickstreak"
  if (( ratio_pct > threshold_pct )); then
    local streak=0
    [[ -e "$streak_file" ]] && streak=$(cat "$streak_file")
    streak=$(( streak + 1 ))
    printf '%s' "$streak" > "$streak_file"
    if (( streak >= LOAD5_CONSECUTIVE_TICKS )); then
      handle HOST_LOAD_HIGH warn fire \
        "load5=${load5} on ${nproc_c} CPUs (${streak} consecutive ticks)" \
        "load5/${nproc_c} = ${ratio_pct}% > ${LOAD5_X_NPROC}×nproc threshold.
$(uptime)"
    fi
  else
    rm -f "$streak_file"
    handle HOST_LOAD_HIGH warn clear "" "load5=${load5} (${ratio_pct}% of ${LOAD5_X_NPROC}×nproc)"
  fi
}

check_oom() {
  local oom_count
  if ! oom_count=$(sudo -n journalctl -k --since '-24h' -g 'Killed process' --no-pager 2>/dev/null | wc -l); then
    log_warn "journalctl unavailable for OOM check"
    return 0
  fi
  if (( oom_count >= 1 )); then
    handle HOST_OOM_KILL critical fire \
      "OOM kill detected (${oom_count} in last 24h)" \
      "Run: sudo journalctl -k --since -24h -g 'Killed process'"
  else
    handle HOST_OOM_KILL critical clear "" "no OOM kills in last 24h"
  fi
}

check_reboot_required() {
  if [[ -e /var/run/reboot-required ]]; then
    local pkgs=""
    [[ -r /var/run/reboot-required.pkgs ]] && pkgs=$(cat /var/run/reboot-required.pkgs)
    handle HOST_REBOOT_REQUIRED warn fire \
      "reboot required (kernel/libc update)" \
      "Packages:
${pkgs:-unknown}"
  else
    handle HOST_REBOOT_REQUIRED warn clear "" "no pending reboot"
  fi
}

check_swap() {
  local total used pct
  read -r total used < <(free | awk '/^Swap:/ {print $2, $3}')
  if [[ -z "${total:-}" || "$total" == "0" ]]; then
    handle HOST_SWAP_HIGH warn clear "" "no swap configured"
    return 0
  fi
  pct=$(( used * 100 / total ))
  if (( pct > SWAP_PCT )); then
    handle HOST_SWAP_HIGH warn fire \
      "swap usage: ${pct}%" \
      "used=${used}KB total=${total}KB threshold=${SWAP_PCT}%"
  else
    handle HOST_SWAP_HIGH warn clear "" "swap ${pct}%"
  fi
}

check_fail2ban() {
  local total_banned=0 jail_report=""
  for jail in $FAIL2BAN_JAILS; do
    local out banned=0
    if out=$(sudo -n fail2ban-client status "$jail" 2>/dev/null); then
      banned=$(echo "$out" | awk -F'[ \t]+' '/Currently banned:/ {print $NF}')
      [[ -z "$banned" ]] && banned=0
    else
      log_warn "fail2ban-client failed" "jail" "$jail"
    fi
    total_banned=$(( total_banned + banned ))
    jail_report+="${jail}: ${banned} · "
  done
  if (( total_banned >= FAIL2BAN_BANNED_THRESHOLD )); then
    handle HOST_FAIL2BAN_SURGE warn fire \
      "fail2ban currently-banned aggregate: ${total_banned}" \
      "Threshold ${FAIL2BAN_BANNED_THRESHOLD}
${jail_report%· }"
  else
    handle HOST_FAIL2BAN_SURGE warn clear "" "${jail_report%· } (total ${total_banned})"
  fi
}

check_tls() {
  local cert any_found=0 min_days=999 worst_cert=""
  for cert in $CERT_PATHS; do
    local enddate end_epoch now days
    if ! enddate=$(sudo -n openssl x509 -enddate -noout -in "$cert" 2>/dev/null | sed 's/notAfter=//'); then
      log_warn "cannot read TLS cert" "path" "$cert"
      continue
    fi
    end_epoch=$(date -d "$enddate" +%s 2>/dev/null) || continue
    now=$(date +%s)
    days=$(( (end_epoch - now) / 86400 ))
    any_found=1
    if (( days < min_days )); then
      min_days=$days
      worst_cert=$cert
    fi
  done
  if (( any_found == 0 )); then
    log_warn "no readable TLS certs"
    return 0
  fi
  if (( min_days < TLS_DAYS_CRITICAL )); then
    handle HOST_TLS_EXPIRING critical fire \
      "TLS cert expires in ${min_days} days" \
      "Cert: ${worst_cert}
Renew: stop nginx, run certbot renew (standalone), restart nginx."
  else
    handle HOST_TLS_EXPIRING critical clear "" "min TLS days remaining: ${min_days} (${worst_cert})"
  fi
}

check_domain() {
  local domain any_found=0 min_days=99999 worst_domain=""
  for domain in $DOMAINS_TO_MONITOR; do
    local raw expiry expiry_epoch now days
    # 10s timeout — whois server unreachable must not stall the tick.
    if ! raw=$(timeout 10 whois "$domain" 2>/dev/null); then
      log_warn "whois timeout or failure" "domain" "$domain"
      continue
    fi
    # .com/.net (Verisign): "Registry Expiry Date"
    # Many gTLDs also expose "Registrar Registration Expiration Date" as fallback.
    expiry=$(printf '%s\n' "$raw" | awk -F': +' '/Registry Expiry Date/ {print $2; exit}')
    [[ -z "$expiry" ]] && \
      expiry=$(printf '%s\n' "$raw" | awk -F': +' '/Registrar Registration Expiration Date/ {print $2; exit}')
    if [[ -z "$expiry" ]]; then
      log_warn "whois expiry not parseable" "domain" "$domain"
      continue
    fi
    if ! expiry_epoch=$(date -d "$expiry" +%s 2>/dev/null); then
      log_warn "whois expiry date parse failed" "domain" "$domain" "raw" "$expiry"
      continue
    fi
    now=$(date +%s)
    days=$(( (expiry_epoch - now) / 86400 ))
    any_found=1
    if (( days < min_days )); then
      min_days=$days
      worst_domain=$domain
    fi
  done
  if (( any_found == 0 )); then
    log_warn "no parseable domain expiry — check skipped"
    return 0
  fi
  if (( min_days < DOMAIN_DAYS_CRITICAL )); then
    handle HOST_DOMAIN_EXPIRING critical fire \
      "domain ${worst_domain} expires in ${min_days} days" \
      "Threshold: ${DOMAIN_DAYS_CRITICAL}d
Cloudflare Registrar normally auto-renews ~30d before expiry; this alert means renewal did not complete.
Action: dashboard → Registrar → verify auto-renew ON + payment method valid."
  else
    handle HOST_DOMAIN_EXPIRING critical clear "" "min domain days remaining: ${min_days} (${worst_domain})"
  fi
}

safe check_disk /                       HOST_DISK_ROOT    critical
safe check_disk /var/log                HOST_DISK_VARLOG  warn
safe check_disk "$BACKUP_DIR"           HOST_DISK_BACKUPS critical
safe check_load
safe check_oom
safe check_reboot_required
safe check_swap
safe check_fail2ban
safe check_tls
safe check_domain
