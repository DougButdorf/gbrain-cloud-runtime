#!/usr/bin/env bash
set -euo pipefail

export HOME="${GBRAIN_GWS_HOME:-${HOME:-/Users/landokeynes}}"
WORKSPACE="${GBRAIN_WORKSPACE:-/app}"
COLLECTOR_SCRIPT="${GBRAIN_CALENDAR_CHECKPOINT_SCRIPT:-$WORKSPACE/collectors/gbrain-phase7-calendar-checkpoint.js}"
ENV_FILE="${GBRAIN_ENV_FILE:-/Users/landokeynes/.gbrain/.env}"
RUN_ROOT="${GBRAIN_CALENDAR_FORWARD_RUN_ROOT:-${GBRAIN_COLLECTOR_OUT_ROOT:-/Users/landokeynes/gbrain-phase7/runtime-controlled/calendar-forward}}"
SHADOW="${GBRAIN_COLLECTOR_SHADOW:-0}"
MAX="${GBRAIN_CALENDAR_FORWARD_MAX:-100}"
DAYS="${GBRAIN_CALENDAR_CHECKPOINT_DAYS:-30}"
ACCOUNTS=(
  "doug@outbranch.net"
  "doug@boostpricing.com"
  "dbutdorf@gmail.com"
)

mkdir -p "$RUN_ROOT"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

total=0
for account in "${ACCOUNTS[@]}"; do
  slug="$(printf '%s' "$account" | tr -c '[:alnum:]' '-')"
  out_dir="$RUN_ROOT/$slug"
  result_file="$(mktemp /tmp/gbrain-calendar-forward.XXXXXX.json)"
  GBRAIN_WORKSPACE="$WORKSPACE" GBRAIN_GWS_HOME="$HOME" GBRAIN_CALENDAR_CHECKPOINT_DAYS="$DAYS" node "$COLLECTOR_SCRIPT" "$account" "$MAX" "$out_dir" >"$result_file"
  count="$(node -e "const fs=require('fs'); const r=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(r.count || 0));" "$result_file")"
  total=$((total + count))
  if [[ "$count" != "0" && "$SHADOW" != "1" ]]; then
    HOME="$HOME" gbrain import "$out_dir" --no-embed >/tmp/gbrain-calendar-forward-import.log 2>&1
  fi
  rm -f "$result_file"
done

if [[ "$total" != "0" && "$SHADOW" != "1" ]]; then
  HOME="$HOME" gbrain embed --stale >/tmp/gbrain-calendar-forward-embed.log 2>&1
fi

echo "GBRAIN_CALENDAR_FORWARD_OK shadow=$SHADOW accounts=${#ACCOUNTS[@]} days=$DAYS events=$total"
