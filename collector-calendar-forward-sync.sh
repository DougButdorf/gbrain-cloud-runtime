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
export GBRAIN_CALENDAR_FORWARD_ACCOUNTS="${GBRAIN_CALENDAR_FORWARD_ACCOUNTS:-doug@outbranch.net,doug@boostpricing.com}"
if [[ -n "${GBRAIN_CALENDAR_FORWARD_ACCOUNTS:-}" ]]; then
  IFS=',' read -r -a ACCOUNTS <<<"$GBRAIN_CALENDAR_FORWARD_ACCOUNTS"
else
  ACCOUNTS=(
    "doug@outbranch.net"
    "doug@boostpricing.com"
    "dbutdorf@gmail.com"
  )
fi

mkdir -p "$RUN_ROOT"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

total=0
for account in "${ACCOUNTS[@]}"; do
  account="$(printf '%s' "$account" | xargs)"
  [[ -n "$account" ]] || continue
  slug="$(printf '%s' "$account" | tr -c '[:alnum:]' '-')"
  out_dir="$RUN_ROOT/$slug"
  result_file="$(mktemp /tmp/gbrain-calendar-forward.XXXXXX)"
  GBRAIN_WORKSPACE="$WORKSPACE" GBRAIN_GWS_HOME="$HOME" GBRAIN_CALENDAR_CHECKPOINT_DAYS="$DAYS" bun "$COLLECTOR_SCRIPT" "$account" "$MAX" "$out_dir" >"$result_file"
  count="$(bun -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(r.count || 0));' "$result_file")"
  total=$((total + count))
  if [[ "$count" != "0" && "$SHADOW" != "1" ]]; then
    HOME="$HOME" bun /opt/gbrain-src/src/cli.ts import "$out_dir" --no-embed >/tmp/gbrain-calendar-forward-import.log 2>&1
  fi
  rm -f "$result_file"
done

if [[ "$total" != "0" && "$SHADOW" != "1" ]]; then
  HOME="$HOME" bun /opt/gbrain-src/src/cli.ts embed --stale >/tmp/gbrain-calendar-forward-embed.log 2>&1
fi

echo "GBRAIN_CALENDAR_FORWARD_OK shadow=$SHADOW accounts=${#ACCOUNTS[@]} days=$DAYS events=$total"
