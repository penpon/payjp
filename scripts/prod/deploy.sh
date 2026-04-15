#!/usr/bin/env bash
# Production deploy script (manual run on VPS):
#   frontend build -> admin frontend build -> compose up -d -> health wait -> smoke test.
# Requires repo-root `.env` and interactive `op signin`.
#
# Env overrides:
#   DEPLOY_LOG                     log path (default: $ROOT/.deploy.log)
#   LOCKDIR                        deploy lock dir (default: /tmp/payjp-deploy.lock)
#   DEPLOY_SMOKE_URL               smoke GET URL (default: https://api.and--line.com/health)
#   HEALTH_WAIT_SECS               max wait for compose healthy (default: 300)
#   DEPLOY_NOTIFY_MIN_INTERVAL_SEC passed to notify.sh GLOBAL_MIN_INTERVAL_SEC (default: 0)
#   DEPLOY_LOG_MAX_MB              rotate .deploy.log when larger than this size (default: 20)
#   ALLOW_DIRTY_GIT                set to 1 to allow deploy from dirty working tree
#   MIN_FREE_ROOT_KB               minimum free disk on / (default: 2097152 = 2GiB)
#   DEPLOY_OPS_STATE_DIR           notify.sh/dedup state dir (default: ~/.local/state/payjp-ops). Required: user-writable; systemd ops use /var/lib/payjp-ops (root).
set -euo pipefail
umask 027

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DEPLOY_LOG="${DEPLOY_LOG:-$ROOT/.deploy.log}"
LOCKDIR="${LOCKDIR:-/tmp/payjp-deploy.lock}"
SMOKE_URL="${DEPLOY_SMOKE_URL:-https://api.and--line.com/health}"
HEALTH_WAIT_SECS="${HEALTH_WAIT_SECS:-300}"
NOTIFY_SH="$ROOT/scripts/ops/notify.sh"
NOTIFY_MIN_INTERVAL_SEC="${DEPLOY_NOTIFY_MIN_INTERVAL_SEC:-0}"
DEPLOY_LOG_MAX_MB="${DEPLOY_LOG_MAX_MB:-20}"
MIN_FREE_ROOT_KB="${MIN_FREE_ROOT_KB:-2097152}"
# notify.sh sources dedup.sh, which defaults OPS_STATE_DIR to /var/lib/payjp-ops (not writable as deploy user).
DEPLOY_OPS_STATE_DIR="${DEPLOY_OPS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/payjp-ops}"

# Must match service names in docker-compose.yml and all must expose healthcheck.
COMPOSE_HEALTH_SERVICES=(db api admin-api nginx)

AFTER_OP=0
DEPLOY_FAILED=0
CURRENT_STEP="bootstrap"
START_TS=0
SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
HOST_SHORT="$(hostname -s 2>/dev/null || hostname || echo unknown-host)"
NOTIFY_WEBHOOK_BOOTSTRAP_ATTEMPTED=0

log() {
	printf '[deploy] %s\n' "$*"
}

require_file() {
	if [[ ! -f "$1" ]]; then
		log "Error: missing file: $1"
		exit 1
	fi
}

require_cmd() {
	local cmd="$1"
	if ! command -v "$cmd" >/dev/null 2>&1; then
		log "Error: required command not found: $cmd"
		exit 1
	fi
}

preflight() {
	require_file "$ROOT/.env"
	require_cmd op
	require_cmd docker
	require_cmd curl
	require_cmd git
	require_cmd npm
	require_cmd awk

	if ! docker compose version >/dev/null 2>&1; then
		log "Error: docker compose plugin is not available."
		exit 1
	fi

	if [[ "${ALLOW_DIRTY_GIT:-0}" != "1" ]] && [[ -n "$(git status --porcelain 2>/dev/null || true)" ]]; then
		log "Error: git working tree is not clean. Commit/stash first, or set ALLOW_DIRTY_GIT=1 for emergency deploy."
		exit 1
	fi

	local avail_kb
	avail_kb="$(df -Pk / | awk 'NR==2 {print $4}')"
	if [[ -z "$avail_kb" || "$avail_kb" -lt "$MIN_FREE_ROOT_KB" ]]; then
		log "Error: insufficient free disk on / (need >= ${MIN_FREE_ROOT_KB}kB)."
		exit 1
	fi
}

