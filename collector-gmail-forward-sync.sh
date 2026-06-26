#!/usr/bin/env bash
set -euo pipefail

export HOME="${GBRAIN_GWS_HOME:-${HOME:-/Users/landokeynes}}"
WORKSPACE="${GBRAIN_WORKSPACE:-/app}"
export GBRAIN_COLLECTOR_STATE_ENABLED="${GBRAIN_COLLECTOR_STATE_ENABLED:-1}"
export GBRAIN_GMAIL_FORWARD_ACCOUNTS="${GBRAIN_GMAIL_FORWARD_ACCOUNTS:-doug-outbranch,lando-outbranch,doug-boostpricing}"
COLLECTOR_SCRIPT="${GBRAIN_GMAIL_FORWARD_SCRIPT:-$WORKSPACE/collectors/gbrain-gmail-forward-sync.js}"
ENV_FILE="${GBRAIN_ENV_FILE:-/Users/landokeynes/.gbrain/.env}"
STATE_DIR="${GBRAIN_GMAIL_FORWARD_STATE_DIR:-${GBRAIN_COLLECTOR_STATE_DIR:-/Users/landokeynes/gbrain-phase7/runtime-controlled/state}}"
SHADOW="${GBRAIN_COLLECTOR_SHADOW:-0}"
RESULT_FILE="$(mktemp /tmp/gbrain-gmail-forward.XXXXXX)"
IMPORT_TIMEOUT_SECONDS="$(printenv GBRAIN_GMAIL_FORWARD_IMPORT_TIMEOUT_SECONDS || true)"
EMBED_TIMEOUT_SECONDS="$(printenv GBRAIN_GMAIL_FORWARD_EMBED_TIMEOUT_SECONDS || true)"
if [[ -z "$IMPORT_TIMEOUT_SECONDS" ]]; then IMPORT_TIMEOUT_SECONDS=180; fi
if [[ -z "$EMBED_TIMEOUT_SECONDS" ]]; then EMBED_TIMEOUT_SECONDS=300; fi

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

export GBRAIN_WORKSPACE="$WORKSPACE"

run_with_timeout() {
  local seconds="$1"
  shift
  timeout "$seconds" "$@"
}

bun "$COLLECTOR_SCRIPT" > "$RESULT_FILE"
IMPORT_DIR="$(bun -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(r.importDir || "")' "$RESULT_FILE")"
FILES_COUNT="$(bun -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String((r.files||[]).length))' "$RESULT_FILE")"

if [[ "$FILES_COUNT" != "0" && "$SHADOW" != "1" ]]; then
  run_with_timeout "$IMPORT_TIMEOUT_SECONDS" env HOME="$HOME" bun /opt/gbrain-src/src/cli.ts import "$IMPORT_DIR" --no-embed >/tmp/gbrain-gmail-forward-import.log 2>&1
  run_with_timeout "$EMBED_TIMEOUT_SECONDS" env HOME="$HOME" bun /opt/gbrain-src/src/cli.ts embed --stale >/tmp/gbrain-gmail-forward-embed.log 2>&1
fi

if [[ "$SHADOW" != "1" ]]; then
  if [[ "${GBRAIN_COLLECTOR_STATE_ENABLED:-0}" == "1" || "${GBRAIN_COLLECTOR_STATE_BACKEND:-}" == "postgres" ]]; then
    pending_file="$IMPORT_DIR/GMAIL_FORWARD_COLLECTOR_STATE_PENDING.json"
    if [[ -f "$pending_file" ]]; then
      bun "$WORKSPACE/collectors/gbrain-gmail-forward-collector-state-apply-pending.js" --apply --json "$pending_file" >/tmp/gbrain-gmail-forward-state.log
    fi
  else
    for pending in "$STATE_DIR"/*.gmail.forward.historyId.pending; do
      [[ -e "$pending" ]] || continue
      dest="${pending%.pending}"
      mv "$pending" "$dest"
    done
  fi
fi

bun -e 'const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const accounts = (r.accounts || []).map(a => a.account + ":written=" + a.written).join(" ");
const baselines = (r.baselineOnly || []).map(a => a.account).join(",");
const errors = (r.accountErrors || []).map(e => e.account).join(",");
console.log(("GBRAIN_GMAIL_FORWARD_OK shadow=" + (r.shadow ? "1" : "0") + " collectorStateSource=" + (r.collectorStateSource || "unknown") + " files=" + (r.files || []).length + " baselined=" + (baselines || "none") + " errors=" + (errors || "none") + " " + accounts).trim());' "$RESULT_FILE"
