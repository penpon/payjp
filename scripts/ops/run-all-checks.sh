#!/usr/bin/env bash
# Entry point invoked by payjp-ops-check.service every 5 min.
# Each phase adds a check script; missing scripts are silently skipped.

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

# Shared TICK_ID for storm counting across all check-*.sh invocations in this run.
TICK_ID=$(date +%s)
export TICK_ID
ops_state_init

log_info "tick start" "tick_id" "$TICK_ID"

run_check() {
  local script="$1"
  if [[ -x "$script" ]]; then
    "$script" || log_warn "check exited non-zero" "script" "$(basename "$script")" "exit" "$?"
  fi
}

run_check "$SCRIPT_DIR/check-host.sh"
run_check "$SCRIPT_DIR/check-docker.sh"
run_check "$SCRIPT_DIR/check-nginx.sh"
run_check "$SCRIPT_DIR/check-app.sh"

tick_finalize

log_info "tick complete" "tick_id" "$TICK_ID"
