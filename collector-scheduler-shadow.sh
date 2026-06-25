#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${GBRAIN_COLLECTOR_APP_DIR:-/app}"
STATE_DIR="${GBRAIN_COLLECTOR_SCHEDULER_STATE_DIR:-/tmp/gbrain-collector-scheduler}"
TICK_SECONDS="${GBRAIN_COLLECTOR_SCHEDULER_TICK_SECONDS:-300}"

export GBRAIN_COLLECTOR_SHADOW="${GBRAIN_COLLECTOR_SHADOW:-1}"

mkdir -p "$STATE_DIR"

now_epoch() {
  date +%s
}

should_run() {
  local lane="$1"
  local interval="$2"
  local stamp="$STATE_DIR/$lane.last_run"
  local now last

  now="$(now_epoch)"
  if [[ ! -f "$stamp" ]]; then
    return 0
  fi

  last="$(cat "$stamp" 2>/dev/null || printf '0')"
  [[ $((now - last)) -ge "$interval" ]]
}

mark_run() {
  local lane="$1"
  now_epoch > "$STATE_DIR/$lane.last_run"
}

run_lane() {
  local lane="$1"
  shift

  printf '{"event":"collector_scheduler_lane_start","lane":"%s","shadow":"%s","ts":"%s"}\n' \
    "$lane" "$GBRAIN_COLLECTOR_SHADOW" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if "$@"; then
    printf '{"event":"collector_scheduler_lane_complete","lane":"%s","ok":true,"ts":"%s"}\n' \
      "$lane" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    mark_run "$lane"
    return 0
  fi

  local status
  status=$?
  printf '{"event":"collector_scheduler_lane_complete","lane":"%s","ok":false,"exit_code":%s,"ts":"%s"}\n' \
    "$lane" "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
  mark_run "$lane"
  return "$status"
}

run_due_lanes_once() {
  local failures=0

  if [[ "${GBRAIN_COLLECTOR_ENABLE_AV_M365:-1}" == "1" ]] && should_run "av_m365" "${GBRAIN_PHASE7_AV_M365_INTERVAL_SECONDS:-3600}"; then
    run_lane "av_m365" env GBRAIN_COLLECTOR_RUN_ONCE=1 "$APP_DIR/collector-av-m365-shadow.sh" || failures=$((failures + 1))
  fi

  if [[ "${GBRAIN_COLLECTOR_ENABLE_GMAIL:-1}" == "1" ]] && should_run "gmail_forward" "${GBRAIN_GMAIL_FORWARD_INTERVAL_SECONDS:-1800}"; then
    run_lane "gmail_forward" env GBRAIN_COLLECTOR_RUN_ONCE=1 "$APP_DIR/collector-gmail-forward-sync.sh" || failures=$((failures + 1))
  fi

  if [[ "${GBRAIN_COLLECTOR_ENABLE_CALENDAR:-1}" == "1" ]] && should_run "calendar_forward" "${GBRAIN_CALENDAR_FORWARD_INTERVAL_SECONDS:-21600}"; then
    run_lane "calendar_forward" env GBRAIN_COLLECTOR_RUN_ONCE=1 "$APP_DIR/collector-calendar-forward-sync.sh" || failures=$((failures + 1))
  fi

  return "$failures"
}

if [[ "${GBRAIN_COLLECTOR_RUN_ONCE:-0}" == "1" ]]; then
  run_due_lanes_once
  exit $?
fi

while true; do
  run_due_lanes_once || true
  sleep "$TICK_SECONDS"
done
