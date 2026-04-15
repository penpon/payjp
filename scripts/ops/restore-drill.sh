#!/usr/bin/env bash
set -euo pipefail

# Monthly restore drill: download latest offsite backup, decrypt, restore into
# an ephemeral scratch postgres container, run sanity queries, tear down.
#
# Trust model trade-off (documented for post-MVP review):
#   The age private key is loaded onto this VPS via systemd-creds for the
#   duration of the drill run, then goes out of scope with the process. VPS
#   compromise during the drill window could theoretically leak the key. We
#   accept this for MVP because:
#     (1) an unverified encrypted backup is worse than a briefly-online key,
#     (2) the alternative (manual laptop-side drill) is guaranteed to rot, and
#     (3) systemd-creds restricts the plaintext to the service's $CREDENTIALS_DIRECTORY
#         which is tmpfs + process-tree-scoped.
#   Post-MVP enhancement: issue a separate "drill" keypair and re-encrypt a
#   subset of real backups with both recipients; or move drills to a dedicated
#   sandbox host.
#
# Invoked by payjp-ops-restore-drill.timer (first Sunday 04:00 JST).
#
# Required credentials ($CREDENTIALS_DIRECTORY):
#   B2_DRILL_KEY_ID           — read-only B2 application key ID
#   B2_DRILL_APPLICATION_KEY  — read-only B2 application key secret
#   BACKUP_AGE_PRIVATE_KEY    — age private key (AGE-SECRET-KEY-1...)
#
# State:
#   /var/lib/payjp-ops/state.d/restore-drill-last-success.epoch

STATE_DIR="${OPS_STATE_DIR:-/var/lib/payjp-ops}/state.d"
STATE_FILE="$STATE_DIR/restore-drill-last-success.epoch"

# Single source of truth for B2 bucket name: lib/thresholds.conf.
# shellcheck source=lib/thresholds.conf
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib/thresholds.conf"
: "${B2_BUCKET:?B2_BUCKET not set (expected from thresholds.conf)}"

SCRATCH_CONTAINER="payjp-restore-drill-$$"
SCRATCH_PORT="${SCRATCH_PORT:-55432}"
SCRATCH_USER=drilluser
SCRATCH_DB=drilldb
SCRATCH_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d /+=)
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16-alpine}"

info() { echo "[restore-drill] $*"; }

cleanup() {
  docker rm -f "$SCRATCH_CONTAINER" >/dev/null 2>&1 || true
  [[ -n "${TMPDIR_RUN:-}" && -d "$TMPDIR_RUN" ]] && rm -rf "$TMPDIR_RUN"
}
trap cleanup EXIT

# cleanup is authoritative on the EXIT trap. die() just disarms to avoid
# double-run if cleanup is ever extended (state writes, shred, notifications).
die() { echo "[restore-drill] FATAL: $*" >&2; exit 1; }

[[ -n "${CREDENTIALS_DIRECTORY:-}" ]] \
  || die "CREDENTIALS_DIRECTORY unset (must run via systemd)"
for c in B2_DRILL_KEY_ID B2_DRILL_APPLICATION_KEY BACKUP_AGE_PRIVATE_KEY; do
  [[ -r "$CREDENTIALS_DIRECTORY/$c" ]] || die "credential $c missing"
done

command -v age >/dev/null 2>&1 || die "age not installed"
command -v rclone >/dev/null 2>&1 || die "rclone not installed"
command -v docker >/dev/null 2>&1 || die "docker not available"

TMPDIR_RUN=$(mktemp -d -t payjp-drill.XXXXXX)
chmod 0700 "$TMPDIR_RUN"

export RCLONE_CONFIG_B2_TYPE=b2
RCLONE_CONFIG_B2_ACCOUNT=$(cat "$CREDENTIALS_DIRECTORY/B2_DRILL_KEY_ID")
RCLONE_CONFIG_B2_KEY=$(cat "$CREDENTIALS_DIRECTORY/B2_DRILL_APPLICATION_KEY")
export RCLONE_CONFIG_B2_ACCOUNT RCLONE_CONFIG_B2_KEY

info "listing B2 bucket for latest upload"
LATEST_REMOTE=$(rclone lsf "b2:${B2_BUCKET}/" --include 'payjp_*.sql.gz.age' 2>/dev/null \
                | sort | tail -1) \
  || die "rclone lsf failed"
[[ -n "$LATEST_REMOTE" ]] || die "no backups found in bucket"
info "latest remote: $LATEST_REMOTE"

ENCRYPTED="$TMPDIR_RUN/$LATEST_REMOTE"
info "downloading to $ENCRYPTED"
rclone copyto "b2:${B2_BUCKET}/${LATEST_REMOTE}" "$ENCRYPTED" --retries 3 >/dev/null \
  || die "download failed"

info "starting scratch postgres container ($POSTGRES_IMAGE, port $SCRATCH_PORT)"
docker run -d --rm \
  --name "$SCRATCH_CONTAINER" \
  -e "POSTGRES_USER=$SCRATCH_USER" \
  -e "POSTGRES_PASSWORD=$SCRATCH_PASSWORD" \
  -e "POSTGRES_DB=$SCRATCH_DB" \
  -p "127.0.0.1:${SCRATCH_PORT}:5432" \
  "$POSTGRES_IMAGE" >/dev/null \
  || die "docker run failed"

info "waiting for postgres ready"
for i in $(seq 1 30); do
  if docker exec "$SCRATCH_CONTAINER" pg_isready -U "$SCRATCH_USER" -d "$SCRATCH_DB" >/dev/null 2>&1; then
    info "postgres ready after ${i}s"
    break
  fi
  sleep 1
  (( i == 30 )) && die "postgres never became ready"
done

info "decrypting + restoring"
# age private key is passed via -i <file>. We must write it to a file because
# age does not accept secret key on stdin for -i. Tmp file is 0600 on tmpfs
# ($CREDENTIALS_DIRECTORY) or $TMPDIR_RUN (0700). Prefer the credentials dir
# directly — it's already tmpfs and scoped.
AGE_KEY_FILE="$CREDENTIALS_DIRECTORY/BACKUP_AGE_PRIVATE_KEY"

if ! age -d -i "$AGE_KEY_FILE" < "$ENCRYPTED" \
     | gunzip \
     | docker exec -i "$SCRATCH_CONTAINER" \
         psql -U "$SCRATCH_USER" -d "$SCRATCH_DB" -v ON_ERROR_STOP=1 \
     >/dev/null
then
  die "decrypt + restore pipeline failed"
fi

info "sanity check: public schema table count"
# Split assignment + check so a psql failure surfaces as "psql failed" not as
# an "unparseable count" misdirection.
if ! TABLE_COUNT=$(docker exec "$SCRATCH_CONTAINER" \
     psql -U "$SCRATCH_USER" -d "$SCRATCH_DB" -tAc \
     "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
then
  die "psql failed during sanity check (container crash? restore incomplete?)"
fi
TABLE_COUNT="${TABLE_COUNT//[[:space:]]/}"
[[ "$TABLE_COUNT" =~ ^[0-9]+$ ]] || die "unparseable table count: $TABLE_COUNT"
(( TABLE_COUNT >= 1 )) || die "no tables restored (got $TABLE_COUNT)"
info "tables in public schema: $TABLE_COUNT"

mkdir -p "$STATE_DIR"
date +%s > "$STATE_FILE"

info "ok: drill passed, state stamp updated, source=${LATEST_REMOTE}, tables=${TABLE_COUNT}"
