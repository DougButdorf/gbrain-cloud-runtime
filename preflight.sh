#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

check "entrypoint shell syntax" bash -n infra/gbrain-cloud-runtime/entrypoint.sh
check "smoke-test shell syntax" bash -n infra/gbrain-cloud-runtime/smoke-test.sh
check "Dockerfile pin is exact commit" bash -c "rg -q '^ARG GBRAIN_GIT_REF=[0-9a-f]{40}$' infra/gbrain-cloud-runtime/Dockerfile"
check "DigitalOcean Dockerfile pin is exact commit" bash -c "rg -q '^ARG GBRAIN_GIT_REF=[0-9a-f]{40}$' infra/gbrain-cloud-runtime/Dockerfile.do"
check "Railway Dockerfile path set in railway.toml" bash -c "rg -q 'dockerfilePath = \"infra/gbrain-cloud-runtime/Dockerfile\"' infra/gbrain-cloud-runtime/railway.toml"
check "DigitalOcean app spec limits source_dir" bash -c "rg -q '^    source_dir: infra/gbrain-cloud-runtime$' infra/gbrain-cloud-runtime/digitalocean-app.yaml"
check "DigitalOcean app spec uses DO Dockerfile" bash -c "rg -q '^    dockerfile_path: infra/gbrain-cloud-runtime/Dockerfile.do$' infra/gbrain-cloud-runtime/digitalocean-app.yaml"
check "Docker context allowlist present" bash -c "test -f .dockerignore && rg -q '^\\*\\*$' .dockerignore && rg -q '^!infra/gbrain-cloud-runtime/\\*\\*$' .dockerignore"

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
  if doctl account get >/tmp/gbrain-cloud-preflight.out 2>/tmp/gbrain-cloud-preflight.err; then
    printf '[ok] doctl authenticated\n'
  else
    printf '[blocker] doctl not authenticated; run: doctl auth init\n'
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
