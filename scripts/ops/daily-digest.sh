#!/usr/bin/env bash
# Phase D implementation pending. Posts a warn indicating stub until implemented.
# Kept here so the systemd service unit has a valid ExecStart path.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
ops_strict_mode

log_warn "daily-digest: Phase D implementation pending — no-op" "phase" "A-stub"
exit 0
