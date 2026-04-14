#!/usr/bin/env bash
# Post one alert message to the payjp-ops Discord webhook.
#
# Usage:
#   notify.sh --severity {critical|warn|normal} --code CODE --title "Title" --body "Body"
#
# Webhook URL resolution (first non-empty wins):
#   1. $DISCORD_OPS_WEBHOOK env var (useful for manual/dev runs)
#   2. $CREDENTIALS_DIRECTORY/DISCORD_OPS_WEBHOOK file (systemd LoadCredentialEncrypted;
#      systemd surfaces the decrypted secret here when launched via the service unit)
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

SEVERITY=""
CODE=""
TITLE=""
BODY=""
USERNAME="payjp-ops"

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

COLOR=$(severity_color "$SEVERITY")
DESCRIPTION="${BODY:-(no body)}"
# Discord embed description max 4096; truncate conservatively.
if (( ${#DESCRIPTION} > 3900 )); then
  DESCRIPTION="${DESCRIPTION:0:3900}

...[truncated]"
fi

PAYLOAD=$(jq -cn \
  --arg username "$USERNAME" \
  --arg title "[$SEVERITY] [$CODE] $TITLE" \
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

URL="${DISCORD_OPS_WEBHOOK:-}"
if [[ -z "$URL" && -n "${CREDENTIALS_DIRECTORY:-}" && -r "$CREDENTIALS_DIRECTORY/DISCORD_OPS_WEBHOOK" ]]; then
  URL=$(< "$CREDENTIALS_DIRECTORY/DISCORD_OPS_WEBHOOK")
fi
if [[ -z "$URL" ]]; then
  log_error "DISCORD_OPS_WEBHOOK unavailable — set the env var (manual runs) or invoke via payjp-ops systemd unit (LoadCredentialEncrypted)" \
    "code" "$CODE" "severity" "$SEVERITY" "title" "$TITLE"
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
