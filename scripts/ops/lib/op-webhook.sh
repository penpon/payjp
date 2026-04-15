#!/usr/bin/env bash
# Discord ops webhook URL resolution for payjp-ops scripts. Source this — do NOT execute.
#
# Two channels, one kind per call:
#   alerts  → critical / warn fires, OPS_STORM (operator must react)
#   normal  → RESOLVED (normal severity) + daily digest (read-at-leisure)
#
# Resolution order per kind (first non-empty wins):
#   1. $DISCORD_OPS_WEBHOOK_ALERTS / $DISCORD_OPS_WEBHOOK_NORMAL env var (manual/dev runs)
#   2. Legacy single webhook env var: $DISCORD_OPS_WEBHOOK
#   3. $CREDENTIALS_DIRECTORY/DISCORD_OPS_WEBHOOK_ALERTS or ..._NORMAL (systemd LoadCredentialEncrypted)
#   4. Legacy single webhook credential file: $CREDENTIALS_DIRECTORY/DISCORD_OPS_WEBHOOK

# Prints the webhook URL for the given kind. Returns 1 if unavailable.
# Usage: get_webhook_url alerts|normal
get_webhook_url() {
  local kind="${1:?get_webhook_url: kind required (alerts|normal)}"
  local var_name cred_name legacy_var_name legacy_cred_name
  case "$kind" in
    alerts) var_name="DISCORD_OPS_WEBHOOK_ALERTS"; cred_name="DISCORD_OPS_WEBHOOK_ALERTS" ;;
    normal) var_name="DISCORD_OPS_WEBHOOK_NORMAL"; cred_name="DISCORD_OPS_WEBHOOK_NORMAL" ;;
    *) return 1 ;;
  esac
  legacy_var_name="DISCORD_OPS_WEBHOOK"
  legacy_cred_name="DISCORD_OPS_WEBHOOK"
  local url="${!var_name:-}"
  if [[ -z "$url" ]]; then
    url="${!legacy_var_name:-}"
  fi
  if [[ -z "$url" && -n "${CREDENTIALS_DIRECTORY:-}" && -r "$CREDENTIALS_DIRECTORY/$cred_name" ]]; then
    url=$(< "$CREDENTIALS_DIRECTORY/$cred_name")
  fi
  if [[ -z "$url" && -n "${CREDENTIALS_DIRECTORY:-}" && -r "$CREDENTIALS_DIRECTORY/$legacy_cred_name" ]]; then
    url=$(< "$CREDENTIALS_DIRECTORY/$legacy_cred_name")
  fi
  if [[ -z "$url" ]]; then
    return 1
  fi
  printf '%s' "$url"
}

# Maps severity → webhook kind.
#   critical / warn / (unknown) → alerts
#   normal                      → normal
# Aggregate OPS_STORM is emitted with severity=critical, so it routes to alerts.
severity_to_webhook_kind() {
  case "$1" in
    normal) printf 'normal' ;;
    *)      printf 'alerts' ;;
  esac
}

# Canonical unavailable message; first arg is kind, rest are extra key/value pairs for log_json.
log_discord_ops_webhook_unavailable() {
  local kind="$1"; shift
  log_error "DISCORD_OPS_WEBHOOK_${kind^^} unavailable — set env var (manual runs) or invoke via payjp-ops systemd unit (LoadCredentialEncrypted)" "kind" "$kind" "$@"
}
