#!/usr/bin/env bash
# Nginx-layer signals.
# Codes: NGINX_5XX_BURST · NGINX_429_BURST · NGINX_UPSTREAM_SLOW · NGINX_ERRLOG_CRIT

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

: "${NGINX_VOLUME:=payjp_nginx_logs}"

resolve_nginx_dir() {
  sudo -n docker volume inspect --format '{{.Mountpoint}}' "$NGINX_VOLUME" 2>/dev/null
}

NGINX_DIR=$(resolve_nginx_dir || true)
if [[ -z "$NGINX_DIR" ]]; then
  log_warn "cannot resolve nginx log mountpoint" "volume" "$NGINX_VOLUME"
  exit 0
fi
ACCESS_LOG="${NGINX_DIR}/access.log"
ERROR_LOG="${NGINX_DIR}/error.log"

# Count JSON-log lines whose `.time` is within window_min minutes and whose
# `.status` falls in [min_st, max_st]. Silent on parse errors (mixed logs).
count_status_in_window() {
  local access="$1" window_min="$2" min_st="$3" max_st="${4:-999}"
  local cutoff
  cutoff=$(date -d "-${window_min} minutes" +%s)
  sudo -n tail -n 10000 "$access" 2>/dev/null | \
    jq -rc --argjson cutoff "$cutoff" '
      select(.time != null)
      | select((.time | fromdateiso8601) >= $cutoff)
      | .status
    ' 2>/dev/null | \
    awk -v mn="$min_st" -v mx="$max_st" '$0+0 >= mn+0 && $0+0 <= mx+0' | wc -l
}

check_5xx() {
  local cnt
  cnt=$(count_status_in_window "$ACCESS_LOG" 5 500 599)
  if (( cnt > NGINX_5XX_PER_5MIN )); then
    handle NGINX_5XX_BURST critical fire \
      "nginx 5xx burst: ${cnt} in 5 min" \
      "Threshold: ${NGINX_5XX_PER_5MIN}
Inspect: sudo tail -n 200 ${ACCESS_LOG} | jq 'select(.status>=500)'"
  else
    handle NGINX_5XX_BURST critical clear "" "5xx=${cnt}/5min"
  fi
}

check_429() {
  local cnt
  cnt=$(count_status_in_window "$ACCESS_LOG" 5 429 429)
  if (( cnt > NGINX_429_PER_5MIN )); then
    handle NGINX_429_BURST warn fire \
      "nginx 429 burst: ${cnt} in 5 min" \
      "Threshold: ${NGINX_429_PER_5MIN}. Rate-limit zones active."
  else
    handle NGINX_429_BURST warn clear "" "429=${cnt}/5min"
  fi
}

# p95 of .upstream_response_time over the last 200 samples (portable awk, no gawk).
p95_upstream() {
  sudo -n tail -n 200 "$ACCESS_LOG" 2>/dev/null | \
    jq -rc '
      select(.upstream_response_time != null and .upstream_response_time != "")
      | .upstream_response_time
    ' 2>/dev/null | \
    sort -n | \
    awk '
      NF > 0 { arr[NR] = $1 }
      END {
        if (NR == 0) exit
        idx = int(NR * 0.95)
        if (idx < 1) idx = 1
        if (idx > NR) idx = NR
        print arr[idx]
      }'
}

check_upstream_slow() {
  local p95
  p95=$(p95_upstream || echo "")
  if [[ -z "$p95" ]]; then
    return 0
  fi
  if awk -v p="$p95" -v t="$NGINX_UPSTREAM_P95_SEC" 'BEGIN {exit !(p > t)}'; then
    handle NGINX_UPSTREAM_SLOW warn fire \
      "nginx upstream p95=${p95}s" \
      "Threshold: ${NGINX_UPSTREAM_P95_SEC}s over last 200 samples."
  else
    handle NGINX_UPSTREAM_SLOW warn clear "" "upstream p95=${p95}s"
  fi
}

# Dedup via hash of last 5 matches — so we don't re-alert the same line set.
check_errlog_crit() {
  local lines matches hash_file new_hash last_hash sample
  if ! lines=$(sudo -n tail -n 200 "$ERROR_LOG" 2>/dev/null); then
    log_warn "cannot read nginx error.log" "path" "$ERROR_LOG"
    return 0
  fi
  matches=$(printf '%s\n' "$lines" | grep -E '\[(crit|alert|emerg)\]' || true)
  if [[ -z "$matches" ]]; then
    handle NGINX_ERRLOG_CRIT critical clear "" "no crit/alert/emerg in nginx error.log"
    return
  fi
  hash_file="$OPS_STATE_DIR/state.d/NGINX_ERRLOG_CRIT.hash"
  new_hash=$(printf '%s' "$matches" | tail -n 5 | sha1sum | cut -d' ' -f1)
  last_hash=""
  [[ -e "$hash_file" ]] && last_hash=$(cat "$hash_file")
  if [[ "$new_hash" != "$last_hash" ]]; then
    sample=$(printf '%s\n' "$matches" | tail -n 3)
    handle NGINX_ERRLOG_CRIT critical fire \
      "new nginx error.log crit/alert/emerg entry" \
      "$sample"
    printf '%s' "$new_hash" > "$hash_file"
  fi
}

safe check_5xx
safe check_429
safe check_upstream_slow
safe check_errlog_crit