acquire_lock() {
	if mkdir "$LOCKDIR" 2>/dev/null; then
		printf '%s\n' "$$" >"$LOCKDIR/pid"
		printf '%s\n' "$HOST_SHORT" >"$LOCKDIR/host"
		date -u +%Y-%m-%dT%H:%M:%SZ >"$LOCKDIR/started_at"
		return 0
	fi

	local old_pid="" old_host="unknown" old_started="unknown"
	if [[ -f "$LOCKDIR/pid" ]]; then
		old_pid="$(cat "$LOCKDIR/pid" 2>/dev/null || true)"
	fi
	if [[ -f "$LOCKDIR/host" ]]; then
		old_host="$(cat "$LOCKDIR/host" 2>/dev/null || echo unknown)"
	fi
	if [[ -f "$LOCKDIR/started_at" ]]; then
		old_started="$(cat "$LOCKDIR/started_at" 2>/dev/null || echo unknown)"
	fi

	if [[ -n "$old_pid" ]] && [[ "$old_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$old_pid" 2>/dev/null; then
		log "Removing stale deploy lock (pid=${old_pid} host=${old_host} started_at=${old_started})"
		rm -f "$LOCKDIR/pid" "$LOCKDIR/host" "$LOCKDIR/started_at"
		rmdir "$LOCKDIR" 2>/dev/null || true
		if mkdir "$LOCKDIR" 2>/dev/null; then
			printf '%s\n' "$$" >"$LOCKDIR/pid"
			printf '%s\n' "$HOST_SHORT" >"$LOCKDIR/host"
			date -u +%Y-%m-%dT%H:%M:%SZ >"$LOCKDIR/started_at"
			return 0
		fi
	fi

	log "Error: another deploy holds lock (pid=${old_pid:-unknown} host=${old_host} started_at=${old_started})."
	log "Remove $LOCKDIR only after confirming no active deploy."
	exit 1
}

release_lock() {
	rm -f "$LOCKDIR/pid" "$LOCKDIR/host" "$LOCKDIR/started_at" 2>/dev/null || true
	rmdir "$LOCKDIR" 2>/dev/null || true
}

ensure_notify_state_dir() {
	# dedup.sh ops_state_init needs mkdir under OPS_STATE_DIR; fail early with a clear message.
	if ! mkdir -p "$DEPLOY_OPS_STATE_DIR/state.d"; then
		log "Error: cannot create notify state directory: $DEPLOY_OPS_STATE_DIR"
		log "Set DEPLOY_OPS_STATE_DIR to a writable path (default: ~/.local/state/payjp-ops)."
		exit 1
	fi
}

bootstrap_notify_webhooks_from_systemd_creds() {
	if (( AFTER_OP != 1 )) || (( NOTIFY_WEBHOOK_BOOTSTRAP_ATTEMPTED == 1 )); then
		return 0
	fi
	NOTIFY_WEBHOOK_BOOTSTRAP_ATTEMPTED=1

	# If .env already resolves any webhook key via op run, no bootstrap is needed.
	if op run --env-file=.env -- bash -lc '[[ -n "${DISCORD_OPS_WEBHOOK_NORMAL:-}" || -n "${DISCORD_OPS_WEBHOOK_ALERTS:-}" || -n "${DISCORD_OPS_WEBHOOK:-}" ]]' >/dev/null 2>&1; then
		return 0
	fi

	local cred_dir cred_name cred_path value
	local loaded=0
	local has_any_cred=0
	cred_dir="${DEPLOY_OPS_CREDENTIALS_DIR:-/etc/payjp-ops/creds}"
	if [[ ! -d "$cred_dir" ]]; then
		return 0
	fi
	if ! command -v sudo >/dev/null 2>&1 || ! command -v systemd-creds >/dev/null 2>&1; then
		return 0
	fi
	# /etc/payjp-ops/creds is root-only (0700), so existence checks must run under sudo.
	# First try non-interactive checks; if not authorized, ask once.
	if ! sudo -n test -f "$cred_dir/DISCORD_OPS_WEBHOOK_NORMAL" >/dev/null 2>&1 &&
		! sudo -n test -f "$cred_dir/DISCORD_OPS_WEBHOOK_ALERTS" >/dev/null 2>&1 &&
		! sudo -n test -f "$cred_dir/DISCORD_OPS_WEBHOOK" >/dev/null 2>&1; then
		if sudo -n true >/dev/null 2>&1; then
			return 0
		fi
		log "Info: sudo auth required once to enable deploy notifications from $cred_dir."
		if ! sudo -v; then
			log "Warning: sudo auth failed; deploy notifications may remain disabled."
			return 0
		fi
	fi

	for cred_name in DISCORD_OPS_WEBHOOK_NORMAL DISCORD_OPS_WEBHOOK_ALERTS DISCORD_OPS_WEBHOOK; do
		cred_path="$cred_dir/$cred_name"
		if ! sudo test -f "$cred_path" >/dev/null 2>&1; then
			continue
		fi
		has_any_cred=1
		if value="$(sudo systemd-creds --name="$cred_name" decrypt "$cred_path" - 2>/dev/null)" && [[ -n "$value" ]]; then
			printf -v "$cred_name" '%s' "$value"
			export "$cred_name"
			loaded=1
		fi
	done

	if (( loaded == 1 )); then
		log "Loaded Discord webhook credentials from systemd-creds for manual deploy notifications."
	elif (( has_any_cred == 1 )); then
		log "Warning: webhook credential files exist but decrypt failed; check systemd-creds setup."
	fi
}

rotate_deploy_log_if_needed() {
	if [[ ! -f "$DEPLOY_LOG" ]]; then
		return 0
	fi
	local size_bytes max_bytes
	size_bytes="$(wc -c <"$DEPLOY_LOG" 2>/dev/null || echo 0)"
	max_bytes=$((DEPLOY_LOG_MAX_MB * 1024 * 1024))
	if [[ "$size_bytes" =~ ^[0-9]+$ ]] && (( size_bytes > max_bytes )); then
		local rotated
		rotated="${DEPLOY_LOG}.$(date -u +%Y%m%dT%H%M%SZ)"
		mv "$DEPLOY_LOG" "$rotated"
	fi
}

notify_safe() {
	local severity="$1"
	local code="$2"
	local title="$3"
	local body="${4:-}"
	local -a notify_cmd
	local webhook_kind webhook_env_var

	if [[ ! -f "$NOTIFY_SH" ]]; then
		log "Warning: notify script missing; skipping Discord ($code)."
		return 0
	fi

	case "$severity" in
		normal)
			webhook_kind="normal"
			webhook_env_var="DISCORD_OPS_WEBHOOK_NORMAL"
			;;
		*)
			webhook_kind="alerts"
			webhook_env_var="DISCORD_OPS_WEBHOOK_ALERTS"
			;;
	esac

	bootstrap_notify_webhooks_from_systemd_creds

	# Skip notify early when no webhook is configured in this execution context.
	# Legacy single webhook (DISCORD_OPS_WEBHOOK) is accepted for split migration compatibility.
	if [[ -z "${!webhook_env_var:-}" ]] &&
		[[ -z "${DISCORD_OPS_WEBHOOK:-}" ]] &&
		{ [[ -z "${CREDENTIALS_DIRECTORY:-}" ]] || { [[ ! -r "$CREDENTIALS_DIRECTORY/$webhook_env_var" ]] && [[ ! -r "$CREDENTIALS_DIRECTORY/DISCORD_OPS_WEBHOOK" ]]; }; } &&
		{ (( AFTER_OP != 1 )) || ! op run --env-file=.env -- bash -lc "[[ -n \"\${$webhook_env_var:-}\" || -n \"\${DISCORD_OPS_WEBHOOK:-}\" ]]" >/dev/null 2>&1; }; then
		log "Discord notify skipped for $code (${webhook_kind} webhook unavailable)."
		return 0
	fi

	notify_cmd=(
		env
		GLOBAL_MIN_INTERVAL_SEC="$NOTIFY_MIN_INTERVAL_SEC"
		OPS_STATE_DIR="$DEPLOY_OPS_STATE_DIR"
		bash "$NOTIFY_SH"
		--severity "$severity"
		--code "$code"
		--title "$title"
		--body "$body"
	)

	# Manual deploys resolve op:// values from .env via `op run` after interactive signin.
	if (( AFTER_OP == 1 )); then
		if ! op run --env-file=.env -- "${notify_cmd[@]}"; then
			log "Warning: notify failed for $code (deploy continues)."
		fi
		return 0
	fi

	if ! "${notify_cmd[@]}"; then
		log "Warning: notify failed for $code (deploy continues)."
	fi
}

