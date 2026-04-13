#!/usr/bin/env bash
# Entry point invoked by payjp-ops-check.service every 5 min.
# Each phase adds a check script; missing scripts are silently skipped.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
ops_strict_mode

log_info "tick start"

# Phase A
[[ -x "$SCRIPT_DIR/check-host.sh" ]]   && { "$SCRIPT_DIR/check-host.sh"   || log_warn "check-host exited non-zero"   "exit" "$?"; }
# Phase B
[[ -x "$SCRIPT_DIR/check-docker.sh" ]] && { "$SCRIPT_DIR/check-docker.sh" || log_warn "check-docker exited non-zero" "exit" "$?"; }
[[ -x "$SCRIPT_DIR/check-nginx.sh" ]]  && { "$SCRIPT_DIR/check-nginx.sh"  || log_warn "check-nginx exited non-zero"  "exit" "$?"; }
# Phase C
[[ -x "$SCRIPT_DIR/check-app.sh" ]]    && { "$SCRIPT_DIR/check-app.sh"    || log_warn "check-app exited non-zero"    "exit" "$?"; }

log_info "tick complete"
