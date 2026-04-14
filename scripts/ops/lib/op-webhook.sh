#!/usr/bin/env bash
# Discord ops webhook URL resolution for payjp-ops scripts. Source this — do NOT execute.
#
# Resolution order (first non-empty wins):
#   1. $DISCORD_OPS_WEBHOOK env var (manual/dev runs)
#   2. $CREDENTIALS_DIRECTORY/DISCORD_OPS_WEBHOOK (systemd LoadCredentialEncrypted)

# Prints the webhook URL to stdout. Returns 1 if unavailable.
get_webhook_url() {
  local url="${DISCORD_OPS_WEBHOOK:-}"
  if [[ -z "$url" && -n "${CREDENTIALS_DIRECTORY:-}" && -r "$CREDENTIALS_DIRECTORY/DISCORD_OPS_WEBHOOK" ]]; then
    url=$(< "$CREDENTIALS_DIRECTORY/DISCORD_OPS_WEBHOOK")
  fi
  if [[ -z "$url" ]]; then
    return 1
  fi
  printf '%s' "$url"
}

# Canonical unavailable message; optional extra key/value pairs for log_json.
log_discord_ops_webhook_unavailable() {
  log_error "DISCORD_OPS_WEBHOOK unavailable — set the env var (manual runs) or invoke via payjp-ops systemd unit (LoadCredentialEncrypted)" "$@"
}
