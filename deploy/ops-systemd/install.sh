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
ENV_FILE="/etc/payjp-ops/env"
ENV_DIR="/etc/payjp-ops"
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
  systemd units, install sudoers drop-in, seed /etc/payjp-ops/env template.
uninstall: disable timers, remove units + scripts + sudoers. Preserves state
  dir, env file, and user (see docs/ops/alerts.md for full removal).
USAGE
      exit 0 ;;
    *) die "unknown arg: $arg" ;;
  esac
done

if [[ "$MODE" == "uninstall" ]]; then
  info "disabling timers"
  systemctl disable --now payjp-ops-check.timer payjp-ops-digest.timer 2>/dev/null || true
  info "removing unit files"
  rm -f "$SYSTEMD_DIR"/payjp-ops-check.service "$SYSTEMD_DIR"/payjp-ops-check.timer
  rm -f "$SYSTEMD_DIR"/payjp-ops-digest.service "$SYSTEMD_DIR"/payjp-ops-digest.timer
  systemctl daemon-reload
  info "removing install dir"
  rm -rf "$INSTALL_DIR"
  info "removing sudoers drop-in"
  rm -f "$SUDOERS_FILE"
  cat <<EOF
[install] uninstall complete.
  Preserved (delete manually if desired):
    $STATE_DIR  (postmortem state)
    $ENV_FILE   (contains 1P token — revoke manually in 1P console)
    user        $USER_NAME
EOF
  exit 0
fi

# ---- install ----
info "creating system user $USER_NAME"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin \
    --home-dir "$STATE_DIR" "$USER_NAME"
fi

info "creating directories"
install -d -o "$USER_NAME" -g "$GROUP_NAME" -m 0750 "$STATE_DIR" "$STATE_DIR/state.d"
install -d -m 0755 "$ENV_DIR"
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

info "installing systemd units"
install -m 0644 "$UNIT_SRC/payjp-ops-check.service"  "$SYSTEMD_DIR/"
install -m 0644 "$UNIT_SRC/payjp-ops-check.timer"    "$SYSTEMD_DIR/"
install -m 0644 "$UNIT_SRC/payjp-ops-digest.service" "$SYSTEMD_DIR/"
install -m 0644 "$UNIT_SRC/payjp-ops-digest.timer"   "$SYSTEMD_DIR/"

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
    /usr/bin/stat -c * /var/backups/hayane/*, \
    /usr/bin/stat -c * /var/lib/docker/volumes/payjp_nginx_logs/_data/*, \
    /usr/bin/tail -n * /var/lib/docker/volumes/payjp_nginx_logs/_data/access.log, \
    /usr/bin/tail -n * /var/lib/docker/volumes/payjp_nginx_logs/_data/error.log
payjp-ops ALL=(root) NOPASSWD: PAYJP_OPS_CMDS
SUDOERS
chmod 0440 "$SUDOERS_FILE"
visudo -c -f "$SUDOERS_FILE" >/dev/null || die "sudoers syntax invalid"

info "seeding $ENV_FILE if absent"
if [[ ! -e "$ENV_FILE" ]]; then
  install -m 0400 -o root -g root "$UNIT_SRC/payjp-ops.env.example" "$ENV_FILE"
  info "seeded empty $ENV_FILE — edit before enabling timers"
else
  info "$ENV_FILE exists; not overwriting"
fi

info "reloading systemd"
systemctl daemon-reload

cat <<EOF

[install] install complete.

Next steps (operator):
  1. Edit $ENV_FILE and populate OP_SERVICE_ACCOUNT_TOKEN, PGUSER, PGDB.
  2. Dry-run (each check, or all):
       sudo -u $USER_NAME DRY_RUN=1 $INSTALL_DIR/check-host.sh
       sudo -u $USER_NAME DRY_RUN=1 $INSTALL_DIR/check-docker.sh
       sudo -u $USER_NAME DRY_RUN=1 $INSTALL_DIR/check-nginx.sh
       sudo -u $USER_NAME DRY_RUN=1 $INSTALL_DIR/check-app.sh
       sudo -u $USER_NAME DRY_RUN=1 $INSTALL_DIR/daily-digest.sh
  3. Enable the 5-min polling timer:
       sudo systemctl enable --now payjp-ops-check.timer
  4. Enable the daily digest timer:
       sudo systemctl enable --now payjp-ops-digest.timer
  5. Watch logs:
       journalctl -u payjp-ops-check.service -f
       journalctl -u payjp-ops-digest.service -f

Uninstall: sudo $0 --uninstall
EOF
