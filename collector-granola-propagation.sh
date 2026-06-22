#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${GBRAIN_COLLECTOR_APP_DIR:-/app}"
LOG_DIR="${GBRAIN_COLLECTOR_LOG_DIR:-/data/collector-logs}"
mkdir -p "$LOG_DIR"
export GBRAIN_COLLECTOR_SHADOW="${GBRAIN_COLLECTOR_SHADOW:-1}"
export GBRAIN_POSTGRES_MODULE="${GBRAIN_POSTGRES_MODULE:-/opt/gbrain-src/node_modules/postgres}"
export GBRAIN_GRANOLA_PROPAGATION_LIMIT="${GBRAIN_GRANOLA_PROPAGATION_LIMIT:-50}"
export GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_LINKS="${GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_LINKS:-50}"
export GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_TIMELINES="${GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_TIMELINES:-50}"
export GBRAIN_GRANOLA_PROPAGATION_INTERVAL_SECONDS="${GBRAIN_GRANOLA_PROPAGATION_INTERVAL_SECONDS:-21600}"

args=(
  --json
  --limit="${GBRAIN_GRANOLA_PROPAGATION_LIMIT}"
  --max-new-links="${GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_LINKS}"
  --max-new-timelines="${GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_TIMELINES}"
)

if [[ "${GBRAIN_COLLECTOR_SHADOW}" == "1" ]]; then
  args+=(--shadow)
else
  args+=(--apply)
fi

run_once() {
  printf '{"event":"granola_propagation_start","shadow":"%s","ts":"%s"}\n' \
    "${GBRAIN_COLLECTOR_SHADOW}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if bun "$APP_DIR/collectors/gbrain-granola-propagation.js" "${args[@]}" "$@"; then
    printf '{"event":"granola_propagation_complete","ok":true,"ts":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  else
    status=$?
    printf '{"event":"granola_propagation_complete","ok":false,"exit_code":%s,"ts":"%s"}\n' \
      "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
    return "$status"
  fi
}

if [[ "${GBRAIN_COLLECTOR_RUN_ONCE:-0}" == "1" ]]; then
  run_once "$@"
  exit $?
fi

while true; do
  run_once "$@" || true
  sleep "${GBRAIN_GRANOLA_PROPAGATION_INTERVAL_SECONDS}"
done