deploy_fail() {
	local reason="$1"
	local tail_log

	if (( DEPLOY_FAILED == 1 )); then
		exit 1
	fi
	DEPLOY_FAILED=1

	tail_log="$(tail -n 50 "$DEPLOY_LOG" 2>/dev/null || true)"
	log "Deploy failed at step=${CURRENT_STEP} reason=${reason}"
	if (( AFTER_OP == 1 )); then
		notify_safe warn DEPLOY_FAIL "失敗(${reason})" "sha=${SHA} step=${CURRENT_STEP}
${tail_log}"
	fi
	exit 1
}

on_signal() {
	local sig="$1"
	log "Received ${sig}; aborting deploy."
	deploy_fail "signal-${sig}"
}

run_or_fail() {
	local step="$1"
	shift
	CURRENT_STEP="$step"
	"$@" || deploy_fail "$step"
}

wait_compose_healthy() {
	local deadline=$((SECONDS + HEALTH_WAIT_SECS))
	local next_progress_log=$SECONDS

	while (( SECONDS < deadline )); do
		local table
		table="$(docker compose ps --format '{{.Service}}\t{{.Health}}\t{{.State}}' 2>/dev/null || true)"

		local all_healthy=true
		local pending=()
		local svc
		for svc in "${COMPOSE_HEALTH_SERVICES[@]}"; do
			local line health state
			line="$(printf '%s\n' "$table" | awk -F'\t' -v s="$svc" '$1==s {print; exit}')"
			if [[ -z "$line" ]]; then
				all_healthy=false
				pending+=("${svc}=missing")
				continue
			fi

			health="$(printf '%s' "$line" | awk -F'\t' '{print $2}')"
			state="$(printf '%s' "$line" | awk -F'\t' '{print $3}')"

			if [[ "$state" == "exited" ]] || [[ "$state" == "dead" ]]; then
				log "Compose service ${svc} state=${state}"
				docker compose ps 2>/dev/null || true
				return 1
			fi
			if [[ "$health" == "unhealthy" ]]; then
				log "Compose service ${svc} health=unhealthy"
				docker compose ps 2>/dev/null || true
				return 1
			fi

			if [[ "$state" != "running" ]] || [[ "$health" != "healthy" ]]; then
				all_healthy=false
				pending+=("${svc}=${state:-unknown}/${health:-none}")
			fi
		done

		if [[ "$all_healthy" == true ]]; then
			return 0
		fi

		if (( SECONDS >= next_progress_log )); then
			log "Waiting for healthy services: ${pending[*]}"
			next_progress_log=$((SECONDS + 15))
		fi
		sleep 2
	done

	log "Timeout waiting for compose health (${HEALTH_WAIT_SECS}s)."
	docker compose ps 2>/dev/null || true
	return 1
}

