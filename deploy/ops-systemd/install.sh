#!/usr/bin/env bash
# payjp-ops installer.
#   sudo deploy/ops-systemd/install.sh               # install
#   sudo deploy/ops-systemd/install.sh --uninstall   # remove
#
# Idempotent. Safe to re-run. See docs/ops/alerts.md for bootstrap steps.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_SRC="$REPO_ROOT/scripts/ops"
UNIT_SRC="$REPO_ROOT/deploy/ops-systemd"

INSTALL_DIR="/opt/payjp-ops/bin"
STATE_DIR="/var/lib/payjp-ops"
RUN_DIR="/run/payjp-ops"
ENV_DIR="/etc/payjp-ops"
ENV_FILE="$ENV_DIR/.env"                                    # non-secret runtime config
CREDS_DIR="$ENV_DIR/creds"                                  # systemd-creds encrypted blobs
WEBHOOK_CRED_ALERTS="$CREDS_DIR/DISCORD_OPS_WEBHOOK_ALERTS"  # critical/warn/OPS_STORM channel
WEBHOOK_CRED_NORMAL="$CREDS_DIR/DISCORD_OPS_WEBHOOK_NORMAL"  # RESOLVED + daily digest channel
LEGACY_WEBHOOK_CRED="$CREDS_DIR/DISCORD_OPS_WEBHOOK"         # pre-split single webhook (removed)
SYSTEMD_DIR="/etc/systemd/system"
SUDOERS_FILE="/etc/sudoers.d/payjp-ops"
USER_NAME="payjp-ops"
GROUP_NAME="payjp-ops"

die()  { echo "[install] $*" >&2; exit 1; }
info() { echo "[install] $*"; }

(( EUID == 0 )) || die "must run as root"

MODE="install"
for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE="uninstall" ;;
    -h|--help)
      cat <<'USAGE'
Usage: install.sh [--uninstall]

install: create payjp-ops user, copy scripts to /opt/payjp-ops/bin/, install
  systemd units, install sudoers drop-in, seed /etc/payjp-ops/.env template,
  create /etc/payjp-ops/creds/ dir for systemd-creds encrypted blobs.
uninstall: disable timers, remove units + scripts + sudoers. Preserves state
  dir, .env, encrypted creds, and user (see docs/ops/alerts.md for full removal).
USAGE
      exit 0 ;;
    *) die "unknown arg: $arg" ;;
  esac
done

if [[ "$MODE" == "uninstall" ]]; then
  info "disabling timers"
  systemctl disable --now payjp-ops-check.timer payjp-ops-digest.timer payjp-ops-backup.timer 2>/dev/null || true
  info "removing unit files"
  rm -f "$SYSTEMD_DIR"/payjp-ops-check.service "$SYSTEMD_DIR"/payjp-ops-check.timer
  rm -f "$SYSTEMD_DIR"/payjp-ops-digest.service "$SYSTEMD_DIR"/payjp-ops-digest.timer
  rm -f "$SYSTEMD_DIR"/payjp-ops-backup.service "$SYSTEMD_DIR"/payjp-ops-backup.timer
  systemctl daemon-reload
  info "removing install dir"
  rm -rf "$INSTALL_DIR"
  info "removing sudoers drop-in"
  rm -f "$SUDOERS_FILE"
  cat <<EOF
[install] uninstall complete.
  Preserved (delete manually if desired):
    $STATE_DIR       (postmortem state)
    $ENV_FILE        (non-secret runtime config)
    $CREDS_DIR       (systemd-creds encrypted webhooks; machine-bound, safe to leave)
    user $USER_NAME
EOF
  exit 0
fi

# ---- install ----
info "checking dependencies"
command -v jq >/dev/null 2>&1 || die "jq not found. apt install jq"
command -v curl >/dev/null 2>&1 || die "curl not found"
command -v rsync >/dev/null 2>&1 || die "rsync not found"
command -v systemd-creds >/dev/null 2>&1 || die "systemd-creds not found (need systemd >= 250). Ubuntu 24.04 ships 255; check systemctl --version."
info "systemd-creds available (secret encryption ready)"

info "creating system user $USER_NAME"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin \
    --home-dir "$STATE_DIR" "$USER_NAME"
fi

info "creating directories"
install -d -o "$USER_NAME" -g "$GROUP_NAME" -m 0750 "$STATE_DIR" "$STATE_DIR/state.d"
install -d -m 0755 "$ENV_DIR"
install -d -m 0700 -o root -g root "$CREDS_DIR"
install -d -m 0755 "$(dirname "$INSTALL_DIR")"
install -d -m 0755 "$INSTALL_DIR"

