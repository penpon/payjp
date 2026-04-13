#!/usr/bin/env bash
# Fetch Discord webhook URL from 1Password service account.
# Source this — do NOT execute. Requires common.sh already sourced.
#
# Cache: $OPS_WEBHOOK_CACHE (tmpfs, 0600 payjp-ops), TTL 10 min.
# The cache file contains the URL with no trailing newline.

: "${OPS_WEBHOOK_CACHE:=/run/payjp-ops/webhook.url}"
: "${OPS_WEBHOOK_CACHE_TTL:=600}"

get_webhook_url() {
  local cache="$OPS_WEBHOOK_CACHE"
  if [[ -r "$cache" ]]; then
    local mtime age now
    mtime=$(stat -c %Y "$cache")
    now=$(date +%s)
    age=$(( now - mtime ))
    if (( age < OPS_WEBHOOK_CACHE_TTL )); then
      cat "$cache"
      return 0
    fi
  fi
  if [[ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]]; then
    log_error "OP_SERVICE_ACCOUNT_TOKEN unset; cannot fetch webhook URL"
    return 1
  fi
  if [[ -z "${OP_WEBHOOK_ITEM:-}" ]]; then
    log_error "OP_WEBHOOK_ITEM unset"
    return 1
  fi
  local url
  if ! url=$(op read "$OP_WEBHOOK_ITEM" 2>/dev/null); then
    log_error "op read failed"
    return 1
  fi
  if [[ -z "$url" ]]; then
    log_error "op read returned empty webhook URL"
    return 1
  fi
  mkdir -p "$(dirname "$cache")"
  umask 077
  printf '%s' "$url" > "$cache"
  printf '%s' "$url"
}
