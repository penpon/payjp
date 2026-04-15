#!/usr/bin/env bash
# Post one alert message to the payjp-ops Discord webhook.
#
# Usage:
#   notify.sh --severity {critical|warn|normal} --code CODE --title "Title" --body "Body"
#
# Webhook URL resolution: see lib/op-webhook.sh (get_webhook_url).
#
# Other env:
#   DRY_RUN=1            print payload to stdout, skip POST, skip state writes
#
# Dependencies: curl, jq.

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
# shellcheck source=lib/alert-codes-i18n.conf
source "$SCRIPT_DIR/lib/alert-codes-i18n.conf"

severity_emoji() {
  case "$1" in
    critical) printf '🔴' ;;
    warn)     printf '🟡' ;;
    normal)   printf '🟢' ;;
    *)        printf '⚪' ;;
  esac
}

SEVERITY=""
CODE=""
TITLE=""
BODY=""
USERNAME=""  # empty = derive from webhook kind below

while (( $# > 0 )); do
  case "$1" in
    --severity) SEVERITY="$2"; shift 2 ;;
    --code)     CODE="$2";     shift 2 ;;
    --title)    TITLE="$2";    shift 2 ;;
    --body)     BODY="${2:-}"; shift 2 ;;
    --username) USERNAME="$2"; shift 2 ;;
    *) log_error "unknown arg" "arg" "$1"; exit 2 ;;
  esac
done

if [[ -z "$SEVERITY" || -z "$CODE" || -z "$TITLE" ]]; then
  log_error "missing required args" "severity" "${SEVERITY:-}" "code" "${CODE:-}" "title" "${TITLE:-}"
  exit 2
fi

WEBHOOK_KIND=$(severity_to_webhook_kind "$SEVERITY")
USERNAME="${USERNAME:-payjp-ops-${WEBHOOK_KIND}}"

COLOR=$(severity_color "$SEVERITY")
EMOJI=$(severity_emoji "$SEVERITY")

# RESOLVED (e.g. HOST_DISK_ROOT_RESOLVED) は suffix を剥がして base code で i18n を引く。
BASE_CODE="$CODE"
IS_RESOLVED=0
if [[ "$CODE" == *_RESOLVED ]]; then
  BASE_CODE="${CODE%_RESOLVED}"
  IS_RESOLVED=1
fi

JA_TITLE="${ALERT_JA_TITLE[$BASE_CODE]:-}"
JA_CONTEXT="${ALERT_JA_CONTEXT[$BASE_CODE]:-}"

if (( IS_RESOLVED == 1 )); then
  FINAL_TITLE="${EMOJI} [復旧] ${JA_TITLE:-$BASE_CODE} (${BASE_CODE})"
  DESCRIPTION="**状況**: ${GREEN_STREAK_FOR_RESOLVE:-2}回連続正常を確認し復旧と判定。"$'\n\n'"**最新値**: ${BODY:-(no body)}"
else
  if [[ -n "$JA_TITLE" ]]; then
    FINAL_TITLE="${EMOJI} ${JA_TITLE}: ${TITLE} (${CODE})"
  else
    FINAL_TITLE="${EMOJI} ${TITLE} (${CODE})"
  fi
  if [[ -n "$JA_CONTEXT" ]]; then
    DESCRIPTION="**状況**: ${JA_CONTEXT}"$'\n\n'"**詳細**:"$'\n'"${BODY:-(no body)}"
  else
    DESCRIPTION="${BODY:-(no body)}"
  fi
fi

# Discord embed description max 4096; truncate conservatively.
if (( ${#DESCRIPTION} > 3900 )); then
  DESCRIPTION="${DESCRIPTION:0:3900}

...[truncated]"
fi

PAYLOAD=$(jq -cn \
  --arg username "$USERNAME" \
  --arg title "$FINAL_TITLE" \
  --arg description "$DESCRIPTION" \
  --argjson color "$COLOR" \
  '{username: $username, embeds: [{title: $title, description: $description, color: $color}]}')

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  printf '%s\n' "$PAYLOAD"
  exit 0
fi

ops_state_init
if ! global_rate_check; then
  log_warn "notify deferred: global rate-limit active" "code" "$CODE"
  exit 0
fi

if ! URL=$(get_webhook_url "$WEBHOOK_KIND"); then
  log_discord_ops_webhook_unavailable "$WEBHOOK_KIND" "code" "$CODE" "severity" "$SEVERITY" "title" "$TITLE"
  exit 1
fi

# --fail-with-body keeps body on 4xx/5xx; URL scrubbed from stderr for defense-in-depth.
if curl --silent --show-error --fail-with-body \
     --max-time 10 \
     -H "Content-Type: application/json" \
     -X POST \
     -d "$PAYLOAD" \
     "$URL" \
     2> >(sed 's#https://discord[^ ]*#[WEBHOOK]#g' >&2) \
     >/dev/null; then
  global_rate_mark
  log_info "notified" "code" "$CODE" "severity" "$SEVERITY"
else
  rc=$?
  log_error "notify POST failed" "code" "$CODE" "exit" "$rc"
  exit 1
fi