info "ensuring $RUN_DIR exists"
if ! [[ -d "$RUN_DIR" ]]; then
  install -d -o "$USER_NAME" -g "$GROUP_NAME" -m 0700 "$RUN_DIR"
fi

info "copying scripts → $INSTALL_DIR"
rsync -a --delete "$SCRIPT_SRC/" "$INSTALL_DIR/"
find "$INSTALL_DIR" -type f -name '*.sh' -exec chmod 0755 {} +
find "$INSTALL_DIR/lib" -type f -name '*.conf' -exec chmod 0644 {} + 2>/dev/null || true

info "migrating legacy payjp-db-backup.{service,timer} → payjp-ops-backup.*"
if systemctl list-unit-files payjp-db-backup.timer >/dev/null 2>&1; then
  systemctl disable --now payjp-db-backup.timer 2>/dev/null || true
  systemctl stop payjp-db-backup.service 2>/dev/null || true
  rm -f "$SYSTEMD_DIR/payjp-db-backup.service" "$SYSTEMD_DIR/payjp-db-backup.timer"
  rm -f /usr/local/sbin/payjp-db-backup
  info "  legacy units + /usr/local/sbin/payjp-db-backup removed (existing backups under /var/backups/payjp-db preserved)"
fi

info "ensuring /var/backups/payjp-db exists (0750 root:$GROUP_NAME — dir list+traverse for payjp-ops; files stay 0600 root:root)"
install -d -o root -g "$GROUP_NAME" -m 0750 /var/backups/payjp-db

info "installing systemd units"
install -m 0644 "$UNIT_SRC/payjp-ops-check.service"  "$SYSTEMD_DIR/"
install -m 0644 "$UNIT_SRC/payjp-ops-check.timer"    "$SYSTEMD_DIR/"
install -m 0644 "$UNIT_SRC/payjp-ops-digest.service" "$SYSTEMD_DIR/"
install -m 0644 "$UNIT_SRC/payjp-ops-digest.timer"   "$SYSTEMD_DIR/"
install -m 0644 "$UNIT_SRC/payjp-ops-backup.service" "$SYSTEMD_DIR/"
install -m 0644 "$UNIT_SRC/payjp-ops-backup.timer"   "$SYSTEMD_DIR/"

