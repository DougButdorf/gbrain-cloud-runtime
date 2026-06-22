#!/usr/bin/env bash
set -euo pipefail

export HOME="${GBRAIN_GWS_HOME:-${HOME:-/Users/landokeynes}}"
WORKSPACE="${GBRAIN_WORKSPACE:-/app}"
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

run_with_timeout() {
  local seconds="$1"
  shift
  python3 - "$seconds" "$@" <<'PY'
import os, signal, subprocess, sys
seconds = int(sys.argv[1])
cmd = sys.argv[2:]
proc = subprocess.Popen(cmd, start_new_session=True)
try:
    raise SystemExit(proc.wait(timeout=seconds))
except subprocess.TimeoutExpired:
    print("GBRAIN_GMAIL_FORWARD_TIMEOUT seconds=%s command=%s" % (seconds, cmd[0]), flush=True)
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
    raise SystemExit(124)
PY
}

node "$COLLECTOR_SCRIPT" > "$RESULT_FILE"
IMPORT_DIR="$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('$RESULT_FILE','utf8')); process.stdout.write(r.importDir || '')")"
FILES_COUNT="$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync('$RESULT_FILE','utf8')); process.stdout.write(String((r.files||[]).length))")"

if [[ "$FILES_COUNT" != "0" && "$SHADOW" != "1" ]]; then
  run_with_timeout "$IMPORT_TIMEOUT_SECONDS" env HOME="$HOME" gbrain import "$IMPORT_DIR" --no-embed >/tmp/gbrain-gmail-forward-import.log 2>&1
  run_with_timeout "$EMBED_TIMEOUT_SECONDS" env HOME="$HOME" gbrain embed --stale >/tmp/gbrain-gmail-forward-embed.log 2>&1
fi

if [[ "$SHADOW" != "1" ]]; then
  for pending in "$STATE_DIR"/*.gmail.forward.historyId.pending; do
    [[ -e "$pending" ]] || continue
    dest="${pending%.pending}"
    mv "$pending" "$dest"
  done
fi

node - "$RESULT_FILE" <<'NODE'
const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const accounts = (r.accounts || []).map(a => a.account + ':written=' + a.written).join(' ');
const baselines = (r.baselineOnly || []).map(a => a.account).join(',');
const errors = (r.accountErrors || []).map(e => e.account).join(',');
console.log(('GBRAIN_GMAIL_FORWARD_OK shadow=' + (r.shadow ? '1' : '0') + ' files=' + (r.files || []).length + ' baselined=' + (baselines || 'none') + ' errors=' + (errors || 'none') + ' ' + accounts).trim());
NODE
