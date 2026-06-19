#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8765}"

if [ -z "${GBRAIN_DATABASE_URL:-}" ] && [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: set GBRAIN_DATABASE_URL for the Supabase/Postgres brain." >&2
  exit 64
fi

if [ "${GBRAIN_REQUIRE_ADMIN_TOKEN:-0}" = "1" ] && [ -z "${GBRAIN_ADMIN_BOOTSTRAP_TOKEN:-}" ]; then
  echo "ERROR: set GBRAIN_ADMIN_BOOTSTRAP_TOKEN or unset GBRAIN_REQUIRE_ADMIN_TOKEN." >&2
  exit 64
fi

PUBLIC_URL_ARG=()
if [ -n "${GBRAIN_PUBLIC_URL:-}" ]; then
  PUBLIC_URL_ARG=(--public-url "${GBRAIN_PUBLIC_URL}")
fi

SUPPRESS_BOOTSTRAP_ARG=()
if [ -n "${GBRAIN_ADMIN_BOOTSTRAP_TOKEN:-}" ]; then
  SUPPRESS_BOOTSTRAP_ARG=(--suppress-bootstrap-token)
fi

exec gbrain serve --http \
  --bind 0.0.0.0 \
  --port "${PORT}" \
  "${PUBLIC_URL_ARG[@]}" \
  "${SUPPRESS_BOOTSTRAP_ARG[@]}"
