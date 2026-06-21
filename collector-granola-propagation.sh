#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/collector-logs

export GBRAIN_COLLECTOR_SHADOW="${GBRAIN_COLLECTOR_SHADOW:-1}"
export GBRAIN_POSTGRES_MODULE="${GBRAIN_POSTGRES_MODULE:-/opt/gbrain-src/node_modules/postgres}"
export GBRAIN_GRANOLA_PROPAGATION_LIMIT="${GBRAIN_GRANOLA_PROPAGATION_LIMIT:-50}"
export GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_LINKS="${GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_LINKS:-50}"
export GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_TIMELINES="${GBRAIN_GRANOLA_PROPAGATION_MAX_NEW_TIMELINES:-50}"

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

exec bun /app/collectors/gbrain-granola-propagation.js "${args[@]}" "$@" \
  >>/data/collector-logs/granola-propagation.log \
  2>>/data/collector-logs/granola-propagation.err.log