main() {
	CURRENT_STEP="preflight"
	preflight

	CURRENT_STEP="lock"
	acquire_lock
	trap release_lock EXIT
	trap 'on_signal INT' INT
	trap 'on_signal TERM' TERM

	rotate_deploy_log_if_needed
	exec > >(tee -a "$DEPLOY_LOG") 2>&1

	log "Deploy start sha=${SHA} host=${HOST_SHORT}"
	START_TS=$(date +%s)

	CURRENT_STEP="op signin"
	if ! eval "$(op signin)"; then
		log "Error: op signin failed or was cancelled."
		exit 1
	fi
	AFTER_OP=1

	ensure_notify_state_dir

	CURRENT_STEP="notify start"
	notify_safe normal DEPLOY_START "開始" "sha=${SHA} host=${HOST_SHORT} log=${DEPLOY_LOG} ops_state=${DEPLOY_OPS_STATE_DIR}"

	run_or_fail "build:frontend" op run --env-file=.env -- npm run build:frontend
	run_or_fail "build:admin-frontend" op run --env-file=.env -- npm run build:admin-frontend
	run_or_fail "compose config" op run --env-file=.env -- docker compose config -q
	run_or_fail "compose up" op run --env-file=.env -- docker compose up -d --build --force-recreate

	CURRENT_STEP="compose health wait"
	wait_compose_healthy || deploy_fail "compose health wait"

	CURRENT_STEP="smoke test"
	curl -fsS --max-time 20 "$SMOKE_URL" >/dev/null || deploy_fail "smoke ${SMOKE_URL}"

	local duration
	duration=$(( $(date +%s) - START_TS ))
	CURRENT_STEP="notify success"
	notify_safe normal DEPLOY_SUCCESS "完了" "sha=${SHA} duration=${duration}s smoke=${SMOKE_URL}"
	log "Deploy success sha=${SHA} duration=${duration}s"
}

main "$@"
