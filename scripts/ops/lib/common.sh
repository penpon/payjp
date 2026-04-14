#!/usr/bin/env bash
# Shared helpers for payjp-ops scripts. Source this — do NOT execute.
# Invariants:
#   - Never `set -x` (would leak webhook URL). ops_strict_mode enforces `set +x`.
#   - log_json emits single-line JSON to stderr so systemd-journald captures structured output.

ops_strict_mode() {
  set -euo pipefail
  set +x
  IFS=$' \t\n'
}

ts_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

log_json() {
  local level="$1" message="$2"
  shift 2
  local extras=""
  while (( $# >= 2 )); do
    extras+=",\"$1\":\"$(json_escape "$2")\""
    shift 2
  done
  printf '{"timestamp":"%s","level":"%s","service":"payjp-ops","message":"%s"%s}\n' \
    "$(ts_utc)" "$level" "$(json_escape "$message")" "$extras" >&2
}

log_info() { log_json info "$@"; }
log_warn() { log_json warn "$@"; }
log_error() { log_json error "$@"; }

get_nproc() {
  nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo
}

# Discord embed color decimals.
severity_color() {
  case "$1" in
    critical) echo 15158332 ;;
    warn)     echo 15844367 ;;
    normal)   echo 3066993 ;;
    *)        echo 9807270 ;;
  esac
}

# Run a function/cmd; log and swallow non-zero exit so one failing check
# never aborts the full tick.
safe() {
  if ! "$@"; then
    local rc=$?
    log_warn "check wrapper caught error" "cmd" "$1" "exit" "$rc"
    return 0
  fi
}
