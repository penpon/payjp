#!/usr/bin/env bash
# Docker-layer signals.
# Codes: DOCKER_DAEMON_DOWN · DOCKER_CONTAINER_EXITED · DOCKER_RESTART_DELTA · DOCKER_HEALTH_UNHEALTHY

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
ops_strict_mode
# shellcheck source=lib/thresholds.conf
source "$SCRIPT_DIR/lib/thresholds.conf"
# shellcheck source=lib/dedup.sh
source "$SCRIPT_DIR/lib/dedup.sh"
NOTIFY_SCRIPT="$SCRIPT_DIR/notify.sh"
export NOTIFY_SCRIPT
ops_state_init

: "${COMPOSE_PROJECT:=payjp}"
EXPECTED_SERVICES="db api admin-api nginx"

check_daemon() {
  local state
  if ! state=$(sudo -n systemctl is-active docker 2>/dev/null); then
    state="unknown"
  fi
  if [[ "$state" != "active" ]]; then
    handle DOCKER_DAEMON_DOWN critical fire \
      "docker daemon not active (state=${state})" \
      "sudo systemctl status docker"
    return 1
  fi
  handle DOCKER_DAEMON_DOWN critical clear "" "docker daemon active"
  return 0
}

check_containers_exited() {
  local out
  if ! out=$(sudo -n docker ps -a \
      --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
      --filter status=exited \
      --format '{{.Names}} status={{.Status}}' 2>/dev/null); then
    log_warn "docker ps failed"
    return 0
  fi
  if [[ -n "$out" ]]; then
    handle DOCKER_CONTAINER_EXITED critical fire \
      "docker container(s) exited" \
      "$out"
  else
    handle DOCKER_CONTAINER_EXITED critical clear "" "no exited containers"
  fi
}

check_restart_delta() {
  local state_file="$OPS_STATE_DIR/state.d/DOCKER_RESTART_DELTA.counts"
  declare -A prev_counts
  if [[ -e "$state_file" ]]; then
    while IFS='=' read -r k v; do
      [[ -n "$k" ]] && prev_counts[$k]="$v"
    done < "$state_file"
  fi
  local fired=""
  local new_state=""
  local service container new_count last_count
  for service in $EXPECTED_SERVICES; do
    container="${COMPOSE_PROJECT}-${service}-1"
    if ! new_count=$(sudo -n docker inspect --format '{{.RestartCount}}' "$container" 2>/dev/null); then
      continue
    fi
    last_count="${prev_counts[$container]:-}"
    new_state+="${container}=${new_count}"$'\n'
    if [[ -n "$last_count" ]] && (( new_count > last_count )); then
      fired+="${container}: ${last_count} → ${new_count}"$'\n'
    fi
  done
  printf '%s' "$new_state" > "$state_file"
  if [[ -n "$fired" ]]; then
    handle DOCKER_RESTART_DELTA warn fire \
      "container restart-count increased since last tick" \
      "$fired"
  else
    handle DOCKER_RESTART_DELTA warn clear "" "no new restarts"
  fi
}

check_health_unhealthy() {
  local container="${COMPOSE_PROJECT}-db-1" status
  if ! status=$(sudo -n docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null); then
    log_warn "docker inspect health failed" "container" "$container"
    return 0
  fi
  case "$status" in
    unhealthy)
      handle DOCKER_HEALTH_UNHEALTHY critical fire \
        "${container} healthcheck: unhealthy" \
        "sudo docker inspect --format '{{json .State.Health}}' ${container}"
      ;;
    healthy|starting|"")
      handle DOCKER_HEALTH_UNHEALTHY critical clear "" "${container} health=${status:-unknown}"
      ;;
    *)
      log_warn "unexpected health status" "status" "$status"
      ;;
  esac
}

safe check_daemon
safe check_containers_exited
safe check_restart_delta
safe check_health_unhealthy
