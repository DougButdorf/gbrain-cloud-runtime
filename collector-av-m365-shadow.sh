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
INTERVAL_SECONDS="${GBRAIN_PHASE7_AV_M365_INTERVAL_SECONDS:-3600}"
REQUESTED_SHADOW="${GBRAIN_COLLECTOR_SHADOW:-1}"
IMPORT_TIMEOUT_SECONDS="${GBRAIN_PHASE7_IMPORT_TIMEOUT_SECONDS:-900}"
EMBED_TIMEOUT_SECONDS="${GBRAIN_PHASE7_EMBED_TIMEOUT_SECONDS:-900}"

export GBRAIN_COLLECTOR_STATE_ENABLED="${GBRAIN_COLLECTOR_STATE_ENABLED:-1}"
export GBRAIN_WORKSPACE="${GBRAIN_WORKSPACE:-$APP_DIR}"
export GBRAIN_COLLECTOR_HOME="${GBRAIN_COLLECTOR_HOME:-/tmp/gbrain-collector}"
export GBRAIN_READABLE_ATTACHMENT_EXTRACTOR="${GBRAIN_READABLE_ATTACHMENT_EXTRACTOR:-$APP_DIR/collectors/lib/readable_attachment_extract.py}"
export AV_M365_ENV_FILE="${AV_M365_ENV_FILE:-/run/secrets/av-m365-env}"
export AV_M365_GRAPH_TOKEN_FILE="${AV_M365_GRAPH_TOKEN_FILE:-/run/secrets/av-m365-graph-token.json}"
export GBRAIN_PHASE7_STATE_ROOT="${GBRAIN_PHASE7_STATE_ROOT:-/tmp/gbrain-av-m365-state}"
export GBRAIN_PHASE7_AV_M365_ATTACHMENT_STATE_FILE="${GBRAIN_PHASE7_AV_M365_ATTACHMENT_STATE_FILE:-/tmp/gbrain-av-m365-attachment-state.json}"
export GBRAIN_PHASE7_AV_M365_MESSAGE_STATE_FILE="${GBRAIN_PHASE7_AV_M365_MESSAGE_STATE_FILE:-/tmp/gbrain-av-m365-message-state.json}"

mkdir -p "$GBRAIN_COLLECTOR_HOME" "$GBRAIN_PHASE7_STATE_ROOT" "$(dirname "$GBRAIN_PHASE7_AV_M365_ATTACHMENT_STATE_FILE")"

run_with_timeout() {
  local seconds="$1"
  shift
  timeout "$seconds" "$@"
}

run_once() {
  local out_dir import_dir result_file import_log embed_log pending_file requested_shadow
  out_dir="${GBRAIN_PHASE7_AV_M365_OUT_DIR:-$(mktemp -d /tmp/gbrain-av-m365-shadow.XXXXXX)}"
  import_dir="$(mktemp -d /tmp/gbrain-av-m365-import.XXXXXX)"
  result_file="$(mktemp /tmp/gbrain-av-m365-result.XXXXXX)"
  import_log="$(mktemp /tmp/gbrain-av-m365-import-log.XXXXXX)"
  embed_log="$(mktemp /tmp/gbrain-av-m365-embed-log.XXXXXX)"
  requested_shadow="$REQUESTED_SHADOW"

  cleanup_run() {
    rm -f "$result_file" "$import_log" "$embed_log"
    rm -rf "$import_dir"
    if [[ -z "${GBRAIN_PHASE7_AV_M365_OUT_DIR:-}" ]]; then
      rm -rf "$out_dir"
    fi
  }
  trap cleanup_run RETURN

  printf '{"event":"av_m365_apply_start","mailbox":"%s","max":%s,"skip":%s,"apply":%s,"ts":"%s"}\n' \
    "$MAILBOX" "$MAX" "$SKIP" "$([[ "$requested_shadow" == "1" ]] && printf false || printf true)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  GBRAIN_COLLECTOR_SHADOW=1 GBRAIN_DEFER_MESSAGE_STATE=1 \
    bun "$APP_DIR/collectors/gbrain-phase7-av-m365-graph-batch.js" "$MAILBOX" "$MAX" "$out_dir" "$SKIP" >"$result_file"
  cat "$result_file"

  pending_file="$out_dir/PHASE7_AV_M365_COLLECTOR_STATE_PENDING.json"
  if [[ "$requested_shadow" != "1" ]]; then
    bun -e '
const fs = require("fs");
const path = require("path");
const [resultPath, importDir] = process.argv.slice(1);
const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
for (const file of result.files || []) {
  fs.copyFileSync(file, path.join(importDir, path.basename(file)));
}
' "$result_file" "$import_dir"
    if find "$import_dir" -type f | grep -q .; then
      run_with_timeout "$IMPORT_TIMEOUT_SECONDS" bun /opt/gbrain-src/src/cli.ts import "$import_dir" --no-embed >"$import_log" 2>&1
      cat "$import_log"
      if grep -Eq 'errors=[1-9][0-9]*|, [1-9][0-9]* errors\)|ERROR|Error:' "$import_log"; then
        printf '{"event":"av_m365_apply_import_failed","ok":false,"ts":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
        return 1
      fi
      run_with_timeout "$EMBED_TIMEOUT_SECONDS" bun /opt/gbrain-src/src/cli.ts embed --stale >"$embed_log" 2>&1
      cat "$embed_log"
      if grep -Eiq 'requires .*API_KEY|missing .*API_KEY|ERROR|Error:|failed|failure' "$embed_log"; then
        printf '{"event":"av_m365_apply_embed_failed","ok":false,"ts":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
        return 1
      fi
    else
      local message_count
      message_count="$(bun -e 'const fs=require("fs"); const result=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(result.messageCount || 0));' "$result_file")"
      if [[ "$message_count" != "0" ]]; then
        printf '{"event":"av_m365_apply_no_rendered_files","ok":false,"messageCount":%s,"ts":"%s"}\n' \
          "$message_count" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
        return 1
      fi
      printf '{"event":"av_m365_apply_noop","reason":"no_messages","ts":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      return 0
    fi
    if [[ ! -s "$pending_file" ]]; then
      printf '{"event":"av_m365_apply_missing_pending_state","ok":false,"ts":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >&2
      return 1
    fi
    bun "$APP_DIR/collectors/gbrain-av-m365-collector-state-apply-pending.js" --apply --json "$pending_file"
  fi

  printf '{"event":"av_m365_apply_complete","ok":true,"ts":"%s"}\n' \
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
