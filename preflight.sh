#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/entrypoint.sh" ]; then
  ROOT="${SCRIPT_DIR}"
  RUNTIME_DIR="."
else
  ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
  RUNTIME_DIR="infra/gbrain-cloud-runtime"
fi
cd "${ROOT}"

failures=0

check() {
  local label="$1"
  shift
  if "$@" >/tmp/gbrain-cloud-preflight.out 2>/tmp/gbrain-cloud-preflight.err; then
    printf '[ok] %s\n' "${label}"
  else
    printf '[fail] %s\n' "${label}"
    sed -n '1,6p' /tmp/gbrain-cloud-preflight.err >&2 || true
    failures=$((failures + 1))
  fi
}

warn_if_missing() {
  local label="$1"
  local cmd="$2"
  if command -v "${cmd}" >/dev/null 2>&1; then
    printf '[ok] %s: %s\n' "${label}" "$(command -v "${cmd}")"
  else
    printf '[warn] %s missing\n' "${label}"
  fi
}

check_env_present() {
  local name="$1"
  if [ -n "${!name:-}" ]; then
    printf '[ok] env %s is set\n' "${name}"
  else
    printf '[warn] env %s is not set in this shell\n' "${name}"
  fi
}

check "entrypoint shell syntax" bash -n "${RUNTIME_DIR}/entrypoint.sh"
check "smoke-test shell syntax" bash -n "${RUNTIME_DIR}/smoke-test.sh"
check "Granola collector shell syntax" bash -n "${RUNTIME_DIR}/collector-granola-propagation.sh"
check "AV M365 collector shell syntax" bash -n "${RUNTIME_DIR}/collector-av-m365-shadow.sh"
check "Gmail collector shell syntax" bash -n "${RUNTIME_DIR}/collector-gmail-forward-sync.sh"
check "Calendar collector shell syntax" bash -n "${RUNTIME_DIR}/collector-calendar-forward-sync.sh"
check "cloud GWS helper syntax" bash -c "rm -rf /tmp/gbrain-cloud-gws-account-check && bun build '${RUNTIME_DIR}/bin/gws-account' --target bun --outdir /tmp/gbrain-cloud-gws-account-check"
check "Granola collector JS syntax" node --check "${RUNTIME_DIR}/collectors/gbrain-granola-propagation.js"
check "AV M365 collector JS syntax" node --check "${RUNTIME_DIR}/collectors/gbrain-phase7-av-m365-graph-batch.js"
check "Gmail collector JS syntax" node --check "${RUNTIME_DIR}/collectors/gbrain-gmail-forward-sync.js"
check "Calendar collector JS syntax" node --check "${RUNTIME_DIR}/collectors/gbrain-phase7-calendar-checkpoint.js"
check "Dockerfile pin is exact commit" bash -c "rg -q '^ARG GBRAIN_GIT_REF=[0-9a-f]{40}$' '${RUNTIME_DIR}/Dockerfile'"
check "DigitalOcean Dockerfile pin is exact commit" bash -c "rg -q '^ARG GBRAIN_GIT_REF=[0-9a-f]{40}$' '${RUNTIME_DIR}/Dockerfile.do'"
if [ "${RUNTIME_DIR}" = "." ]; then
  check "Railway Dockerfile path set in railway.toml" bash -c "rg -q 'dockerfilePath = \"Dockerfile\"' railway.toml || rg -q 'dockerfilePath = \"infra/gbrain-cloud-runtime/Dockerfile\"' railway.toml"
  check "Docker context allowlist present" bash -c "test -f .dockerignore || true"
else
  check "Railway Dockerfile path set in railway.toml" bash -c "rg -q 'dockerfilePath = \"infra/gbrain-cloud-runtime/Dockerfile\"' '${RUNTIME_DIR}/railway.toml'"
  check "Docker context allowlist present" bash -c "test -f .dockerignore && rg -q '^\\*\\*$' .dockerignore && rg -q '^!infra/gbrain-cloud-runtime/\\*\\*$' .dockerignore"
fi
check "DigitalOcean app spec uses public runtime git source" bash -c "rg -q 'repo_clone_url: https://github.com/DougButdorf/gbrain-cloud-runtime.git' '${RUNTIME_DIR}/digitalocean-app.yaml'"
check "DigitalOcean app spec uses DO Dockerfile" bash -c "rg -q '^    dockerfile_path: Dockerfile.do$' '${RUNTIME_DIR}/digitalocean-app.yaml'"

warn_if_missing "railway CLI" railway
if command -v railway >/dev/null 2>&1; then
  railway --version | sed 's/^/[info] /'
  if railway whoami >/tmp/gbrain-cloud-preflight.out 2>/tmp/gbrain-cloud-preflight.err; then
    printf '[ok] railway authenticated\n'
  else
    printf '[blocker] railway not authenticated; run: railway login --browserless\n'
  fi
fi

warn_if_missing "docker CLI" docker
warn_if_missing "doctl CLI" doctl
if command -v doctl >/dev/null 2>&1; then
  doctl version | sed 's/^/[info] /' || true
  if [ -n "${DIGITALOCEAN_ACCESS_TOKEN:-}" ] && doctl --access-token "${DIGITALOCEAN_ACCESS_TOKEN}" account get >/tmp/gbrain-cloud-preflight.out 2>/tmp/gbrain-cloud-preflight.err; then
    printf '[ok] doctl token authenticated\n'
  elif doctl account get >/tmp/gbrain-cloud-preflight.out 2>/tmp/gbrain-cloud-preflight.err; then
    printf '[ok] doctl authenticated context\n'
  else
    printf '[blocker] doctl not authenticated; source secrets.env for DIGITALOCEAN_ACCESS_TOKEN or run: doctl auth init\n'
  fi
fi
warn_if_missing "gbrain CLI" gbrain
if command -v gbrain >/dev/null 2>&1; then
  gbrain --version | sed 's/^/[info] /'
fi

check_env_present GBRAIN_DATABASE_URL
check_env_present OPENAI_API_KEY
check_env_present DEEPSEEK_API_KEY
check_env_present GOOGLE_GENERATIVE_AI_API_KEY
check_env_present GBRAIN_ADMIN_BOOTSTRAP_TOKEN

rm -f /tmp/gbrain-cloud-preflight.out /tmp/gbrain-cloud-preflight.err

if [ "${failures}" -gt 0 ]; then
  printf '[result] %s hard preflight check(s) failed\n' "${failures}" >&2
  exit 1
fi

printf '[result] local scaffold preflight passed; external auth/secrets may still be needed\n'
