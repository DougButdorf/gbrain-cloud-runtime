#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${GBRAIN_COLLECTOR_APP_DIR:-}" ]]; then
  APP_DIR="$GBRAIN_COLLECTOR_APP_DIR"
elif [[ -d /app/collectors ]]; then
  APP_DIR="/app"
else
  APP_DIR="$SCRIPT_DIR"
fi
MAILBOX="${GBRAIN_PHASE7_AV_M365_MAILBOX:-doug@advancedvirology.com}"
MAX="${GBRAIN_PHASE7_AV_M365_MAX:-1}"
SKIP="${GBRAIN_PHASE7_AV_M365_SKIP:-0}"
OUT_DIR="${GBRAIN_PHASE7_AV_M365_OUT_DIR:-$(mktemp -d /tmp/gbrain-av-m365-shadow.XXXXXX)}"
INTERVAL_SECONDS="${GBRAIN_PHASE7_AV_M365_INTERVAL_SECONDS:-3600}"

export GBRAIN_COLLECTOR_SHADOW="${GBRAIN_COLLECTOR_SHADOW:-1}"
export GBRAIN_WORKSPACE="${GBRAIN_WORKSPACE:-$APP_DIR}"
export GBRAIN_COLLECTOR_HOME="${GBRAIN_COLLECTOR_HOME:-/tmp/gbrain-collector}"
export GBRAIN_READABLE_ATTACHMENT_EXTRACTOR="${GBRAIN_READABLE_ATTACHMENT_EXTRACTOR:-$APP_DIR/collectors/lib/readable_attachment_extract.py}"
export AV_M365_ENV_FILE="${AV_M365_ENV_FILE:-/run/secrets/av-m365-env}"
export AV_M365_GRAPH_TOKEN_FILE="${AV_M365_GRAPH_TOKEN_FILE:-/run/secrets/av-m365-graph-token.json}"
export GBRAIN_PHASE7_STATE_ROOT="${GBRAIN_PHASE7_STATE_ROOT:-/tmp/gbrain-av-m365-state}"
export GBRAIN_PHASE7_AV_M365_ATTACHMENT_STATE_FILE="${GBRAIN_PHASE7_AV_M365_ATTACHMENT_STATE_FILE:-/tmp/gbrain-av-m365-attachment-state.json}"
export GBRAIN_PHASE7_AV_M365_MESSAGE_STATE_FILE="${GBRAIN_PHASE7_AV_M365_MESSAGE_STATE_FILE:-/tmp/gbrain-av-m365-message-state.json}"

mkdir -p "$GBRAIN_COLLECTOR_HOME" "$GBRAIN_PHASE7_STATE_ROOT" "$(dirname "$GBRAIN_PHASE7_AV_M365_ATTACHMENT_STATE_FILE")" "$OUT_DIR"

run_once() {
  printf '{"event":"av_m365_shadow_start","mailbox":"%s","max":%s,"skip":%s,"ts":"%s"}\n' \
    "$MAILBOX" "$MAX" "$SKIP" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  bun "$APP_DIR/collectors/gbrain-phase7-av-m365-graph-batch.js" "$MAILBOX" "$MAX" "$OUT_DIR" "$SKIP"
  printf '{"event":"av_m365_shadow_complete","ok":true,"ts":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

if [[ "${GBRAIN_COLLECTOR_RUN_ONCE:-0}" == "1" ]]; then
  run_once
  exit $?
fi

while true; do
  run_once || true
  sleep "$INTERVAL_SECONDS"
done
