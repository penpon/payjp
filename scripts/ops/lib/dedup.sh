#!/usr/bin/env bash
# State-file cooldown + global rate-limit + per-tick storm collapse for payjp-ops.
# Source this — do NOT execute. Requires common.sh already sourced.

: "${OPS_STATE_DIR:=/var/lib/payjp-ops}"
: "${TICK_ID:=$(date +%s)}"

ops_state_init() {
  mkdir -p "$OPS_STATE_DIR/state.d"
}

_stamp_path()  { printf '%s/state.d/%s.stamp' "$OPS_STATE_DIR" "$1"; }
_streak_path() { printf '%s/state.d/%s.green' "$OPS_STATE_DIR" "$1"; }
_tick_count_file() { printf '%s/state.d/.tick.%s.count' "$OPS_STATE_DIR" "$TICK_ID"; }
_tick_storm_buf()  { printf '%s/state.d/.tick.%s.storm' "$OPS_STATE_DIR" "$TICK_ID"; }

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
  if [[ -e "$streak_file" ]]; then
    streak=$(cat "$streak_file" 2>/dev/null || echo 0)
    streak="${streak:-0}"
    # Guard against partial writes that are not parseable as integer.
    [[ "$streak" =~ ^[0-9]+$ ]] || streak=0
  fi
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
  # Read with fallback: a partial/empty read (concurrent write) or missing
  # content must not crash the arithmetic under `set -e`.
  last=$(cat "$last_post_file" 2>/dev/null || echo 0)
  last="${last:-0}"
  interval="${GLOBAL_MIN_INTERVAL_SEC:-60}"
  (( now - last >= interval ))
}

global_rate_mark() {
  date +%s > "$OPS_STATE_DIR/last_post_at"
}

# ---- Tick counting (for storm collapse) ----
_tick_inc() {
  local file cur=0
  file=$(_tick_count_file)
  if [[ -e "$file" ]]; then
    cur=$(cat "$file" 2>/dev/null || echo 0)
    [[ "$cur" =~ ^[0-9]+$ ]] || cur=0
  fi
  cur=$((cur + 1))
  printf '%s' "$cur" > "$file"
  printf '%s' "$cur"
}

_tick_count() {
  local file cur=0
  file=$(_tick_count_file)
  if [[ -e "$file" ]]; then
    cur=$(cat "$file" 2>/dev/null || echo 0)
    [[ "$cur" =~ ^[0-9]+$ ]] || cur=0
  fi
  printf '%s' "$cur"
}

# Cleanup stale tick files (> 1 hour old).
_tick_cleanup_stale() {
  find "$OPS_STATE_DIR/state.d" -maxdepth 1 -name '.tick.*' -mmin +60 -delete 2>/dev/null || true
}

# Called at the end of a tick (run-all-checks.sh). Posts OPS_STORM summary
# when storm threshold was reached, then cleans up per-tick state.
tick_finalize() {
  local count storm_file
  count=$(_tick_count)
  storm_file=$(_tick_storm_buf)
  if (( count >= ${STORM_CODES_THRESHOLD:-5} )) && [[ -e "$storm_file" ]] && [[ "${DRY_RUN:-0}" != "1" ]]; then
    local body
    body="Total fires this tick: ${count}
$(cat "$storm_file")"
    "${NOTIFY_SCRIPT:?}" --severity critical --code OPS_STORM \
      --title "storm: ${count} codes fired in one tick" \
      --body "$body" || true
  fi
  rm -f "$storm_file" "$(_tick_count_file)"
  _tick_cleanup_stale
}

# ---- handle() dispatcher ----
# Usage: handle CODE SEVERITY {fire|clear} TITLE BODY
#   fire  → post if past cooldown; when tick_count >= STORM_CODES_THRESHOLD,
#           suppress individual post (storm summary covers it).
#   clear → post RESOLVED if GREEN_STREAK_FOR_RESOLVE reached.
handle() {
  local code="$1" severity="$2" condition="$3" title="$4" body="$5"
  if [[ "$condition" == "fire" ]]; then
    if should_fire "$code" "$severity"; then
      local tick_count
      tick_count=$(_tick_inc)
      # Always record for potential OPS_STORM summary.
      printf '[%s][%s] %s\n' "$severity" "$code" "$title" >> "$(_tick_storm_buf)"
      if (( tick_count >= ${STORM_CODES_THRESHOLD:-5} )) && [[ "${DRY_RUN:-0}" != "1" ]]; then
        mark_fired "$code"
        log_warn "storm suppression" "code" "$code" "tick_count" "$tick_count"
        return 0
      fi
      if [[ "${DRY_RUN:-0}" == "1" ]]; then
        "${NOTIFY_SCRIPT:?}" --severity "$severity" --code "$code" --title "$title" --body "$body"
      else
        if "${NOTIFY_SCRIPT:?}" --severity "$severity" --code "$code" --title "$title" --body "$body"; then
          mark_fired "$code"
        fi
      fi
    fi
  else
    [[ "${DRY_RUN:-0}" == "1" ]] && return 0
    if on_healthy "$code"; then
      # notify.sh が *_RESOLVED を検知して日本語タイトル・状況文を付与するため、
      # ここでは --title を固定文字列にし、--body は最新値 (clear 呼び出し時の body) のみ渡す。
      "${NOTIFY_SCRIPT:?}" --severity normal --code "${code}_RESOLVED" \
        --title "復旧" \
        --body "${body}" || true
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
