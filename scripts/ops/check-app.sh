#!/usr/bin/env bash
# Web-app + DB signals.
# Codes: APP_HEALTH_FAIL · APP_HEALTH_SLOW · DB_PING ·
#        APP_PAYJP_EVENTS_FAILED · APP_IMPACT_LOGS_OPEN ·
#        APP_INFLIGHT_STUCK_WARN · APP_INFLIGHT_STUCK_CRIT · DB_BACKUP_STALE

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

: "${HEALTH_URL:=https://api.and--line.com/health}"
: "${BACKUP_DIR:=/var/backups/payjp-db}"
: "${COMPOSE_PROJECT:=payjp}"

# Scalar query helper. Returns "?" on skip/err so callers can still log.
psql_q() {
  local sql="$1"
  if [[ -z "${POSTGRES_USER:-}" || -z "${POSTGRES_DB:-}" ]]; then
    log_warn "POSTGRES_USER/POSTGRES_DB unset; DB check skipped"
    return 1
  fi
  sudo -n docker exec "${COMPOSE_PROJECT}-db-1" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$sql" 2>/dev/null
}

check_health() {
  local curl_out http_code total_time tmp
  tmp=$(mktemp)
  if ! curl_out=$(curl -sS -m "${APP_HEALTH_TIMEOUT:-3}" \
        -o "$tmp" \
        -w '%{http_code} %{time_total}' \
        "$HEALTH_URL" 2>&1); then
    rm -f "$tmp"
    handle APP_HEALTH_FAIL critical fire \
      "/health request failed" \
      "URL: ${HEALTH_URL}
curl error: ${curl_out}"
    return
  fi
  rm -f "$tmp"
  http_code=$(echo "$curl_out" | awk '{print $1}')
  total_time=$(echo "$curl_out" | awk '{print $2}')
  if [[ "$http_code" != "200" ]]; then
    handle APP_HEALTH_FAIL critical fire \
      "/health returned HTTP ${http_code}" \
      "URL: ${HEALTH_URL}
status: ${http_code}"
    return
  fi
  handle APP_HEALTH_FAIL critical clear "" "/health 200 in ${total_time}s"
  if awk -v t="$total_time" -v limit="${APP_HEALTH_SLOW_SEC:-3.0}" 'BEGIN {exit !(t > limit)}'; then
    handle APP_HEALTH_SLOW warn fire \
      "/health slow: ${total_time}s" \
      "Threshold: ${APP_HEALTH_SLOW_SEC}s"
  else
    handle APP_HEALTH_SLOW warn clear "" "/health ${total_time}s"
  fi
}

check_db_ping() {
  local out
  if out=$(psql_q 'SELECT 1' 2>&1) && [[ "$out" == "1" ]]; then
    handle DB_PING critical clear "" "db ping OK"
  else
    handle DB_PING critical fire \
      "db ping failed" \
      "Query 'SELECT 1' via ${COMPOSE_PROJECT}-db-1 failed.
Output: ${out:-(empty)}"
  fi
}

check_payjp_events_failed() {
  local cnt
  cnt=$(psql_q "SELECT count(*) FROM payjp_events WHERE processing_result='failed' AND received_at > now() - interval '1 hour'") || return 0
  if (( cnt > APP_PAYJP_EVENTS_FAILED_PER_1H )); then
    handle APP_PAYJP_EVENTS_FAILED critical fire \
      "payjp_events failed: ${cnt} in last 1h" \
      "Threshold: ${APP_PAYJP_EVENTS_FAILED_PER_1H}
Inspect: SELECT event_type, received_at, payload->>'_processing' FROM payjp_events
         WHERE processing_result='failed' ORDER BY received_at DESC LIMIT 10;"
  else
    handle APP_PAYJP_EVENTS_FAILED critical clear "" "payjp_events failed=${cnt}/1h"
  fi
}

check_impact_logs() {
  local cnt
  cnt=$(psql_q 'SELECT count(*) FROM member_impact_logs WHERE resolved_at IS NULL') || return 0
  if (( cnt > APP_IMPACT_LOGS_OPEN )); then
    handle APP_IMPACT_LOGS_OPEN warn fire \
      "unresolved member_impact_logs: ${cnt}" \
      "Threshold: ${APP_IMPACT_LOGS_OPEN}
Inspect: SELECT issue_code, count(*) FROM member_impact_logs
         WHERE resolved_at IS NULL GROUP BY issue_code ORDER BY 2 DESC;
Resolve: see docs/ops/resync-cli.md"
  else
    handle APP_IMPACT_LOGS_OPEN warn clear "" "unresolved impact_logs=${cnt}"
  fi
}

check_inflight() {
  local cnt_warn cnt_crit
  cnt_warn=$(psql_q "SELECT count(*) FROM members WHERE inflight_operation_started_at IS NOT NULL AND inflight_operation_started_at < now() - interval '${APP_INFLIGHT_WARN_MIN} minutes'") || return 0
  cnt_crit=$(psql_q "SELECT count(*) FROM members WHERE inflight_operation_started_at IS NOT NULL AND inflight_operation_started_at < now() - interval '${APP_INFLIGHT_CRIT_HOUR} hours'") || return 0
  if (( cnt_crit >= 1 )); then
    handle APP_INFLIGHT_STUCK_CRIT critical fire \
      "inflight operation stuck > ${APP_INFLIGHT_CRIT_HOUR}h: ${cnt_crit} member(s)" \
      "Run: npm run resync -- --operation-id <id>  (docs/ops/resync-cli.md)"
  else
    handle APP_INFLIGHT_STUCK_CRIT critical clear "" "no inflight > ${APP_INFLIGHT_CRIT_HOUR}h"
  fi
  if (( cnt_warn >= 1 )); then
    handle APP_INFLIGHT_STUCK_WARN warn fire \
      "inflight stuck > ${APP_INFLIGHT_WARN_MIN}min: ${cnt_warn} member(s)" \
      "Early warning; escalates to critical at ${APP_INFLIGHT_CRIT_HOUR}h."
  else
    handle APP_INFLIGHT_STUCK_WARN warn clear "" "no inflight > ${APP_INFLIGHT_WARN_MIN}min"
  fi
}

check_backup_stale() {
  local latest mtime age_sec age_h threshold_sec
  latest=$(ls -1t "$BACKUP_DIR"/payjp_*.sql.gz 2>/dev/null | head -1)
  if [[ -z "$latest" ]]; then
    handle DB_BACKUP_STALE critical fire \
      "no backup file found in ${BACKUP_DIR}" \
      "Run scripts/ops/backup-db.sh (or: sudo systemctl start payjp-ops-backup.service)"
    return
  fi
  if ! mtime=$(sudo -n stat -c %Y "$latest" 2>/dev/null); then
    mtime=$(stat -c %Y "$latest" 2>/dev/null) || { log_warn "cannot stat backup" "file" "$latest"; return; }
  fi
  age_sec=$(( $(date +%s) - mtime ))
  age_h=$(( age_sec / 3600 ))
  threshold_sec=$(( DB_BACKUP_STALE_HOURS * 3600 ))
  if (( age_sec > threshold_sec )); then
    handle DB_BACKUP_STALE critical fire \
      "latest backup is ${age_h}h old" \
      "File: ${latest}
Threshold: ${DB_BACKUP_STALE_HOURS}h
Check cron: journalctl --since -48h | grep backup"
  else
    handle DB_BACKUP_STALE critical clear "" "latest backup ${age_h}h old"
  fi
}

safe check_health
safe check_db_ping
safe check_payjp_events_failed
safe check_impact_logs
safe check_inflight
safe check_backup_stale
