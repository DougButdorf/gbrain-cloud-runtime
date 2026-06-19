# GBRAIN Cloud Runtime Day 1

Scope: runtime proof only. This package does not move ingestion, OAuth tokens,
Telegram sessions, Granola auth, or Mac mini crons.

## Recommendation

Use DigitalOcean App Platform for Day 1 if Doug's existing DigitalOcean account
is available. GBRAIN needs an always-on container for `gbrain serve --http`,
HTTPS, simple variables, and low-friction health checks. App Platform matches
that without opening a new vendor account. Railway remains a fallback path.

Avoid a raw Droplet for Day 1 unless App Platform cannot build or run GBRAIN.
A Droplet can be cheaper at the floor, but it adds Docker install, host
patching, reverse proxy/TLS, firewall, restart policy, secret handling, and
manual health monitoring.

## Runtime Contract

The container builds a pinned `gbrain` checkout with Bun, applies the local
model-routing patch in `patches/`, and starts:

```bash
gbrain serve --http --bind 0.0.0.0 --port "$PORT" --public-url "$GBRAIN_PUBLIC_URL"
```

Required variables:

- `GBRAIN_DATABASE_URL`: Supabase/Postgres URL, preferably the transaction
  pooler for app/query traffic.
- `OPENAI_API_KEY` or the key for the embedding/search provider currently
  configured in GBRAIN.
- `DEEPSEEK_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` while Doug's current
  GBRAIN DB config uses DeepSeek for chat/reasoning and Gemini for utility.

Recommended variables:

- `GBRAIN_DIRECT_DATABASE_URL`: Supabase session/direct URL for session-style
  locks, migrations, and later worker paths.
- `GBRAIN_DISABLE_DIRECT_POOL=1`: Day 1 fallback when no direct/session pool URL
  is available. Leave unset when `GBRAIN_DIRECT_DATABASE_URL` is set.
- `GBRAIN_ADMIN_BOOTSTRAP_TOKEN`: stable 32+ char URL-safe admin bootstrap
  token. With this set, startup suppresses token printing.
- `GBRAIN_HTTP_TRUST_PROXY=1`: the host platform terminates HTTPS in front of
  the container.
- `GBRAIN_HTTP_CORS_ORIGIN=https://claude.ai`: add more origins only when a
  browser MCP client needs them.
- `GBRAIN_PUBLIC_URL`: the platform HTTPS URL. For DigitalOcean App Platform,
  use the generated `ondigitalocean.app` URL after the first deploy, or a later
  custom domain.
- `RAILWAY_DOCKERFILE_PATH=infra/gbrain-cloud-runtime/Dockerfile`: extra guard
  for Railway nested Dockerfile detection.

DigitalOcean-specific files:

- `digitalocean-app.yaml`: App Platform spec for a no-cutover proof.
- `Dockerfile.do`: same pinned GBRAIN runtime, but with build context scoped to
  `infra/gbrain-cloud-runtime`.
- `digitalocean.env.example`: DO variable inventory. Do not commit real values.

## Day 1 Commands

Local preflight:

```bash
cd /Users/landokeynes/.openclaw/workspace
chmod +x infra/gbrain-cloud-runtime/entrypoint.sh infra/gbrain-cloud-runtime/smoke-test.sh
chmod +x infra/gbrain-cloud-runtime/preflight.sh
./infra/gbrain-cloud-runtime/preflight.sh
gbrain --version
gbrain doctor --json
gbrain query "GBRAIN cloud runtime migration Day 1" --source-id __all__ --no-expand
```

DigitalOcean App Platform deploy, only after `doctl` is installed/authenticated,
the placeholder values have been replaced in a private local copy, and Doug has
approved the external app/spend boundary:

```bash
cp infra/gbrain-cloud-runtime/digitalocean-app.yaml /tmp/gbrain-cloud-runtime.do.yaml
$EDITOR /tmp/gbrain-cloud-runtime.do.yaml
doctl apps spec validate /tmp/gbrain-cloud-runtime.do.yaml --schema-only
doctl apps create --spec /tmp/gbrain-cloud-runtime.do.yaml
doctl apps list
doctl apps get <app-id>
doctl apps logs <app-id> --type run --follow
```

The committed spec contains placeholder secret values. Before creating the app,
replace those in a private local copy, or create the app from the control panel
and paste real secret values there. After the first deploy creates a default
`ondigitalocean.app` URL, set `GBRAIN_PUBLIC_URL` to that URL and redeploy.

Railway fallback deploy, only after the CLI is authenticated and Doug has
approved the external project/spend boundary:

```bash
export PATH="$HOME/.railway/bin:$PATH"
railway login --browserless
railway init --name gbrain-serve-test
railway link
railway variables set GBRAIN_DATABASE_URL='...' OPENAI_API_KEY='...'
railway variables set DEEPSEEK_API_KEY='...' GOOGLE_GENERATIVE_AI_API_KEY='...'
railway variables set GBRAIN_ADMIN_BOOTSTRAP_TOKEN='...' GBRAIN_REQUIRE_ADMIN_TOKEN=1
railway variables set GBRAIN_DISABLE_DIRECT_POOL=1
railway variables set GBRAIN_HTTP_TRUST_PROXY=1 GBRAIN_HTTP_CORS_ORIGIN='https://claude.ai,https://chatgpt.com,https://chat.openai.com'
railway variables set RAILWAY_DOCKERFILE_PATH=infra/gbrain-cloud-runtime/Dockerfile
railway up --detach
railway logs
railway domain
railway variables set GBRAIN_PUBLIC_URL='https://YOUR-RAILWAY-DOMAIN'
```

Full step-by-step deploy/runbook lives in `DEPLOYMENT.md`.

The repository root has a `.dockerignore` that keeps Railway/Docker build
context limited to `infra/gbrain-cloud-runtime/`. Keep it in place; without it,
deploying from this workspace can upload unrelated private workspace files.

Smoke test:

```bash
curl -fsS "$GBRAIN_PUBLIC_URL/health"
./infra/gbrain-cloud-runtime/smoke-test.sh "$GBRAIN_PUBLIC_URL"
```

Register a read-only OAuth client only after `/health` is green. This writes to
the existing Supabase OAuth tables, so do it once and keep the output private:

```bash
GBRAIN_DATABASE_URL='...' \
  gbrain auth register-client day1-smoke \
  --grant-types client_credentials \
  --scopes read

curl -fsS -X POST "$GBRAIN_PUBLIC_URL/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=$GBRAIN_CLIENT_ID&client_secret=$GBRAIN_CLIENT_SECRET&scope=read"
```

Set the returned access token as `GBRAIN_BEARER_TOKEN` before running the MCP
part of `smoke-test.sh`. For admin dashboard access, use the bootstrap token to
issue a one-time magic link with `POST /admin/api/issue-magic-link`; do not put
the bootstrap token into agent MCP configs.

## Rollback / No Cutover

There is no cutover on Day 1. Leave Mac mini `gbrain serve`, OpenClaw crons,
OAuth/session files, local state, and ingestion untouched. If the cloud proof
fails, delete or stop the test service and keep using the existing Mac mini
runtime.

Success means only:

- container starts;
- `/health` returns 200;
- `gbrain doctor` can reach Supabase from the runtime environment;
- a no-expand query returns plausible results;
- optional read-only MCP `tools/list` works with a registered bearer token.

Non-goals:

- no cloud ingestion workers;
- no Mac mini cron cutover;
- no secret/session migration;
- no admin token in third-party agent configs;
- no cloud shell-job execution.
