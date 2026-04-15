#!/usr/bin/env bash
set -euo pipefail

# Offsite upload: take the latest local pg_dump, encrypt with age, stream to B2.
#
# Invoked by payjp-ops-offsite.service, which is triggered by
# payjp-ops-backup.service on success (OnSuccess= directive). Runs as root
# because it reads 0600 backup files owned by root.
#
# Pipeline (two-phase, not streamed):
#   1. age -R <recipients> < latest.sql.gz > /tmp/stage.age  (PrivateTmp)
#   2. size sanity check on stage file
#   3. rclone copyto /tmp/stage.age b2:<bucket>/<name>.age   (B2 server-side SHA1 check)
#   4. stage file auto-removed via trap EXIT
#
# Secrets (loaded via systemd-creds into $CREDENTIALS_DIRECTORY):
#   B2_BACKUP_KEY_ID           — write-only B2 application key ID
#   B2_BACKUP_APPLICATION_KEY  — write-only B2 application key secret
#
# State:
#   /var/lib/payjp-ops/state.d/offsite-last-success.epoch  (updated on success)
#
# Manual run (for backfill or testing):
#   sudo systemctl start payjp-ops-offsite.service

BACKUP_DIR="/var/backups/payjp-db"
AGE_RECIPIENTS_FILE="${AGE_RECIPIENTS_FILE:-/opt/payjp-ops/etc/backup-age-recipients.pub}"
STATE_DIR="${OPS_STATE_DIR:-/var/lib/payjp-ops}/state.d"
STATE_FILE="$STATE_DIR/offsite-last-success.epoch"

# Single source of truth for B2 bucket name: lib/thresholds.conf.
# shellcheck source=lib/thresholds.conf
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/thresholds.conf"
: "${B2_BUCKET:?B2_BUCKET not set (expected from thresholds.conf)}"

die() { echo "[offsite-upload] FATAL: $*" >&2; exit 1; }
info() { echo "[offsite-upload] $*"; }

[[ -n "${CREDENTIALS_DIRECTORY:-}" ]] \
  || die "CREDENTIALS_DIRECTORY unset. This script must run via systemd with LoadCredentialEncrypted=."
[[ -r "$CREDENTIALS_DIRECTORY/B2_BACKUP_KEY_ID" ]] \
  || die "credential B2_BACKUP_KEY_ID not readable in $CREDENTIALS_DIRECTORY"
[[ -r "$CREDENTIALS_DIRECTORY/B2_BACKUP_APPLICATION_KEY" ]] \
  || die "credential B2_BACKUP_APPLICATION_KEY not readable"

[[ -r "$AGE_RECIPIENTS_FILE" ]] || die "age recipients file missing: $AGE_RECIPIENTS_FILE"
command -v age >/dev/null 2>&1 || die "age not installed (apt install age)"
command -v rclone >/dev/null 2>&1 || die "rclone not installed (apt install rclone)"

LATEST=$(ls -1t "$BACKUP_DIR"/payjp_*.sql.gz 2>/dev/null | head -1) \
  || die "ls failed on $BACKUP_DIR"
[[ -n "$LATEST" ]] || die "no backup files in $BACKUP_DIR"

BASENAME=$(basename "$LATEST")
REMOTE_NAME="${BASENAME}.age"

# rclone config via env (no config file written). Single-shot, machine memory only.
export RCLONE_CONFIG_B2_TYPE=b2
RCLONE_CONFIG_B2_ACCOUNT=$(cat "$CREDENTIALS_DIRECTORY/B2_BACKUP_KEY_ID")
RCLONE_CONFIG_B2_KEY=$(cat "$CREDENTIALS_DIRECTORY/B2_BACKUP_APPLICATION_KEY")
export RCLONE_CONFIG_B2_ACCOUNT RCLONE_CONFIG_B2_KEY
export RCLONE_CONFIG_B2_HARD_DELETE=false

SIZE=$(stat -c %s "$LATEST")
info "source: $LATEST (${SIZE} bytes)"
info "target: b2:${B2_BUCKET}/${REMOTE_NAME}"

# Two-phase upload: encrypt to a local ciphertext stage file, verify size,
# then upload the file (not a stream).
#
# Why staging instead of `age | rclone rcat`: a streaming pipeline can let
# rclone finalize a truncated B2 object if `age` crashes mid-stream, since
# rclone's multipart-streaming path (for larger dumps) commits chunks before
# the producer's exit code is visible. pipefail catches the shell exit, but
# the partial B2 object may already be finalized. Two-phase + sanity size
# check eliminates this window: rclone uploads a complete file with
# server-side SHA1 validation by B2.
#
# The stage file is ciphertext (age-encrypted), so it carries the same
# exposure as what ends up on B2. Service has PrivateTmp=yes; stage lives
# in the private /tmp.
STAGE=$(mktemp --tmpdir payjp-offsite.XXXXXX.age)
chmod 0600 "$STAGE"
trap 'rm -f "$STAGE"' EXIT

if ! age -R "$AGE_RECIPIENTS_FILE" < "$LATEST" > "$STAGE"; then
  die "age encryption failed (stage: $STAGE)"
fi

STAGE_SIZE=$(stat -c %s "$STAGE")
# age ciphertext is strictly larger than plaintext (header + MAC). If stage
# is ≤ source, encryption produced a truncated blob — refuse to upload.
if (( STAGE_SIZE <= SIZE )); then
  die "stage size ${STAGE_SIZE} <= source ${SIZE}: age encryption truncated"
fi
info "encrypted: ${STAGE_SIZE} bytes (+$((STAGE_SIZE - SIZE)) overhead)"

if ! rclone copyto "$STAGE" "b2:${B2_BUCKET}/${REMOTE_NAME}" \
     --retries 3 \
     --low-level-retries 5 \
     --stats 0
then
  die "rclone upload failed for $REMOTE_NAME"
fi

mkdir -p "$STATE_DIR"
date +%s > "$STATE_FILE"

info "ok: uploaded ${REMOTE_NAME} (${STAGE_SIZE} bytes), state stamp updated"