info "installing sudoers drop-in (minimum read-only commands)"
cat > "$SUDOERS_FILE" <<'SUDOERS'
# payjp-ops: minimal read-only commands for polling checks.
# Managed by deploy/ops-systemd/install.sh — do not edit manually.
Cmnd_Alias PAYJP_OPS_CMDS = \
    /usr/bin/fail2ban-client status *, \
    /usr/bin/openssl x509 -enddate -noout -in *, \
    /bin/journalctl -k --since *, \
    /usr/bin/journalctl -k --since *, \
    /bin/systemctl is-active docker, \
    /usr/bin/systemctl is-active docker, \
    /usr/bin/docker ps, \
    /usr/bin/docker ps -a, \
    /usr/bin/docker ps -a *, \
    /usr/bin/docker inspect *, \
    /usr/bin/docker volume inspect *, \
    /usr/bin/docker exec payjp-db-1 psql *, \
    /usr/bin/stat -c * /var/backups/payjp-db/*, \
    /usr/bin/stat -c * /var/lib/docker/volumes/payjp_nginx_logs/_data/*, \
    /usr/bin/tail -n * /var/lib/docker/volumes/payjp_nginx_logs/_data/access.log, \
    /usr/bin/tail -n * /var/lib/docker/volumes/payjp_nginx_logs/_data/error.log
payjp-ops ALL=(root) NOPASSWD: PAYJP_OPS_CMDS
SUDOERS
chmod 0440 "$SUDOERS_FILE"
visudo -c -f "$SUDOERS_FILE" >/dev/null || die "sudoers syntax invalid"

info "seeding env file if absent"
if [[ ! -e "$ENV_FILE" ]]; then
  install -m 0640 -o root -g "$GROUP_NAME" "$UNIT_SRC/payjp-ops.env.example" "$ENV_FILE"
  info "seeded $ENV_FILE (0640 root:$GROUP_NAME) — edit POSTGRES_* before enabling"
else
  info "$ENV_FILE exists; not overwriting"
fi

for f in "$WEBHOOK_CRED_ALERTS" "$WEBHOOK_CRED_NORMAL"; do
  if [[ -e "$f" ]]; then
    info "$f exists; not overwriting (encrypt manually to replace)"
  else
    info "no encrypted webhook yet at $f — see Next steps below"
  fi
done

if [[ -e "$LEGACY_WEBHOOK_CRED" ]]; then
  info "legacy $LEGACY_WEBHOOK_CRED detected — remove after the split migration completes:"
  info "  sudo rm $LEGACY_WEBHOOK_CRED"
fi

info "reloading systemd"
systemctl daemon-reload

cat <<EOF

[install] install complete.

Next steps (operator):
  1. Populate $ENV_FILE (non-secret values):
       sudoedit $ENV_FILE
       # POSTGRES_USER / POSTGRES_DB (match app .env)

  2. Encrypt BOTH Discord webhook URLs into systemd credential files.
     (Secrets live nowhere on disk in plaintext; decrypt requires this VPS's
     machine-id + /var/lib/systemd/credential.secret. Snapshot/backup of /etc
     alone is NOT sufficient to decrypt on another host.)

     2a. alerts channel (critical / warn / OPS_STORM):
         sudo bash -c 'systemd-creds encrypt \\
             --name=DISCORD_OPS_WEBHOOK_ALERTS - $WEBHOOK_CRED_ALERTS'
         # paste the alerts webhook URL (single line, no trailing newline), Ctrl+D
         sudo chmod 0600 $WEBHOOK_CRED_ALERTS
         sudo chown root:root $WEBHOOK_CRED_ALERTS

     2b. normal channel (RESOLVED + daily digest):
         sudo bash -c 'systemd-creds encrypt \\
             --name=DISCORD_OPS_WEBHOOK_NORMAL - $WEBHOOK_CRED_NORMAL'
         # paste the normal webhook URL (single line, no trailing newline), Ctrl+D
         sudo chmod 0600 $WEBHOOK_CRED_NORMAL
         sudo chown root:root $WEBHOOK_CRED_NORMAL

     Keep plaintext backups of BOTH URLs in 1Password (Personal is fine) —
     needed for re-encryption on VPS rebuild or rotation.

  3. Verify each encrypted credential decrypts cleanly:
       sudo systemd-creds --name=DISCORD_OPS_WEBHOOK_ALERTS decrypt $WEBHOOK_CRED_ALERTS - \\
         | sed 's#\\(https://discord.com/api/webhooks/\\)[^/]*/.*#\\1<id>/<token>#'
       sudo systemd-creds --name=DISCORD_OPS_WEBHOOK_NORMAL decrypt $WEBHOOK_CRED_NORMAL - \\
         | sed 's#\\(https://discord.com/api/webhooks/\\)[^/]*/.*#\\1<id>/<token>#'
       # Expect (each line): https://discord.com/api/webhooks/<id>/<token>

  4. Remove the legacy single-webhook credential if present:
       sudo rm -f $LEGACY_WEBHOOK_CRED

  5. Script-level dry-run (no Discord post, no systemd unit):
       sudo -u $USER_NAME DRY_RUN=1 $INSTALL_DIR/check-host.sh
       sudo -u $USER_NAME DRY_RUN=1 $INSTALL_DIR/check-docker.sh
       sudo -u $USER_NAME DRY_RUN=1 $INSTALL_DIR/daily-digest.sh

  6. Live smoke — run each service once (systemd loads the encrypted credentials):
       sudo systemctl start payjp-ops-check.service
       journalctl -u payjp-ops-check.service -n 40 --no-pager
       # Expect: fire events appear in the alerts channel
       sudo systemctl start payjp-ops-digest.service
       journalctl -u payjp-ops-digest.service -n 40 --no-pager
       # Expect: digest embed appears in the normal channel
       sudo systemctl start payjp-ops-backup.service
       journalctl -u payjp-ops-backup.service -n 40 --no-pager
       sudo ls -lt /var/backups/payjp-db/ | head
       # Expect: new payjp_<ts>Z.sql.gz of non-trivial size (>500B minimum enforced)

  7. Enable timers:
       sudo systemctl enable --now payjp-ops-check.timer payjp-ops-digest.timer payjp-ops-backup.timer

  8. Rotation (when a webhook URL is regenerated — do per-channel):
       sudo rm $WEBHOOK_CRED_ALERTS    # or $WEBHOOK_CRED_NORMAL
       # repeat the matching sub-step of 2 with the new URL
       sudo systemctl restart payjp-ops-check.timer payjp-ops-digest.timer payjp-ops-backup.timer

Uninstall: sudo $0 --uninstall
EOF
