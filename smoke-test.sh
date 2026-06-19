#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${GBRAIN_BASE_URL:-}}"
if [ -z "${BASE_URL}" ]; then
  echo "usage: $0 https://your-gbrain-service.example" >&2
  exit 64
fi

echo "[smoke] health"
curl -fsS "${BASE_URL%/}/health"
echo

if command -v gbrain >/dev/null 2>&1; then
  echo "[smoke] local doctor against configured DB"
  gbrain doctor --json | head -c 2000
  echo

  echo "[smoke] local no-expand query against configured DB"
  gbrain query "GBRAIN cloud runtime migration Day 1" --source-id __all__ --no-expand | head -80
fi

if [ -n "${GBRAIN_BEARER_TOKEN:-}" ]; then
  echo "[smoke] remote MCP tools/list"
  curl -fsS "${BASE_URL%/}/mcp" \
    -H "Authorization: Bearer ${GBRAIN_BEARER_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 4000
  echo
else
  echo "[smoke] skipped remote MCP call; set GBRAIN_BEARER_TOKEN after registering a client"
fi
