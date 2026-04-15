#!/usr/bin/env bash
# B2 bucket size probe. Emits total bytes in the bucket on stdout; exit 0 on
# success. Invoked by daily-digest.sh::gather_offsite and runs in the context
# of payjp-ops-digest.service (which loads B2_DRILL_* via
# LoadCredentialEncrypted=). Not invoked by the hourly check.service to avoid
# loading read credentials into a high-frequency service.
#
# Alternative (cheaper): rely on offsite-upload.sh success stamps + retention
# math. But a direct probe catches drift (missed uploads that checked in as
# success, lifecycle rule broken, etc.).
#
# Requires $CREDENTIALS_DIRECTORY with B2_DRILL_KEY_ID + B2_DRILL_APPLICATION_KEY.

set -euo pipefail

# Single source of truth for B2 bucket name: lib/thresholds.conf.
# shellcheck source=lib/thresholds.conf
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/thresholds.conf"
: "${B2_BUCKET:?B2_BUCKET not set (expected from thresholds.conf)}"

[[ -n "${CREDENTIALS_DIRECTORY:-}" ]] \
  || { echo "CREDENTIALS_DIRECTORY unset" >&2; exit 2; }
[[ -r "$CREDENTIALS_DIRECTORY/B2_DRILL_KEY_ID" ]] \
  || { echo "B2_DRILL_KEY_ID credential missing" >&2; exit 2; }

export RCLONE_CONFIG_B2_TYPE=b2
RCLONE_CONFIG_B2_ACCOUNT=$(cat "$CREDENTIALS_DIRECTORY/B2_DRILL_KEY_ID")
RCLONE_CONFIG_B2_KEY=$(cat "$CREDENTIALS_DIRECTORY/B2_DRILL_APPLICATION_KEY")
export RCLONE_CONFIG_B2_ACCOUNT RCLONE_CONFIG_B2_KEY

# rclone size --json returns: {"count":N,"bytes":N,"sizeless":N}
rclone size "b2:${B2_BUCKET}" --json 2>/dev/null \
  | jq -r '.bytes'
