#!/usr/bin/env bash
# State-file cooldown + global rate-limit for payjp-ops notifications.
# Source this — do NOT execute. Requires common.sh already sourced.

: "${OPS_STATE_DIR:=/var/lib/payjp-ops}"

ops_state_init() {
  mkdir -p "$OPS_STATE_DIR/state.d"
}

_stamp_path()  { printf '%s/state.d/%s.stamp' "$OPS_STATE_DIR" "$1"; }
_streak_path() { printf '%s/state.d/%s.green' "$OPS_STATE_DIR" "$1"; }

_cooldown_for() {
  local code="$1" severity="$2"
  local override_name="COOLDOWN_${code}"
  local override="${!override_name:-}"
  if [[ -n "$override" ]]; then
    printf '%s' "$override"
    return
  fi
  case "$severity" in
    critical) printf '%s' "${COOLDOWN_CRITICAL:-600}" ;;
    warn)     printf '%s' "${COOLDOWN_WARN:-1800}" ;;
    normal)   printf '%s' "${COOLDOWN_NORMAL:-3600}" ;;
    *)        printf '%s' 600 ;;
  esac
}

# Returns 0 = fire now, 1 = suppressed by cooldown.
should_fire() {
  local code="$1" severity="$2"
  local stamp
  stamp="$(_stamp_path "$code")"
  [[ -e "$stamp" ]] || return 0
  local mtime now age cooldown
  mtime=$(stat -c %Y "$stamp")
  now=$(date +%s)
  age=$(( now - mtime ))
  cooldown=$(_cooldown_for "$code" "$severity")
  (( age >= cooldown ))
}

mark_fired() {
  touch "$(_stamp_path "$1")"
  rm -f "$(_streak_path "$1")"
}

# Returns 0 = should post RESOLVED, 1 = no change needed.
on_healthy() {
  local code="$1"
  local stamp streak_file streak
  stamp="$(_stamp_path "$code")"
  [[ -e "$stamp" ]] || return 1
  streak_file="$(_streak_path "$code")"
  streak=0
  [[ -e "$streak_file" ]] && streak=$(cat "$streak_file")
  streak=$((streak + 1))
  printf '%s' "$streak" > "$streak_file"
  if (( streak >= ${GREEN_STREAK_FOR_RESOLVE:-2} )); then
    rm -f "$stamp" "$streak_file"
    return 0
  fi
  return 1
}

# Returns 0 = ok to post, 1 = too soon after previous post.
global_rate_check() {
  local last_post_file="$OPS_STATE_DIR/last_post_at"
  [[ -e "$last_post_file" ]] || return 0
  local now last interval
  now=$(date +%s)
  last=$(cat "$last_post_file")
  interval="${GLOBAL_MIN_INTERVAL_SEC:-60}"
  (( now - last >= interval ))
}

global_rate_mark() {
  date +%s > "$OPS_STATE_DIR/last_post_at"
}

# Dispatch helper used by check-* scripts.
# Usage: handle CODE SEVERITY {fire|clear} TITLE BODY
#   fire  → post if past cooldown, then mark
#   clear → post RESOLVED if GREEN_STREAK reached
handle() {
  local code="$1" severity="$2" condition="$3" title="$4" body="$5"
  if [[ "$condition" == "fire" ]]; then
    if should_fire "$code" "$severity"; then
      if [[ "${DRY_RUN:-0}" == "1" ]]; then
        "$NOTIFY_SCRIPT" --severity "$severity" --code "$code" --title "$title" --body "$body"
      else
        if "$NOTIFY_SCRIPT" --severity "$severity" --code "$code" --title "$title" --body "$body"; then
          mark_fired "$code"
        fi
      fi
    fi
  else
    [[ "${DRY_RUN:-0}" == "1" ]] && return 0
    if on_healthy "$code"; then
      "$NOTIFY_SCRIPT" --severity normal --code "${code}_RESOLVED" \
        --title "[RESOLVED] $code" \
        --body "Condition cleared after ${GREEN_STREAK_FOR_RESOLVE:-2} consecutive healthy checks. ${body}" || true
    fi
  fi
}

# Enumerate alert stamps fired in last N seconds — used by daily digest.
list_recent_alerts() {
  local seconds="${1:-86400}"
  local cutoff
  cutoff=$(($(date +%s) - seconds))
  find "$OPS_STATE_DIR/state.d" -maxdepth 1 -name '*.stamp' -type f 2>/dev/null | \
    while read -r f; do
      local mtime
      mtime=$(stat -c %Y "$f" 2>/dev/null) || continue
      if (( mtime >= cutoff )); then
        printf '%s %s\n' "$mtime" "$(basename "$f" .stamp)"
      fi
    done | sort -rn
}
